package ledger

import (
	"errors"
	"sync"
	"testing"
)

func TestRecordDelta(t *testing.T) {
	l := New()
	l.Record("groq", Usage{PromptTokens: 10, CompletionTokens: 20}, nil)
	l.Record("groq", Usage{PromptTokens: 5, CompletionTokens: 7}, nil)
	l.Record("groq", Usage{}, errors.New("boom"))

	e := l.Snapshot()["groq"]
	if e.Requests != 3 {
		t.Fatalf("Requests = %d, want 3", e.Requests)
	}
	if e.PromptTokens != 15 || e.CompletionTokens != 27 {
		t.Fatalf("tokens = %d/%d, want 15/27", e.PromptTokens, e.CompletionTokens)
	}
	if e.Errors != 1 {
		t.Fatalf("Errors = %d, want 1", e.Errors)
	}
	if e.LastRequestAt.IsZero() {
		t.Fatal("LastRequestAt must be set")
	}
}

func TestConcurrentExactness(t *testing.T) {
	l := New()
	const goroutines, per = 50, 100
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < per; j++ {
				l.Record("x", Usage{PromptTokens: 1}, nil)
			}
		}()
	}
	wg.Wait()
	e := l.Snapshot()["x"]
	if e.Requests != goroutines*per {
		t.Fatalf("Requests = %d, want %d", e.Requests, goroutines*per)
	}
}

func TestRemainingQuota(t *testing.T) {
	l := New()
	if _, _, known := l.Remaining("groq"); known {
		t.Fatal("unknown cap must not claim known quota")
	}
	l.SetDailyCap("groq", 100)
	l.Record("groq", Usage{}, nil)
	l.Record("groq", Usage{}, nil)
	r, c, known := l.Remaining("groq")
	if !known || c != 100 || r != 98 {
		t.Fatalf("remaining = %d/%d known=%v, want 98/100 true", r, c, known)
	}
	for i := 0; i < 200; i++ {
		l.Record("groq", Usage{}, nil)
	}
	if r, _, _ := l.Remaining("groq"); r != 0 {
		t.Fatalf("over-quota remaining = %d, want clamped 0", r)
	}
}
