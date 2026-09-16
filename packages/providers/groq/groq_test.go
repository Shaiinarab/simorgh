package groq

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/shaiinarab/simorgh/packages/providers"
)

func fixtureServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *Adapter) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	a := New("test-key", srv.URL, srv.Client(), 14400)
	return srv, a
}

func TestListModelsLive(t *testing.T) {
	_, a := fixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
			{"id": "llama-3.3-70b-versatile", "owned_by": "meta"},
			{"id": "gemma2-9b-it", "owned_by": "google"},
		}})
	})
	ms, err := a.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].ID != "llama-3.3-70b-versatile" {
		t.Fatalf("models = %+v", ms)
	}
	if !a.Supports("llama-3.3-70b-versatile") || a.Supports("nope") {
		t.Fatal("Supports must track live catalog")
	}
}

func TestListModelsOfflineFallback(t *testing.T) {
	_, a := fixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	})
	ms, err := a.ListModels(context.Background())
	if err == nil {
		t.Fatal("expected warning error")
	}
	if len(ms) == 0 {
		t.Fatal("offline fallback must still serve known models")
	}
	if !a.Supports("llama-3.3-70b-versatile") {
		t.Fatal("known-list fallback must satisfy Supports")
	}
}

func TestChatCompletionNonStream(t *testing.T) {
	_, a := fixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(providers.ChatResponse{
			ID: "chatcmpl-1", Object: "chat.completion", Created: 1, Model: "llama-3.3-70b-versatile",
			Choices: []providers.Choice{{Index: 0, Message: &providers.Message{Role: "assistant", Content: "hi"}, FinishReason: "stop"}},
			Usage:   providers.Usage{PromptTokens: 3, CompletionTokens: 1, TotalTokens: 4},
		})
	})
	resp, err := a.ChatCompletion(context.Background(), providers.ChatRequest{
		Model: "llama-3.3-70b-versatile", Messages: []providers.Message{{Role: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Choices[0].Message.Content != "hi" || resp.Usage.CompletionTokens != 1 {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestStreamSSE(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","delta":{"role":"assistant","content":"He"}}`,
		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","delta":{"content":"llo"}}`,
		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","delta":{},"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}`,
		`data: [DONE]`,
		``,
	}, "\n")
	_, a := fixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sse))
	})
	var got []string
	usage, err := a.ChatCompletionStream(context.Background(),
		providers.ChatRequest{Model: "m", Messages: []providers.Message{{Role: "user", Content: "hi"}}},
		func(ch providers.StreamChunk) error {
			got = append(got, ch.Delta.Content)
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "") != "Hello" {
		t.Fatalf("chunks = %q", got)
	}
	if usage.CompletionTokens != 2 {
		t.Fatalf("usage = %+v, want 2 completion tokens", usage)
	}
}

func Test429SurfacesRetryAfter(t *testing.T) {
	_, a := fixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(429)
		w.Write([]byte(`{"error":{"message":"rate limit"}}`))
	})
	_, err := a.ChatCompletion(context.Background(), providers.ChatRequest{Model: "m"})
	var rl *providers.RateLimitedError
	if !errors.As(err, &rl) {
		t.Fatalf("want RateLimitedError, got %v", err)
	}
	if rl.RetryAfter != 7*time.Second {
		t.Fatalf("retry-after = %v, want 7s", rl.RetryAfter)
	}
}

func TestStreamCancellationPropagates(t *testing.T) {
	release := make(chan struct{})
	_, a := fixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"delta\":{}}\n\n"))
		w.(http.Flusher).Flush()
		<-release // hold open until client cancels
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := a.ChatCompletionStream(ctx, providers.ChatRequest{Model: "m"}, nil)
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancellation must return an error")
		}
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("stream did not cancel in time")
	}
	close(release)
}

func TestHealthProbe(t *testing.T) {
	_, a := fixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
			return
		}
		http.NotFound(w, r)
	})
	if err := a.Health(context.Background()); err != nil {
		t.Fatalf("health = %v", err)
	}
}
