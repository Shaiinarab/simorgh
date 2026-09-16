package crypto

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	salt, err := NewSalt()
	if err != nil {
		t.Fatal(err)
	}
	box := NewSecretBox("correct horse battery staple", salt)
	sealed, err := box.Seal("sk-groq-abcdef123")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sealed, "sk-groq") {
		t.Fatal("plaintext leaked into ciphertext")
	}
	got, err := box.Open(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if got != "sk-groq-abcdef123" {
		t.Fatalf("round-trip mismatch: got %q", got)
	}
}

func TestWrongPassphraseFailsNotPanics(t *testing.T) {
	salt, _ := NewSalt()
	box := NewSecretBox("right", salt)
	sealed, err := box.Seal("secret")
	if err != nil {
		t.Fatal(err)
	}
	other := NewSecretBox("wrong", salt)
	if _, err := other.Open(sealed); err == nil {
		t.Fatal("wrong key must return an error")
	}
}

func TestTamperedPayloadFails(t *testing.T) {
	salt, _ := NewSalt()
	box := NewSecretBox("p", salt)
	sealed, _ := box.Seal("secret")
	mid := len(sealed) / 2
	replacement := byte('A')
	if sealed[mid] == 'A' {
		replacement = 'B'
	}
	tampered := sealed[:mid] + string(replacement) + sealed[mid+1:]
	if _, err := box.Open(tampered); err == nil {
		t.Fatal("tampered payload must fail to open")
	}
}

func TestSaltUniqueness(t *testing.T) {
	a, _ := NewSalt()
	b, _ := NewSalt()
	if bytes.Equal(a, b) {
		t.Fatal("two salts must differ")
	}
	if len(a) != saltLen {
		t.Fatalf("salt length = %d, want %d", len(a), saltLen)
	}
}

func TestDerivedKeyStableForSameInputs(t *testing.T) {
	salt, _ := NewSalt()
	k1 := DeriveKey("pass", salt)
	k2 := DeriveKey("pass", salt)
	if !bytes.Equal(k1, k2) {
		t.Fatal("same passphrase+salt must derive the same key")
	}
	k3 := DeriveKey("pass2", salt)
	if bytes.Equal(k1, k3) {
		t.Fatal("different passphrases must derive different keys")
	}
}

func TestDecodeSalt(t *testing.T) {
	salt, err := NewSalt()
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(salt)
	got, err := DecodeSalt(encoded)
	if err != nil {
		t.Fatalf("DecodeSalt(%q) error: %v", encoded, err)
	}
	if len(got) != saltLen {
		t.Fatalf("decoded salt length = %d, want %d", len(got), saltLen)
	}
	if !bytes.Equal(got, salt) {
		t.Fatalf("round-trip mismatch: got %x, want %x", got, salt)
	}
}

func TestDecodeSaltEmpty(t *testing.T) {
	if _, err := DecodeSalt(""); err == nil {
		t.Fatal(`DecodeSalt("") must return an error`)
	}
}

func TestDecodeSaltInvalidBase64(t *testing.T) {
	if _, err := DecodeSalt("!!!not-base64!!!"); err == nil {
		t.Fatal("DecodeSalt must reject invalid base64 characters")
	}
}

func TestDecodeSaltWrongPadding(t *testing.T) {
	// "aGk" decodes to "hi" under RawStdEncoding but is invalid under padded
	// StdEncoding, so it must be rejected as improperly-padded input.
	if _, err := DecodeSalt("aGk"); err == nil {
		t.Fatal("DecodeSalt must reject improperly-padded base64")
	}
}
