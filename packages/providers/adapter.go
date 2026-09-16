// Package providers defines the symmetric provider-adapter interface (NFR4):
// every provider normalizes to one shape, and selection is by health+latency
// at runtime. Groq, OpenRouter, CF Workers AI, and manual OpenAI-compatible
// endpoints all fit this interface; adapters register without gateway changes
// (Story 2.1).
package providers

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// ErrModelUnsupported is returned when an adapter cannot serve a model.
var ErrModelUnsupported = errors.New("model not supported by adapter")

// Model is one entry of the aggregated /v1/models catalog.
type Model struct {
	ID        string `json:"id"`
	Object    string `json:"object"` // always "model"
	OwnedBy   string `json:"owned_by"`
	FreeTier  bool   `json:"simorgh_free_tier"`
	Provider  string `json:"simorgh_provider"`
	ContextMax int64 `json:"simorgh_context_max,omitempty"`
}

// Message is an OpenAI chat message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatRequest is the OpenAI-compatible chat completion request subset (FR1).
type ChatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Stream      bool      `json:"stream,omitempty"`
	Temperature float64   `json:"temperature,omitempty"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
}

// Usage is token accounting reported by the provider.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// Choice is one completion choice.
type Choice struct {
	Index        int      `json:"index"`
	Message      *Message `json:"message,omitempty"`
	FinishReason string   `json:"finish_reason,omitempty"`
}

// ChatResponse is the OpenAI chat.completion shape (FR1/Story 1.2).
type ChatResponse struct {
	ID      string   `json:"id"`
	Object  string   `json:"object"`
	Created int64    `json:"created"`
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
	Usage   Usage    `json:"usage"`
}

// StreamChunk is one SSE token delta (Story 1.3).
type StreamChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"` // chat.completion.chunk
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Delta   Message `json:"delta"`
	Usage   *Usage  `json:"usage,omitempty"`
}

// Adapter is the symmetric provider interface (Story 2.1). Implementations
// must be safe for concurrent use.
type Adapter interface {
	ID() string
	// ListModels returns the models this adapter can serve.
	ListModels(ctx context.Context) ([]Model, error)
	// ChatCompletion performs a non-streaming completion.
	ChatCompletion(ctx context.Context, req ChatRequest) (ChatResponse, error)
	// ChatCompletionStream streams deltas to onChunk; onChunk returning an
	// error cancels the stream (and propagates upstream cancellation). The
	// [DONE] terminator is consumed internally. Returns the provider-reported
	// usage when available so the ledger can record tokens.
	ChatCompletionStream(ctx context.Context, req ChatRequest, onChunk func(StreamChunk) error) (Usage, error)
	// Health reports reachability. Implementations should be cheap.
	Health(ctx context.Context) error
	// Supports reports whether the adapter can serve the model.
	Supports(model string) bool
	// FreeTier is true when the provider is usable with no card (NFR3/D6);
	// enforced by type so core composition cannot depend on paid providers.
	FreeTier() bool
}

// Candidate wraps an adapter with live routing state.
type Candidate struct {
	Adapter
	priority    int
	latencyEMA  float64 // milliseconds
	healthy     bool
	lastCheck   time.Time
	cloudErrors int
}

// Registry holds adapters and routes by health+latency (Story 2.7).
type Registry struct {
	byID map[string]*Candidate
	order []string
}

// NewRegistry creates an empty registry.
func NewRegistry() *Registry {
	return &Registry{byID: map[string]*Candidate{}}
}

// Register adds an adapter; duplicate IDs are rejected (Story 2.1 acceptance).
func (r *Registry) Register(a Adapter, priority int) error {
	if a == nil || a.ID() == "" {
		return fmt.Errorf("register: adapter or ID empty")
	}
	if _, dup := r.byID[a.ID()]; dup {
		return fmt.Errorf("register: duplicate adapter id %q", a.ID())
	}
	r.byID[a.ID()] = &Candidate{Adapter: a, priority: priority, healthy: true}
	r.order = append(r.order, a.ID())
	return nil
}

// ByID returns an adapter by ID.
func (r *Registry) ByID(id string) (Adapter, bool) {
	c, ok := r.byID[id]
	if !ok {
		return nil, false
	}
	return c, true
}

// All returns all registered adapters in registration order.
func (r *Registry) All() []Adapter {
	out := make([]Adapter, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.byID[id])
	}
	return out
}

// RecordResult feeds a routing observation back into the registry: latency in
// milliseconds and nil-or-error outcome. Errors accumulate toward an error
// budget; consecutive failures mark the adapter unhealthy (Story 2.7/FR23).
func (r *Registry) RecordResult(id string, latencyMS float64, err error) {
	c, ok := r.byID[id]
	if !ok {
		return
	}
	if err != nil {
		c.cloudErrors++
		if c.cloudErrors >= 3 {
			c.healthy = false
		}
		return
	}
	c.cloudErrors = 0
	c.healthy = true
	if c.latencyEMA == 0 {
		c.latencyEMA = latencyMS
	} else {
		c.latencyEMA = 0.7*c.latencyEMA + 0.3*latencyMS
	}
	c.lastCheck = time.Now()
}

// MarkHealthy overrides the health flag (heartbeat probes, Story 7.1).
func (r *Registry) MarkHealthy(id string, healthy bool) {
	if c, ok := r.byID[id]; ok {
		c.healthy = healthy
		c.cloudErrors = 0
	}
}

// Select returns adapters supporting the model ordered by the routing policy:
// healthy first, then lower measured latency, then lower priority number
// (Story 2.7). Unhealthy adapters are excluded until they recover.
func (r *Registry) Select(model string) []Adapter {
	var cands []*Candidate
	for _, id := range r.order {
		c := r.byID[id]
		if c.healthy && c.Supports(model) {
			cands = append(cands, c)
		}
	}
	// insertion sort — registry sizes are tiny (tens)
	for i := 1; i < len(cands); i++ {
		for j := i; j > 0 && better(cands[j], cands[j-1]); j-- {
			cands[j], cands[j-1] = cands[j-1], cands[j]
		}
	}
	out := make([]Adapter, len(cands))
	for i, c := range cands {
		out[i] = c
	}
	return out
}

func better(a, b *Candidate) bool {
	if a.healthy != b.healthy {
		return a.healthy
	}
	if a.latencyEMA != b.latencyEMA && (a.latencyEMA > 0 && b.latencyEMA > 0) {
		return a.latencyEMA < b.latencyEMA
	}
	return a.priority < b.priority
}

// Models aggregates the catalog across all adapters. Unreachable adapters are
// skipped and reported in warnings (Story 1.4).
func (r *Registry) Models(ctx context.Context) (models []Model, warnings []string) {
	for _, id := range r.order {
		c := r.byID[id]
		ms, err := c.ListModels(ctx)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s: %v", id, err))
			continue
		}
		models = append(models, ms...)
	}
	return models, warnings
}
