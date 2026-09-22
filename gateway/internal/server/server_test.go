package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shaiinarab/simorgh/packages/config"
	"github.com/shaiinarab/simorgh/packages/ledger"
	"github.com/shaiinarab/simorgh/packages/providers"
)

// ---------- fake adapter ----------

type fakeAdapter struct {
	mu            sync.Mutex
	id            string
	supportsFor   string
	models        []providers.Model
	chatResp      providers.ChatResponse
	chatErr       error
	streamResp    providers.Usage
	streamErr     error
	chunks        []providers.StreamChunk
	healthErr     error
	listErr       error
	chatCalls     int
	streamCalls   int
	healthCalls   int
	listCalls     int
	streamBlock   chan struct{} // if non-nil, blocks until closed
}

func newFake(id string) *fakeAdapter {
	return &fakeAdapter{id: id}
}

func (f *fakeAdapter) ID() string { return f.id }
func (f *fakeAdapter) Supports(model string) bool {
	if f.supportsFor == "" {
		return true
	}
	return f.supportsFor == model
}
func (f *fakeAdapter) FreeTier() bool { return true }

func (f *fakeAdapter) ListModels(_ context.Context) ([]providers.Model, error) {
	f.mu.Lock()
	f.listCalls++
	f.mu.Unlock()
	return f.models, f.listErr
}

func (f *fakeAdapter) ChatCompletion(_ context.Context, _ providers.ChatRequest) (providers.ChatResponse, error) {
	f.mu.Lock()
	f.chatCalls++
	f.mu.Unlock()
	return f.chatResp, f.chatErr
}

func (f *fakeAdapter) ChatCompletionStream(ctx context.Context, _ providers.ChatRequest, onChunk func(providers.StreamChunk) error) (providers.Usage, error) {
	f.mu.Lock()
	f.streamCalls++
	f.mu.Unlock()
	if f.streamBlock != nil {
		select {
		case <-ctx.Done():
			return f.streamResp, ctx.Err()
		case <-f.streamBlock:
		}
	}
	for _, ch := range f.chunks {
		if err := onChunk(ch); err != nil {
			return f.streamResp, err
		}
	}
	return f.streamResp, f.streamErr
}

func (f *fakeAdapter) Health(_ context.Context) error {
	f.mu.Lock()
	f.healthCalls++
	f.mu.Unlock()
	return f.healthErr
}

// ---------- helpers ----------

func setupServer(t *testing.T, reg *providers.Registry, led *ledger.Ledger, bot Bootstrapper) *Server {
	t.Helper()
	return New(&config.Config{}, reg, led, bot)
}

func reqBody(t *testing.T, body string) *strings.Reader {
	t.Helper()
	return strings.NewReader(body)
}

func checkOpenAIError(t *testing.T, rec *httptest.ResponseRecorder, wantCode int, wantMessagePart string) {
	t.Helper()
	var envelope map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&envelope); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	errMap, ok := envelope["error"].(map[string]any)
	if !ok {
		t.Fatalf("no error envelope in body: %v", envelope)
	}
	if msg, ok := errMap["message"].(string); !ok || (wantMessagePart != "" && !strings.Contains(msg, wantMessagePart)) {
		t.Fatalf("message = %v, want containing %q", errMap["message"], wantMessagePart)
	}
	if code, ok := errMap["code"].(string); !ok || code != errMap["type"] {
		t.Fatalf("code/type mismatch: %v", errMap)
	}
}

// ---------- 1. GET / ----------

