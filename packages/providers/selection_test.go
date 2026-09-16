package providers

import (
	"context"
	"errors"
	"testing"
)

// fakeAdapter is a scripted adapter for selection tests.
type fakeAdapter struct {
	id       string
	models   []string
	latency  func() float64
	failN    int
	probeErr error
}

func (f *fakeAdapter) ID() string             { return f.id }
func (f *fakeAdapter) FreeTier() bool         { return true }
func (f *fakeAdapter) Supports(m string) bool { return contains(f.models, m) }

// ListModels must mirror the models this double declares. It previously returned
// `nil, f.probeErr` unconditionally, so a *healthy* adapter reported an empty
// catalog while Supports() insisted it could serve "m1" — the double contradicted
// itself, and TestModelsAggregatesAndWarns failed on production code that was right.
func (f *fakeAdapter) ListModels(context.Context) ([]Model, error) {
	if f.probeErr != nil {
		return nil, f.probeErr
	}
	out := make([]Model, 0, len(f.models))
	for _, m := range f.models {
		out = append(out, Model{ID: m, Object: "model", OwnedBy: f.id, Provider: f.id, FreeTier: true})
	}
	return out, nil
}
func (f *fakeAdapter) ChatCompletion(context.Context, ChatRequest) (ChatResponse, error) {
	if f.latency != nil {
		f.latency()
	}
	return ChatResponse{ID: "x-" + f.id}, nil
}
func (f *fakeAdapter) ChatCompletionStream(context.Context, ChatRequest, func(StreamChunk) error) (Usage, error) {
	return Usage{}, nil
}
func (f *fakeAdapter) Health(context.Context) error { return f.probeErr }

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func TestDuplicateRegistrationRejected(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(&fakeAdapter{id: "a"}, 10); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(&fakeAdapter{id: "a"}, 20); err == nil {
		t.Fatal("duplicate id must be rejected")
	}
	if err := r.Register(nil, 10); err == nil {
		t.Fatal("nil adapter must be rejected")
	}
}

func TestSelectionPrefersLowerLatency(t *testing.T) {
	r := NewRegistry()
	slow := &fakeAdapter{id: "slow", models: []string{"m"}}
	fast := &fakeAdapter{id: "fast", models: []string{"m"}}
	if err := r.Register(slow, 10); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(fast, 20); err != nil {
		t.Fatal(err)
	}
	// before measurements, priority wins → slow first
	if got := r.Select("m")[0].ID(); got != "slow" {
		t.Fatalf("cold selection = %q, want slow (priority)", got)
	}
	r.RecordResult("slow", 500, nil)
	r.RecordResult("fast", 50, nil)
	if got := r.Select("m")[0].ID(); got != "fast" {
		t.Fatalf("measured selection = %q, want fast (5x latency)", got)
	}
}

func TestSelectionRoutesAroundUnhealthy(t *testing.T) {
	r := NewRegistry()
	bad := &fakeAdapter{id: "bad", models: []string{"m"}}
	good := &fakeAdapter{id: "good", models: []string{"m"}}
	_ = r.Register(bad, 1) // highest priority — would win if healthy
	_ = r.Register(good, 2)

	for i := 0; i < 3; i++ {
		r.RecordResult("bad", 10, errors.New("boom"))
	}
	sel := r.Select("m")
	if len(sel) != 1 || sel[0].ID() != "good" {
		t.Fatalf("breaching provider must be routed around; got %v", ids(sel))
	}
	// recovery rejoins rotation
	r.RecordResult("bad", 10, nil)
	if len(r.Select("m")) != 2 {
		t.Fatal("recovered provider must rejoin selection")
	}
}

func TestSelectOnlySupportingAdapters(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(&fakeAdapter{id: "a", models: []string{"m1"}}, 1)
	_ = r.Register(&fakeAdapter{id: "b", models: []string{"m2"}}, 2)
	if got := r.Select("m2"); len(got) != 1 || got[0].ID() != "b" {
		t.Fatalf("Select(m2) = %v, want only b", ids(r.Select("m2")))
	}
	if n := len(r.Select("missing")); n != 0 {
		t.Fatalf("Select(missing) returned %d adapters, want 0", n)
	}
}

func TestModelsAggregatesAndWarns(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(&fakeAdapter{id: "ok", models: []string{"m1"}}, 1)
	_ = r.Register(&fakeAdapter{id: "down", probeErr: errors.New("conn refused")}, 2)
	models, warnings := r.Models(context.Background())
	if len(models) != 1 || models[0].ID != "m1" {
		t.Fatalf("models = %+v, want [m1]", models)
	}
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want 1 entry", warnings)
	}
}

func ids(as []Adapter) []string {
	out := make([]string, len(as))
	for i, a := range as {
		out[i] = a.ID()
	}
	return out
}
