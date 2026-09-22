// Package server implements the simorgh gateway HTTP server (Epic 1):
// OpenAI-compatible chat completions with SSE (FR1–FR4), aggregated models
// (FR2), /health (FR12), /status quota ledger (FR11), plus the /simorgh
// bootstrap channel for bot peers (FR16/Story 5.1, token auth scaffolded now,
// full semantics land with Story 5.1).
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shaiinarab/simorgh/packages/config"
	"github.com/shaiinarab/simorgh/packages/ledger"
	"github.com/shaiinarab/simorgh/packages/providers"
)

// Bootstrapper is the optional gateway-provided component the /simorgh
// bootstrap channel serves to bot peers (FR16/FR25): the bot's own runtime
// config without provider keys.
type Bootstrapper interface {
	// BotConfig returns (token, JSON payload). Empty token disables the channel.
	BotConfig(botID string) (string, []byte)
}

// Server wires the adapter registry, ledger, and config into the HTTP routes.
type Server struct {
	cfg     *config.Config
	reg     *providers.Registry
	led     *ledger.Ledger
	bot     Bootstrapper
	botAuth map[string]bool // valid bootstrap tokens
	mu      sync.Mutex
	start   time.Time
}

// New wires a Server. The registry must already hold enabled adapters.
func New(cfg *config.Config, reg *providers.Registry, led *ledger.Ledger, bot Bootstrapper) *Server {
	return &Server{cfg: cfg, reg: reg, led: led, bot: bot, botAuth: map[string]bool{}, start: time.Now()}
}

// Handler returns the full route table.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			writeJSON(w, 200, map[string]string{"service": "simorgh-gateway", "version": "0.1.0"})
		} else {
			writeOpenAIError(w, 404, "not_found", "unknown path: "+r.URL.Path)
		}
	})
	mux.HandleFunc("POST /v1/chat/completions", s.handleChatCompletions)
	mux.HandleFunc("GET /v1/models", s.handleModels)
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /status", s.handleStatus)
	mux.HandleFunc("GET /simorgh/config", s.handleBotConfig)
	return mux
}

// ---------- POST /v1/chat/completions (Stories 1.2, 1.3) ----------

func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	var req providers.ChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeOpenAIError(w, 400, "invalid_request_error", "malformed JSON body: "+err.Error())
		return
	}
	if req.Model == "" {
		writeOpenAIError(w, 400, "invalid_request_error", "missing required field: model")
		return
	}
	if len(req.Messages) == 0 {
		writeOpenAIError(w, 400, "invalid_request_error", "missing required field: messages")
		return
	}
	cands := s.reg.Select(req.Model)
	if len(cands) == 0 {
		writeOpenAIError(w, 404, "model_not_found", "no enabled provider serves model "+req.Model)
		return
	}

	// try candidates in routing order; fall through on failure
	var lastErr error
	for _, a := range cands {
		start := time.Now()
		var (
			resp providers.ChatResponse
			u    providers.Usage
			err  error
		)
		if req.Stream {
			u, err = a.ChatCompletionStream(r.Context(), req, func(ch providers.StreamChunk) error {
				return writeSSEChunk(w, ch)
			})
			if err == nil {
				writeSSEDone(w)
			}
		} else {
			resp, err = a.ChatCompletion(r.Context(), req)
			if err == nil {
				// Carry the provider-reported usage into the same variable the streaming branch
				// fills. Without this, `u` stays zero-valued for every non-streaming request and
				// the ledger records 0 tokens while the response body reports the real count — so
				// /status would under-report token spend for exactly the requests that are easiest
				// to account for. Found by TestNonStreamingUsageRecorded.
				u = resp.Usage
				writeJSON(w, 200, resp)
			}
		}
		latency := float64(time.Since(start).Milliseconds())

		if err != nil {
			// client gone (stream) — do not count as provider error, do not failover
			if r.Context().Err() != nil {
				return
			}
			s.led.Record(a.ID(), ledger.Usage{}, err)
			s.reg.RecordResult(a.ID(), latency, err)
			lastErr = err
			if w.Header().Get("Content-Type") == "text/event-stream" {
				// headers already sent — cannot failover on the wire
				return
			}
			continue
		}
		s.led.Record(a.ID(), ledger.Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens}, nil)
		s.reg.RecordResult(a.ID(), latency, nil)
		return
	}
	if lastErr != nil {
		var rl *providers.RateLimitedError
		status := 502
		if ok := asRateLimited(lastErr, &rl); ok {
			status = 429
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", rl.RetryAfter.Seconds()))
		}
		writeOpenAIError(w, status, "provider_error", lastErr.Error())
		return
	}
	writeOpenAIError(w, 502, "provider_error", "no provider succeeded")
}