func TestRootReturnsServiceAndVersion(t *testing.T) {
	s := setupServer(t, providers.NewRegistry(), ledger.New(), nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body["service"] != "simorgh-gateway" {
		t.Fatalf("service = %v, want simorgh-gateway", body["service"])
	}
	if body["version"] == nil {
		t.Fatal("version field missing")
	}
}

// ---------- 2. Unknown path ----------

func TestUnknownPathReturnsOpenAIError(t *testing.T) {
	s := setupServer(t, providers.NewRegistry(), ledger.New(), nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/unknown/path", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	checkOpenAIError(t, rec, 404, "unknown path")
}

// ---------- 3. Malformed JSON ----------

func TestMalformedJSONReturns400(t *testing.T) {
	s := setupServer(t, providers.NewRegistry(), ledger.New(), nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader("{not json"))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	checkOpenAIError(t, rec, 400, "malformed JSON")
}

// ---------- 4. Missing model ----------

func TestMissingModel400NoAdapterCalled(t *testing.T) {
	a1 := newFake("adapter-1")
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	checkOpenAIError(t, rec, 400, "missing required field: model")
	a1.mu.Lock()
	calls := a1.chatCalls + a1.streamCalls
	a1.mu.Unlock()
	if calls != 0 {
		t.Fatalf("adapter called %d times, want 0", calls)
	}
}

// ---------- 5. Missing messages (BUG) ----------

func TestMissingMessages400NoAdapterCalled(t *testing.T) {
	a1 := newFake("adapter-2")
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","messages":[]}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 (bug: handler falls through without return)", rec.Code)
	}
	checkOpenAIError(t, rec, 400, "missing required field: messages")
	a1.mu.Lock()
	calls := a1.chatCalls + a1.streamCalls
	a1.mu.Unlock()
	if calls != 0 {
		t.Fatalf("adapter called %d times, want 0", calls)
	}
}

// ---------- 6. Model not supported ----------

func TestModelNotFound404(t *testing.T) {
	a1 := newFake("adapter-3")
	a1.supportsFor = "supported-model"
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"unsupported","messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	checkOpenAIError(t, rec, 404, "no enabled provider serves")
}

// ---------- 7. Failover: first fails, second succeeds ----------

func TestFailoverFirstErrorsSecondSucceeds(t *testing.T) {
	a1 := newFake("adapter-a")
	a1.supportsFor = "m"
	a1.chatErr = &providers.APIError{Provider: "a", Status: 500, Body: "boom"}
	a2 := newFake("adapter-b")
	a2.supportsFor = "m"
	a2.chatResp = providers.ChatResponse{
		ID: "resp-b", Object: "chat.completion", Created: 1, Model: "m",
		Choices: []providers.Choice{{Index: 0, Message: &providers.Message{Role: "assistant", Content: "ok"}}},
	}
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(a2, 2); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body providers.ChatResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body.ID != "resp-b" {
		t.Fatalf("response ID = %q, want resp-b (second adapter's body)", body.ID)
	}
}

// ---------- 8. All candidates fail ----------

