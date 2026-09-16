// Package crypto provides AES-256-GCM secret sealing with argon2id-derived keys.
//
// Port of the hivemind `crypto.ts` harvest (read-only archive at
// _archive/simorgh-merged-2026-08-31/), upgraded per FR8/NFR2 of the simorgh-platform
// epics: argon2id passphrase derivation (the harvest used raw SHA-256, crackable),
// per-install random salt, keys held only in process memory.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
)

const (
	keyLen   = 32 // AES-256
	saltLen  = 16
	nonceLen = 12
	// argon2id parameters tuned for interactive startup (<1s on the host's
	// 2012-era i5-3570), not for adversarial offline-cracking resistance.
	argonTime    = 1
	argonMemory  = 64 * 1024 // KiB = 64 MiB
	argonThreads = 4
)

// NewSalt returns a fresh random per-install salt for key derivation.
func NewSalt() ([]byte, error) {
	s := make([]byte, saltLen)
	if _, err := rand.Read(s); err != nil {
		return nil, fmt.Errorf("salt: %w", err)
	}
	return s, nil
}

// DecodeSalt reverses the base64 encoding applied to salts before they are
// persisted as provider config values (see NewSalt, which returns raw bytes
// that callers base64-encode before storage).
//
// It decodes standard, padded base64 (base64.StdEncoding) — the same variant
// used by Encrypt and Decrypt for payloads, and by the hivemind crypto.ts
// harvest — and rejects any value whose decoded length is not saltLen, so a
// malformed salt can never silently perturb argon2id key derivation.
func DecodeSalt(s string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("decode salt: %w", err)
	}
	if len(raw) != saltLen {
		return nil, fmt.Errorf("salt: expected %d bytes, got %d", saltLen, len(raw))
	}
	return raw, nil
}

// DeriveKey derives a 32-byte AES key from a passphrase and salt using argon2id.
// The key exists only in the caller's memory; nothing is persisted.
func DeriveKey(passphrase string, salt []byte) []byte {
	return argon2.IDKey([]byte(passphrase), salt, argonTime, argonMemory, argonThreads, keyLen)
}

// Encrypt seals plaintext under key with AES-256-GCM, returning
// base64(nonce || ciphertext).
func Encrypt(key, plaintext []byte) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("nonce: %w", err)
	}
	ct := gcm.Seal(nil, nonce, plaintext, nil)
	out := make([]byte, 0, len(nonce)+len(ct))
	out = append(out, nonce...)
	out = append(out, ct...)
	return base64.StdEncoding.EncodeToString(out), nil
}

// Decrypt opens a payload produced by Encrypt. A wrong key or tampered data
// returns an error — never a panic.
func Decrypt(key []byte, payload string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if len(raw) < nonceLen {
		return nil, errors.New("payload too short")
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	pt, err := gcm.Open(nil, raw[:nonceLen], raw[nonceLen:], nil)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	return pt, nil
}

// SecretBox holds a passphrase-derived key in memory and seals/opens strings.
type SecretBox struct{ key []byte }

// NewSecretBox derives the key immediately; the passphrase is not retained.
func NewSecretBox(passphrase string, salt []byte) *SecretBox {
	return &SecretBox{key: DeriveKey(passphrase, salt)}
}

// Seal encrypts a plaintext string (e.g. a provider API key).
func (b *SecretBox) Seal(plain string) (string, error) { return Encrypt(b.key, []byte(plain)) }

// Open decrypts a string sealed by this box.
func (b *SecretBox) Open(sealed string) (string, error) {
	pt, err := Decrypt(b.key, sealed)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != keyLen {
		return nil, fmt.Errorf("key must be %d bytes, got %d", keyLen, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("aes: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}
	return aead, nil
}
