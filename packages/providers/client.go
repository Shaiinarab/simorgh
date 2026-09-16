package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// APIError is a non-2xx provider response.
type APIError struct {
	Provider string
	Status   int
	Body     string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("provider %s: HTTP %d: %s", e.Provider, e.Status, truncate(e.Body, 256))
}

// RateLimitedError is a 429 with an optional retry-after hint (Story 2.3).
type RateLimitedError struct {
	APIError
	RetryAfter time.Duration
}

// APICompatibleClient implements the OpenAI wire protocol shared by Groq,
// OpenRouter, Cerebras, and manual endpoints. BaseURL + APIKey + UserAgent
// parameterize it. Safe for concurrent use.
type APICompatibleClient struct {
	Provider  string
	BaseURL   string // e.g. https://api.groq.com/openai/v1
	APIKey    string
	HTTP      *http.Client
	UserAgent string

	mu    sync.Mutex
	models []Model // cached catalog for manual endpoints (Story 2.6)
	fetched time.Time
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func (c *APICompatibleClient) do(ctx context.Context, method, path string, body io.Reader, hdr map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	return c.httpOrImpl().Do(req)
}

func (c *APICompatibleClient) httpOrImpl() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// ChatNonStream performs a non-streaming chat completion (FR4, stream:false).
func (c *APICompatibleClient) ChatNonStream(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	var out ChatResponse
	buf, err := json.Marshal(req)
	if err != nil {
		return out, fmt.Errorf("marshal: %w", err)
	}
	resp, err := c.do(ctx, http.MethodPost, "/chat/completions", bytes.NewReader(buf), nil)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if err := checkStatus(c.Provider, resp); err != nil {
		return out, err
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, fmt.Errorf("decode %s response: %w", c.Provider, err)
	}
	return out, nil
}

// ChatStream performs an SSE chat completion, invoking onChunk per delta and
// returning provider usage when present (Story 1.3, FR4 stream:true). Client
// disconnect cancels via ctx; onChunk errors abort the stream the same way.
func (c *APICompatibleClient) ChatStream(ctx context.Context, req ChatRequest, onChunk func(StreamChunk) error) (Usage, error) {
	var usage Usage
	req.Stream = true
	buf, err := json.Marshal(req)
	if err != nil {
		return usage, fmt.Errorf("marshal: %w", err)
	}
	resp, err := c.do(ctx, http.MethodPost, "/chat/completions", bytes.NewReader(buf), map[string]string{
		"Accept": "text/event-stream",
	})
	if err != nil {
		return usage, err
	}
	defer resp.Body.Close()
	if err := checkStatus(c.Provider, resp); err != nil {
		return usage, err
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			return usage, nil
		}
		var chunk StreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue // tolerate keepalives / partial JSON
		}
		if chunk.Usage != nil {
			usage = *chunk.Usage
		}
		if onChunk != nil {
			if err := onChunk(chunk); err != nil {
				return usage, err
			}
		}
	}
	if err := sc.Err(); err != nil {
		// context cancellation surfaces as a body read error — normalize it
		if ctx.Err() != nil {
			return usage, ctx.Err()
		}
		return usage, fmt.Errorf("stream %s: %w", c.Provider, err)
	}
	return usage, nil // EOF without [DONE]: treat as complete
}

func checkStatus(provider string, resp *http.Response) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	apiErr := APIError{Provider: provider, Status: resp.StatusCode, Body: string(body)}
	if resp.StatusCode == http.StatusTooManyRequests {
		rl := RateLimitedError{APIError: apiErr}
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			if secs, err := strconv.ParseFloat(ra, 64); err == nil {
				rl.RetryAfter = time.Duration(secs * float64(time.Second))
			}
		}
		return &rl
	}
	return &apiErr
}

// ListOpenAIModels fetches /models and normalizes to the simorgh catalog.
func (c *APICompatibleClient) ListOpenAIModels(ctx context.Context) ([]Model, error) {
	resp, err := c.do(ctx, http.MethodGet, "/models", nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := checkStatus(c.Provider, resp); err != nil {
		return nil, err
	}
	var wire struct {
		Data []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&wire); err != nil {
		return nil, fmt.Errorf("decode models: %w", err)
	}
	out := make([]Model, 0, len(wire.Data))
	for _, m := range wire.Data {
		out = append(out, Model{
			ID:       m.ID,
			Object:   "model",
			OwnedBy:  m.OwnedBy,
			Provider: c.Provider,
			FreeTier: true, // free-tier enforced by type at registration (NFR4)
		})
	}
	return out, nil
}

// ProbeModels fetches and caches the catalog for manual endpoints with TTL
// refresh (Story 2.6: lazy probe + cache invalidation).
func (c *APICompatibleClient) ProbeModels(ctx context.Context, ttl time.Duration) ([]Model, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.models) > 0 && time.Since(c.fetched) < ttl {
		return c.models, nil
	}
	ms, err := c.ListOpenAIModels(ctx)
	if err != nil {
		return nil, err
	}
	c.models = ms
	c.fetched = time.Now()
	return ms, nil
}
