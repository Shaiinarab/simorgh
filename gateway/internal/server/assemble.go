package server

import (
	"fmt"

	"github.com/shaiinarab/simorgh/packages/config"
	"github.com/shaiinarab/simorgh/packages/crypto"
	"github.com/shaiinarab/simorgh/packages/ledger"
	"github.com/shaiinarab/simorgh/packages/providers"
	groq "github.com/shaiinarab/simorgh/packages/providers/groq"
)

// Assemble builds the provider registry from config. Secrets are decrypted
// here into memory only (FR8); nothing plaintext touches disk or logs.
func Assemble(cfg *config.Config, box *crypto.SecretBox, led *ledger.Ledger) (*providers.Registry, error) {
	reg := providers.NewRegistry()
	for _, p := range cfg.Providers {
		if !p.Enabled {
			continue
		}
		var key string
		if p.Key != nil && box != nil {
			plain, err := box.Open(p.Key.Ciphertext)
			if err != nil {
				return nil, fmt.Errorf("provider %s: key decryption failed (wrong passphrase?): %w", p.ID, err)
			}
			key = plain
		}
		switch p.Type {
		case "groq":
			a := groq.New(key, p.BaseURL, nil, p.DailyCap)
			if err := reg.Register(a, p.Priority); err != nil {
				return nil, err
			}
			if p.DailyCap > 0 {
				led.SetDailyCap(p.ID, p.DailyCap)
			}
		case "openrouter", "cerebras", "cfworkersai", "manual":
			// dedicated adapters land with Stories 2.2/2.4/2.5/2.6 — unknown
			// types are skipped with a warning rather than failing startup.
			fmt.Printf("simorgh: provider %s (type %s) reserved for a later story; skipped\n", p.ID, p.Type)
		default:
			return nil, fmt.Errorf("provider %s: unknown type %q", p.ID, p.Type)
		}
	}
	return reg, nil
}
