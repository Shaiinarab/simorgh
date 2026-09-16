// Package config loads layered simorgh configuration (FR9/Story 3.1): a global
// file (~/.config/simorgh/config.yaml) with project-local `.simorgh.yaml`
// overrides. Provider keys live as AES-GCM sealed blobs produced by
// packages/crypto; this package never handles plaintext keys.
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// SealedKey is an encrypted provider key: base64(nonce||ciphertext) plus the
// argon2id salt used to derive the master key.
type SealedKey struct {
	Ciphertext string `yaml:"ciphertext" json:"ciphertext"`
	Salt       string `yaml:"salt" json:"salt"` // base64, per-install
}

// Provider is one configured provider entry.
type Provider struct {
	ID        string    `yaml:"id" json:"id"`
	Type      string    `yaml:"type" json:"type"` // groq | openrouter | cerebras | cfworkersai | manual
	Enabled   bool      `yaml:"enabled" json:"enabled"`
	BaseURL   string    `yaml:"base_url,omitempty" json:"base_url,omitempty"`
	Key       *SealedKey `yaml:"key,omitempty" json:"key,omitempty"`
	DailyCap  int       `yaml:"daily_cap,omitempty" json:"daily_cap,omitempty"`
	Priority  int       `yaml:"priority" json:"priority"` // lower = preferred before measurements
}

// Config is the resolved simorgh configuration.
type Config struct {
	Providers []Provider `yaml:"providers" json:"providers"`
	Server    Server     `yaml:"server" json:"server"`
}

// Server holds listener settings.
type Server struct {
	Addr string `yaml:"addr" json:"addr"` // e.g. 127.0.0.1:8787
}

// GlobalPath returns the default global config path under the user's home.
func GlobalPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "simorgh", "config.yaml"), nil
}

// LocalPath is the project-local override file.
const LocalPath = ".simorgh.yaml"

// Load reads global config then applies project-local overrides. A missing
// global file is not an error (first-run); a malformed one is.
func Load(globalPath string) (*Config, error) {
	cfg := &Config{Server: Server{Addr: "127.0.0.1:8787"}}
	if globalPath == "" {
		p, err := GlobalPath()
		if err != nil {
			return nil, err
		}
		globalPath = p
	}
	if raw, err := os.ReadFile(globalPath); err == nil {
		if err := yaml.Unmarshal(raw, cfg); err != nil {
			return nil, fmt.Errorf("%s: %w", globalPath, err)
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("%s: %w", globalPath, err)
	}

	if raw, err := os.ReadFile(LocalPath); err == nil {
		var local Config
		if err := yaml.Unmarshal(raw, &local); err != nil {
			return nil, fmt.Errorf("%s: %w", LocalPath, err)
		}
		cfg.applyLocal(&local)
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("%s: %w", LocalPath, err)
	}
	return cfg, nil
}

// applyLocal overlays a project-local config: providers merge by ID (local
// wins per-field), local server addr wins when set.
func (c *Config) applyLocal(l *Config) {
	if l.Server.Addr != "" {
		c.Server.Addr = l.Server.Addr
	}
	byID := map[string]int{}
	for i, p := range c.Providers {
		byID[p.ID] = i
	}
	for _, lp := range l.Providers {
		if i, ok := byID[lp.ID]; ok {
			if lp.Type != "" {
				c.Providers[i].Type = lp.Type
			}
			if lp.BaseURL != "" {
				c.Providers[i].BaseURL = lp.BaseURL
			}
			if lp.Key != nil {
				c.Providers[i].Key = lp.Key
			}
			if lp.DailyCap != 0 {
				c.Providers[i].DailyCap = lp.DailyCap
			}
			if lp.Priority != 0 {
				c.Providers[i].Priority = lp.Priority
			}
			c.Providers[i].Enabled = lp.Enabled
		} else {
			c.Providers = append(c.Providers, lp)
		}
	}
}

// Save writes the config atomically with 0600 permissions (NFR2) and creates
// parent directories as needed. Returns an error rather than loosening perms.
func (c *Config) Save(path string) error {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}
	raw, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("chmod: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// FindProvider returns the provider entry with the given ID.
func (c *Config) FindProvider(id string) (Provider, bool) {
	for _, p := range c.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}
