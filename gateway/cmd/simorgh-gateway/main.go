// Command simorgh-gateway serves the personal AI gateway locally (S1).
//
//	Usage: simorgh-gateway [-config <path>]
//
// The master key is derived from the passphrase at start and held only in
// memory (FR8). SIGINT/SIGTERM shut down gracefully.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/shaiinarab/simorgh/gateway/internal/server"
	"github.com/shaiinarab/simorgh/packages/config"
	"github.com/shaiinarab/simorgh/packages/crypto"
	"github.com/shaiinarab/simorgh/packages/ledger"
)

func main() {
	configPath := flag.String("config", "", "global config path (default ~/.config/simorgh/config.yaml)")
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("simorgh: ")

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	// Count sealed keys — passphrase is required only when secrets exist.
	needPass := false
	for _, p := range cfg.Providers {
		if p.Enabled && p.Key != nil {
			needPass = true
			break
		}
	}

	var box *crypto.SecretBox
	if needPass {
		pass := os.Getenv("SIMORGH_PASSPHRASE")
		if pass == "" {
			fmt.Fprintf(os.Stderr, "simorgh: passphrase required (set SIMORGH_PASSPHRASE; interactive prompt lands with the wizard polish)\n")
			os.Exit(1)
		}
		// all sealed keys share the per-install salt; take it from the first
		saltB64 := ""
		for _, p := range cfg.Providers {
			if p.Key != nil {
				saltB64 = p.Key.Salt
				break
			}
		}
		salt, err := crypto.DecodeSalt(saltB64)
		if err != nil {
			log.Fatalf("salt: %v", err)
		}
		box = crypto.NewSecretBox(pass, salt)
	}

	led := ledger.New()
	reg, err := server.Assemble(cfg, box, led)
	if err != nil {
		log.Fatalf("assemble: %v", err)
	}

	srv := server.New(cfg, reg, led, nil)
	addr := cfg.Server.Addr
	if addr == "" {
		addr = "127.0.0.1:8787"
	}
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("gateway listening on http://%s (health: /health, quota: /status)", addr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down…")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	httpSrv.Shutdown(ctx)
}
