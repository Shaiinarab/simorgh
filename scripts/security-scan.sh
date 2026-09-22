#!/usr/bin/env bash
# security-scan.sh — the two cheap security gates this repo was missing from CI.
#
#   1. secrets   — high-signal token formats committed into the tree (never prints a value)
#   2. deps      — `npm audit --omit=dev`, i.e. what actually ships
#
# Why a script and not a marketplace action: this must be runnable *before* a commit, on this box,
# with no network, no licence, and no SaaS account — and it has to be the same code CI runs, or CI
# becomes the only place the gate exists. gitleaks/trufflehog are better scanners; neither is
# installed here, and adding one would make the local run impossible. See docs/SECURITY-AUDIT.md.
#
# Read-only. Idempotent. Safe to run twice. Exits non-zero on a finding.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 9

FAIL=0
say() { printf '%s\n' "$*"; }
section() { printf '\n── %s ──────────────────────────────────────────\n' "$1"; }

# ── 1. secrets ────────────────────────────────────────────────────────────────
section "1. secrets in the tree"

# High-signal *formats* only. A generic "password = ..." pattern produces false positives on
# documentation, which is how a scanner gets switched off — so this matches shapes a real provider
# issues and nothing else. Values are redacted: only file:line is printed.
PATTERNS='ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'

HITS=$(grep -rInE "$PATTERNS" \
        --include='*.ts' --include='*.js' --include='*.mjs' --include='*.json' \
        --include='*.go' --include='*.yml' --include='*.yaml' --include='*.toml' \
        --include='*.sh' --include='*.md' --include='*.example' \
        . 2>/dev/null \
      | grep -vE '/(node_modules|dist|\.git)/' \
      | grep -vE 'package-lock\.json|go\.work\.sum' \
      | sed -E 's/(:[0-9]+:).*/\1<redacted>/' || true)

if [ -n "$HITS" ]; then
  say "  ✗ token-shaped literal(s) found:"
  printf '%s\n' "$HITS" | sed 's/^/    /'
  FAIL=1
else
  say "  ✓ no token-shaped literals"
fi

# A committed .env is a leak regardless of what it contains.
ENVFILES=$(ls .env .env.local .env.production .dev.vars .env.*.local 2>/dev/null || true)
if [ -n "$ENVFILES" ]; then
  say "  ✗ environment file(s) present on disk (must be gitignored, never committed):"
  printf '%s\n' "$ENVFILES" | sed 's/^/    /'
  # On disk is a warning, not a failure — .gitignore covers them. Tracked is a failure.
  if git ls-files --error-unmatch $ENVFILES >/dev/null 2>&1; then
    say "    ✗ and at least one is TRACKED BY GIT"
    FAIL=1
  fi
else
  say "  ✓ no .env / .dev.vars on disk"
fi

# ── 2. dependencies ───────────────────────────────────────────────────────────
section "2. shipped dependencies (npm audit --omit=dev)"
if ! AUDIT=$(npm audit --omit=dev 2>&1); then
  say "$AUDIT" | sed 's/^/  /'
  FAIL=1
else
  say "  ✓ $(printf '%s' "$AUDIT" | grep -oE 'found [0-9]+ vulnerabilities' | head -1)"
fi

# ── verdict ───────────────────────────────────────────────────────────────────
section "verdict"
if [ "$FAIL" -eq 0 ]; then
  say "  PASS — no secrets in the tree, no vulnerable shipped dependency."
else
  say "  FAIL — see the ✗ lines above."
fi
exit "$FAIL"