func TestAllCandidatesFail502(t *testing.T) {
	a1 := newFake("adapter-c1")
	a1.supportsFor = "m"
	a1.chatErr = &providers.APIError{Provider: "c1", Status: 500, Body: "fail1"}
	a2 := newFake("adapter-c2")
	a2.supportsFor = "m"
	a2.chatErr = &providers.APIError{Provider: "c2", Status: 500, Body: "fail2"}
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(a2, 2); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 502 {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	checkOpenAIError(t, rec, 502, "HTTP 500")
}

// ---------- 9. Rate limited → 429 ----------

func TestRateLimited429RetryAfter(t *testing.T) {
	a1 := newFake("adapter-rl")
	a1.supportsFor = "m"
	a1.chatErr = &providers.RateLimitedError{
		APIError:   providers.APIError{Provider: "rl", Status: 429, Body: "rate limited"},
		RetryAfter: 30 * time.Second,
	}
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 429 {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	checkOpenAIError(t, rec, 429, "HTTP 429")
	retryAfter := rec.Header().Get("Retry-After")
	if retryAfter == "" {
		t.Fatal("Retry-After header missing")
	}
	secs, err := time.ParseDuration(retryAfter + "s")
	if err != nil || secs != 30*time.Second {
		t.Fatalf("Retry-After = %q, want 30", retryAfter)
	}
}

// ---------- 10. Success records ledger usage ----------

func TestSuccessRecordsLedgerUsage(t *testing.T) {
	a1 := newFake("adapter-ok")
	a1.supportsFor = "m"
	a1.streamResp = providers.Usage{PromptTokens: 5, CompletionTokens: 3}
	a1.chunks = []providers.StreamChunk{
		{ID: "1", Object: "chat.completion.chunk", Created: 1, Model: "m", Delta: providers.Message{Content: "h"}},
	}
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	snap := led.Snapshot()
	e, ok := snap["adapter-ok"]
	if !ok {
		t.Fatal("no ledger entry for adapter-ok")
	}
	if e.PromptTokens != 5 || e.CompletionTokens != 3 {
		t.Fatalf("tokens = %+v, want prompt=5 completion=3", e)
	}
	if e.Requests != 1 {
		t.Fatalf("requests = %d, want 1", e.Requests)
	}
	if e.Errors != 0 {
		t.Fatalf("errors = %d, want 0", e.Errors)
	}
}

// ---------- 10b. Usage is recorded on the NON-streaming path too ----------
//
// TestSuccessRecordsLedgerUsage above exercises `stream: true`, which is the branch that fills
// the local `u`. The ledger read used to be fed by `u` for BOTH branches, so a non-streaming
// request — the majority — recorded 0 prompt and 0 completion tokens while its own response body
// reported the real numbers. /status derives per-provider token spend from that ledger, so the
// under-count was invisible from the outside and wrong from the inside.

func TestNonStreamingUsageRecorded(t *testing.T) {
	a1 := newFake("adapter-sync")
	a1.supportsFor = "m"
	a1.chatResp = providers.ChatResponse{
		ID:      "c1",
		Object:  "chat.completion",
		Created: 1,
		Model:   "m",
		Choices: []providers.Choice{
			{Index: 0, Message: &providers.Message{Role: "assistant", Content: "hi"}, FinishReason: "stop"},
		},
		Usage: providers.Usage{PromptTokens: 11, CompletionTokens: 7, TotalTokens: 18},
	}
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	// Deliberately NO `"stream":true` — the non-streaming path is where the usage was being lost.
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if a1.chatCalls != 1 {
		t.Fatalf("chatCalls = %d, want 1 (the non-streaming adapter method)", a1.chatCalls)
	}
	e, ok := led.Snapshot()["adapter-sync"]
	if !ok {
		t.Fatal("no ledger entry for adapter-sync")
	}
	// The response body reports 11/7 in `usage`; the ledger must not disagree with the body it
	// just served. Before the fix this read 0/0.
	if e.PromptTokens != 11 || e.CompletionTokens != 7 {
		t.Fatalf(
			"ledger tokens = prompt %d / completion %d, want 11/7 (the response body's own usage)",
			e.PromptTokens, e.CompletionTokens,
		)
	}
	if e.Requests != 1 || e.Errors != 0 {
		t.Fatalf("requests/errors = %d/%d, want 1/0", e.Requests, e.Errors)
	}
}

// ---------- 11. Failure records ledger error ----------

func TestFailureRecordsLedgerError(t *testing.T) {
	a1 := newFake("adapter-fail")
	a1.supportsFor = "m"
	a1.chatErr = &providers.APIError{Provider: "fail", Status: 500, Body: "boom"}
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	snap := led.Snapshot()
	e, ok := snap["adapter-fail"]
	if !ok {
		t.Fatal("no ledger entry for adapter-fail")
	}
	if e.Requests != 1 {
		t.Fatalf("requests = %d, want 1", e.Requests)
	}
	if e.Errors != 1 {
		t.Fatalf("errors = %d, want 1", e.Errors)
	}
}

// ---------- 12. Streaming ----------

func TestStreamReturnsSSE(t *testing.T) {
	a1 := newFake("adapter-stream")
	a1.supportsFor = "m"
	a1.chunks = []providers.StreamChunk{
		{ID: "1", Object: "chat.completion.chunk", Created: 1, Model: "m", Delta: providers.Message{Content: "h"}},
		{ID: "2", Object: "chat.completion.chunk", Created: 1, Model: "m", Delta: providers.Message{Content: "i"}},
	}
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("body missing [DONE]: %s", body)
	}
	// Count data: chunks — should be 2 chunk + 1 [DONE]
	chunks := strings.Count(body, "data: ")
	if chunks != 3 {
		t.Fatalf("data: chunks = %d, want 3 (2 chunks + [DONE])", chunks)
	}
	// Verify each chunk is data: <json>\n\n
	lines := strings.Split(body, "\n")
	dataLineCount := 0
	for i := 0; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "data: ") {
			dataLineCount++
			// Next non-empty line should be empty (the \n\n separator)
			if i+1 < len(lines) && lines[i+1] != "" {
				t.Fatalf("chunk at line %d not followed by empty line: %q", i, lines[i+1])
			}
		}
	}
	if dataLineCount != 3 {
		t.Fatalf("data lines = %d, want 3", dataLineCount)
	}
}