func asRateLimited(err error, out **providers.RateLimitedError) bool {
	rl, ok := err.(*providers.RateLimitedError)
	if ok {
		*out = rl
	}
	return ok
}

// ---------- GET /v1/models (Story 1.4) ----------

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	models, warnings := s.reg.Models(r.Context())
	if models == nil {
		models = []providers.Model{}
	}
	resp := map[string]any{
		"object": "list",
		"data":   models,
	}
	if len(warnings) > 0 {
		resp["simorgh_warnings"] = warnings
	}
	writeJSON(w, 200, resp)
}

// ---------- GET /health (Story 1.5) ----------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	type provHealth struct {
		ID      string `json:"id"`
		OK      bool   `json:"ok"`
		Error   string `json:"error,omitempty"`
	}
	type health struct {
		Status    string       `json:"status"`
		Uptime    string       `json:"uptime"`
		Providers []provHealth `json:"providers"`
	}
	h := health{Status: "ok", Uptime: s.led.Uptime().Round(time.Second).String()}
	for _, a := range s.reg.All() {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		err := a.Health(ctx)
		cancel()
		ph := provHealth{ID: a.ID(), OK: err == nil}
		if err != nil {
			ph.Error = err.Error()
			h.Status = "degraded"
		}
		h.Providers = append(h.Providers, ph)
	}
	writeJSON(w, 200, h)
}

// ---------- GET /status (Story 1.5, FR11) ----------

type statusProvider struct {
	ID               string    `json:"id"`
	Requests         int64     `json:"requests"`
	PromptTokens     int64     `json:"prompt_tokens"`
	CompletionTokens int64     `json:"completion_tokens"`
	Errors           int64     `json:"errors"`
	Remaining        *int      `json:"remaining_requests,omitempty"`
	DailyCap         *int      `json:"daily_cap,omitempty"`
	LastRequestAt    time.Time `json:"last_request_at,omitempty"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	snap := s.led.Snapshot()
	out := struct {
		Uptime    string           `json:"uptime"`
		Providers []statusProvider `json:"providers"`
	}{Uptime: s.led.Uptime().Round(time.Second).String()}

	ids := make([]string, 0, len(snap))
	for id := range snap {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		e := snap[id]
		p := statusProvider{
			ID: id, Requests: e.Requests,
			PromptTokens: e.PromptTokens, CompletionTokens: e.CompletionTokens,
			Errors: e.Errors, LastRequestAt: e.LastRequestAt,
		}
		if remaining, cap, known := s.led.Remaining(id); known {
			p.Remaining = &remaining
			p.DailyCap = &cap
		}
		out.Providers = append(out.Providers, p)
	}
	writeJSON(w, 200, out)
}

// ---------- GET /simorgh/config (Story 5.1 scaffold) ----------

func (s *Server) handleBotConfig(w http.ResponseWriter, r *http.Request) {
	if s.bot == nil {
		writeOpenAIError(w, 404, "not_found", "no bot channel configured")
		return
	}
	botID := r.URL.Query().Get("bot")
	if botID == "" {
		botID = "default"
	}
	auth := r.Header.Get("Authorization")
	token := strings.TrimPrefix(auth, "Bearer ")
	if token == "" {
		writeOpenAIError(w, 401, "unauthorized", "missing bearer token")
		return
	}
	s.mu.Lock()
	valid := s.botAuth[token]
	s.mu.Unlock()
	if !valid {
		writeOpenAIError(w, 401, "unauthorized", "invalid token")
		return
	}
	_, payload := s.bot.BotConfig(botID)
	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

// IssueBotToken registers a bootstrap token (rotation story lands in 5.1).
func (s *Server) IssueBotToken(tok string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.botAuth[tok] = true
}

// RevokeBotToken invalidates a bootstrap token.
func (s *Server) RevokeBotToken(tok string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.botAuth, tok)
}

// ---------- helpers ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeOpenAIError emits errors in the OpenAI error shape (Story 1.2).
func writeOpenAIError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"message": msg, "type": code, "code": code},
	})
}

func writeSSEChunk(w http.ResponseWriter, ch providers.StreamChunk) error {
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(200)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	buf, err := json.Marshal(ch)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", buf); err != nil {
		return err
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	return nil
}

func writeSSEDone(w http.ResponseWriter) {
	fmt.Fprint(w, "data: [DONE]\n\n")
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}
