// Package ledger tracks per-provider request/token usage and errors — the quota
// ledger backing /status (FR11) and its probe-recalibration hook point (FR13,
// Story 7.6 lands the probes in a later story).
package ledger

import (
	"sync"
	"time"
)

// Usage is one request's token accounting (OpenAI usage subset).
type Usage struct {
	PromptTokens     int
	CompletionTokens int
}

// Entry is the per-provider ledger line, JSON-shaped for /status.
type Entry struct {
	Requests         int64     `json:"requests"`
	PromptTokens     int64     `json:"prompt_tokens"`
	CompletionTokens int64     `json:"completion_tokens"`
	Errors           int64     `json:"errors"`
	LastRequestAt    time.Time `json:"last_request_at,omitempty"`
}

// Ledger is a concurrency-safe per-provider usage ledger.
type Ledger struct {
	mu    sync.RWMutex
	usage map[string]*Entry
	daily map[string]int // providerID -> configured daily request cap (0 = unknown)
	start time.Time
}

// New creates an empty ledger.
func New() *Ledger {
	return &Ledger{
		usage: map[string]*Entry{},
		daily: map[string]int{},
		start: time.Now(),
	}
}

// SetDailyCap records the configured daily request cap used for remaining-quota
// estimates (e.g. Groq ~14400 req/day).
func (l *Ledger) SetDailyCap(providerID string, cap int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.daily[providerID] = cap
}

// Record counts one request for providerID, plus its usage and optional error.
func (l *Ledger) Record(providerID string, u Usage, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.usage[providerID]
	if e == nil {
		e = &Entry{}
		l.usage[providerID] = e
	}
	e.Requests++
	e.PromptTokens += int64(u.PromptTokens)
	e.CompletionTokens += int64(u.CompletionTokens)
	if err != nil {
		e.Errors++
	}
	e.LastRequestAt = time.Now()
}

// Snapshot returns a deep copy of the ledger keyed by provider ID.
func (l *Ledger) Snapshot() map[string]Entry {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make(map[string]Entry, len(l.usage))
	for id, e := range l.usage {
		out[id] = *e
	}
	return out
}

// Remaining estimates remaining daily requests for a provider: cap minus local
// count (0 when the cap is unknown — callers render "unknown").
func (l *Ledger) Remaining(providerID string) (remaining, cap int, known bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	c := l.daily[providerID]
	if c <= 0 {
		return 0, 0, false
	}
	var used int64
	if e := l.usage[providerID]; e != nil {
		used = e.Requests
	}
	r := int64(c) - used
	if r < 0 {
		r = 0
	}
	return int(r), c, true
}

// Uptime is the ledger's (and thus the gateway process's) uptime.
func (l *Ledger) Uptime() time.Duration { return time.Since(l.start) }