// ---------- 13. Client-gone not a provider error ----------

func TestClientGoneNotProviderError(t *testing.T) {
	a1 := newFake("adapter-cancel")
	a1.supportsFor = "m"
	a1.streamBlock = make(chan struct{}) // blocks until closed
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req = req.WithContext(ctx)
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	s.Handler().ServeHTTP(rec, req)
	snap := led.Snapshot()
	if _, ok := snap["adapter-cancel"]; ok {
		t.Fatal("ledger recorded a request for cancelled adapter — should not have")
	}
	a1.mu.Lock()
	calls := a1.chatCalls + a1.streamCalls
	a1.mu.Unlock()
	if calls != 1 {
		t.Fatalf("adapter stream calls = %d, want 1", calls)
	}
}

// ---------- 14. Headers-sent refuses failover ----------

func TestHeadersSentRefusesFailover(t *testing.T) {
	a1 := newFake("adapter-first")
	a1.supportsFor = "m"
	a1.chunks = []providers.StreamChunk{
		{ID: "1", Object: "chat.completion.chunk", Created: 1, Model: "m", Delta: providers.Message{Content: "x"}},
	}
	a1.streamErr = &providers.APIError{Provider: "first", Status: 500, Body: "after-stream"}
	a2 := newFake("adapter-second")
	a2.supportsFor = "m"
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(a2, 2); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	s.Handler().ServeHTTP(rec, req)
	a2.mu.Lock()
	stream2 := a2.streamCalls
	chat2 := a2.chatCalls
	a2.mu.Unlock()
	if stream2 != 0 || chat2 != 0 {
		t.Fatalf("second adapter called stream=%d chat=%d, want both 0", stream2, chat2)
	}
	a1.mu.Lock()
	stream1 := a1.streamCalls
	a1.mu.Unlock()
	if stream1 != 1 {
		t.Fatalf("first adapter stream calls = %d, want 1", stream1)
	}
}

// ---------- 15. GET /v1/models ----------

func TestModelsAggregatesWithWarnings(t *testing.T) {
	a1 := newFake("adapter-m1")
	a1.models = []providers.Model{{ID: "model-a", Object: "model", OwnedBy: "org", FreeTier: true}}
	a1.listErr = &providers.APIError{Provider: "m1", Status: 500, Body: "down"}
	a2 := newFake("adapter-m2")
	a2.models = []providers.Model{{ID: "model-b", Object: "model", OwnedBy: "org", FreeTier: true}}
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(a2, 2); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/models", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	data, ok := body["data"].([]any)
	if !ok || len(data) == 0 {
		t.Fatalf("data = %v, want non-empty list", body["data"])
	}
	warnings, ok := body["simorgh_warnings"].([]any)
	if !ok {
		t.Fatal("simorgh_warnings missing from response")
	}
	if len(warnings) == 0 {
		t.Fatal("simorgh_warnings empty, want at least one warning")
	}
	warningStr := warnings[0].(string)
	if !strings.Contains(warningStr, "adapter-m1") {
		t.Fatalf("warning = %q, want adapter-m1 in it", warningStr)
	}
}

// ---------- 16. GET /health ----------

func TestHealthOkAndDegraded(t *testing.T) {
	t.Run("all healthy", func(t *testing.T) {
		a1 := newFake("adapter-h1")
		a2 := newFake("adapter-h2")
		reg := providers.NewRegistry()
		if err := reg.Register(a1, 1); err != nil {
			t.Fatal(err)
		}
		if err := reg.Register(a2, 2); err != nil {
			t.Fatal(err)
		}
		led := ledger.New()
		s := setupServer(t, reg, led, nil)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/health", nil)
		s.Handler().ServeHTTP(rec, req)
		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("body not JSON: %v", err)
		}
		if body["status"] != "ok" {
			t.Fatalf("status = %v, want ok", body["status"])
		}
		if _, ok := body["uptime"]; !ok {
			t.Fatal("uptime missing")
		}
	})
	t.Run("one degraded", func(t *testing.T) {
		a1 := newFake("adapter-h-bad")
		a1.healthErr = &providers.APIError{Provider: "h-bad", Status: 500, Body: "unreachable"}
		a2 := newFake("adapter-h-good")
		reg := providers.NewRegistry()
		if err := reg.Register(a1, 1); err != nil {
			t.Fatal(err)
		}
		if err := reg.Register(a2, 2); err != nil {
			t.Fatal(err)
		}
		led := ledger.New()
		s := setupServer(t, reg, led, nil)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/health", nil)
		s.Handler().ServeHTTP(rec, req)
		var body map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("body not JSON: %v", err)
		}
		if body["status"] != "degraded" {
			t.Fatalf("status = %v, want degraded", body["status"])
		}
	})
}

