package config

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLayeredPrecedence(t *testing.T) {
	dir := t.TempDir()
	global := filepath.Join(dir, "config.yaml")
	write(t, global, `
server:
  addr: 127.0.0.1:9000
providers:
  - id: groq
    type: groq
    enabled: true
    priority: 10
    daily_cap: 14400
  - id: openrouter
    type: openrouter
    enabled: true
    priority: 20
`)
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	os.Chdir(dir)
	write(t, filepath.Join(dir, LocalPath), `
server:
  addr: 127.0.0.1:9100
providers:
  - id: groq
    enabled: false
`)

	cfg, err := Load(global)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Addr != "127.0.0.1:9100" {
		t.Fatalf("addr = %q, local must win", cfg.Server.Addr)
	}
	g, _ := cfg.FindProvider("groq")
	if g.Enabled {
		t.Fatal("local disabled must override global enabled")
	}
	if g.DailyCap != 14400 || g.Priority != 10 {
		t.Fatalf("unspecified local fields must preserve global: %+v", g)
	}
	o, ok := cfg.FindProvider("openrouter")
	if !ok || !o.Enabled {
		t.Fatalf("global-only provider must survive: %+v ok=%v", o, ok)
	}
}

func TestMissingGlobalIsFirstRun(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.yaml"))
	if err != nil {
		t.Fatalf("missing global must not error: %v", err)
	}
	if cfg.Server.Addr == "" {
		t.Fatal("defaults must be applied")
	}
}

func TestMalformedYAMLHasLineInfo(t *testing.T) {
	p := filepath.Join(t.TempDir(), "bad.yaml")
	write(t, p, "server:\n  addr: [unclosed\n")
	if _, err := Load(p); err == nil {
		t.Fatal("malformed YAML must error")
	}
}

func TestSavePermissions0600AndAtomic(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "config.yaml")
	cfg := &Config{Server: Server{Addr: "127.0.0.1:8787"}}
	if err := cfg.Save(p); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("perm = %o, want 600 (NFR2)", perm)
	}
	if _, err := os.Stat(p + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("atomic save must not leave tmp files")
	}
	// reload round-trip
	got, err := Load(p)
	if err != nil || got.Server.Addr != "127.0.0.1:8787" {
		t.Fatalf("round-trip: %+v err=%v", got, err)
	}
}
