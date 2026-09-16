// Package groq implements the Groq provider adapter — the S1 launch adapter
// (resolved decision #1: free tier ~30 req/min, ~14,400 req/day, no card).
package groq

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/shaiinarab/simorgh/packages/providers"
)

// DefaultBaseURL is Groq's OpenAI-compatible endpoint.
const DefaultBaseURL = "https://api.groq.com/openai/v1"

// Adapter serves Groq via the shared OpenAI-compatible client.
type Adapter struct {
	client   *providers.APICompatibleClient
	models   []providers.Model
	known    []string // offline model list used when /models is unreachable
	priority int
}

// New builds a Groq adapter. knownModels seeds Supports() offline; DailyCap is
// recorded on the ledger for remaining-quota estimates.
func New(apiKey, baseURL string, httpClient *http.Client, dailyCap int) *Adapter {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	a := &Adapter{
		client: &providers.APICompatibleClient{
			Provider:  "groq",
			BaseURL:   baseURL,
			APIKey:    apiKey,
			HTTP:      httpClient,
			UserAgent: "simorgh-gateway/0.1",
		},
		known: []string{
			"llama-3.3-70b-versatile",
			"llama-3.1-8b-instant",
			"openai/gpt-oss-120b",
			"openai/gpt-oss-20b",
			"meta-llama/llama-4-scout-17b-16e-instruct",
			"meta-llama/llama-4-maverick-17b-128e-instruct",
			"qwen/qwen3-32b",
			"moonshotai/kimi-k2-instruct",
		},
	}
	_ = dailyCap // ledger wiring happens at the gateway layer (Epic 2/7)
	return a
}

// ID implements Adapter.
func (a *Adapter) ID() string { return "groq" }

// FreeTier implements Adapter (D6: no card, no KYC).
func (a *Adapter) FreeTier() bool { return true }

// Supports reports whether the adapter can serve the model. Uses the live
// catalog when available, else the offline known list.
func (a *Adapter) Supports(model string) bool {
	for _, m := range a.models {
		if m.ID == model {
			return true
		}
	}
	for _, k := range a.known {
		if strings.EqualFold(k, model) {
			return true
		}
	}
	return false
}

// ListModels fetches the live catalog; on failure falls back to the offline
// known list so the gateway stays usable offline (Story 1.4 degraded mode).
func (a *Adapter) ListModels(ctx context.Context) ([]providers.Model, error) {
	ms, err := a.client.ListOpenAIModels(ctx)
	if err != nil {
		out := make([]providers.Model, len(a.known))
		for i, id := range a.known {
			out[i] = providers.Model{ID: id, Object: "model", OwnedBy: "groq", Provider: "groq", FreeTier: true}
		}
		a.models = out
		return out, err // caller records warning; models still served
	}
	a.models = ms
	return ms, nil
}

// ChatCompletion implements Adapter (non-streaming).
func (a *Adapter) ChatCompletion(ctx context.Context, req providers.ChatRequest) (providers.ChatResponse, error) {
	return a.client.ChatNonStream(ctx, req)
}

// ChatCompletionStream implements Adapter (SSE, Story 1.3).
func (a *Adapter) ChatCompletionStream(ctx context.Context, req providers.ChatRequest, onChunk func(providers.StreamChunk) error) (providers.Usage, error) {
	return a.client.ChatStream(ctx, req, onChunk)
}

// Health probes reachability cheaply (models endpoint, 5s timeout).
func (a *Adapter) Health(ctx context.Context) error {
	hctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := a.client.ListOpenAIModels(hctx)
	return err
}