// ---------- 17. GET /status ----------

func TestStatusWithLedger(t *testing.T) {
	a1 := newFake("adapter-s1")
	a1.supportsFor = "m"
	reg := providers.NewRegistry()
	if err := reg.Register(a1, 1); err != nil {
		t.Fatal(err)
	}
	led := ledger.New()
	led.Record("adapter-s1", ledger.Usage{PromptTokens: 10, CompletionTokens: 5}, nil)
	s := setupServer(t, reg, led, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/status", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	providersArr, ok := body["providers"].([]any)
	if !ok || len(providersArr) == 0 {
		t.Fatalf("providers = %v, want non-empty list", body["providers"])
	}
	p := providersArr[0].(map[string]any)
	if p["id"] != "adapter-s1" {
		t.Fatalf("id = %v, want adapter-s1", p["id"])
	}
	if p["requests"] != float64(1) {
		t.Fatalf("requests = %v, want 1", p["requests"])
	}
	if p["prompt_tokens"] != float64(10) {
		t.Fatalf("prompt_tokens = %v, want 10", p["prompt_tokens"])
	}
	if p["completion_tokens"] != float64(5) {
		t.Fatalf("completion_tokens = %v, want 5", p["completion_tokens"])
	}
	if p["errors"] != float64(0) {
		t.Fatalf("errors = %v, want 0", p["errors"])
	}
	if p["remaining_requests"] != nil {
		t.Fatalf("remaining_requests = %v, want nil (no cap set)", p["remaining_requests"])
	}
	if p["daily_cap"] != nil {
		t.Fatalf("daily_cap = %v, want nil (no cap set)", p["daily_cap"])
	}
	// Now set a cap and check they appear
	led.SetDailyCap("adapter-s1", 100)
	s2 := setupServer(t, reg, led, nil)
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", "/status", nil)
	s2.Handler().ServeHTTP(rec2, req2)
	var body2 map[string]any
	if err := json.NewDecoder(rec2.Body).Decode(&body2); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	providersArr2 := body2["providers"].([]any)
	p2 := providersArr2[0].(map[string]any)
	if p2["remaining_requests"] == nil {
		t.Fatal("remaining_requests missing after SetDailyCap")
	}
	if p2["daily_cap"] == nil {
		t.Fatal("daily_cap missing after SetDailyCap")
	}
}

// ---------- 18-20. GET /simorgh/config ----------

func TestSimorghConfigNoBootstrapper404(t *testing.T) {
	s := setupServer(t, providers.NewRegistry(), ledger.New(), nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/simorgh/config", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	checkOpenAIError(t, rec, 404, "no bot channel configured")
}

func TestSimorghConfigAuth(t *testing.T) {
	bot := &fakeBootstrapper{token: "my-token", payload: []byte(`{"ok":true}`)}
	s := setupServer(t, providers.NewRegistry(), ledger.New(), bot)

	// No bearer token
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/simorgh/config", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("no token: status = %d, want 401", rec.Code)
	}

	// Invalid token
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/simorgh/config", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("wrong token: status = %d, want 401", rec.Code)
	}

	// Valid token via IssueBotToken
	s.IssueBotToken("my-token")
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/simorgh/config", nil)
	req.Header.Set("Authorization", "Bearer my-token")
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("valid token: status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("body = %s, want bootstrapper payload", rec.Body.String())
	}

	// After revoke
	s.RevokeBotToken("my-token")
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/simorgh/config", nil)
	req.Header.Set("Authorization", "Bearer my-token")
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("after revoke: status = %d, want 401", rec.Code)
	}
}

// fake bootstrapper
type fakeBootstrapper struct {
	token   string
	payload []byte
}

func (f *fakeBootstrapper) BotConfig(_ string) (string, []byte) {
	return f.token, f.payload
}
