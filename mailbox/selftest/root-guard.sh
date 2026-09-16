#!/usr/bin/env bash
# mailbox/selftest/root-guard.sh — TASK-039 regression test for the three ways
# `fbmail` could damage the live mailbox (audit F5, F10, F11).
#
# Runs the REAL `mailbox/bin/fbmail`. Read-only commands run from the project
# dir; every WRITE runs against a throwaway tree, and the assertions that matter
# hash a real live brief before and after to prove it was never touched.
#
# Proves:
#   * a bogus FBMAIL_ROOT is REFUSED (exit 1, message naming the value) instead of
#     silently falling through to the real project — including for a write;
#   * FBMAIL_ROOT unset still resolves, both from inside the project ($PWD) and
#     from an unrelated cwd (the script's own location);
#   * `check` returns four DISTINCT documented codes for its four outcomes;
#   * `done` refuses a brief another instance holds while the claim is fresh,
#     leaves it byte-identical, and still closes unclaimed / stale / self-held work.
#
# Portable: POSIX bash + coreutils only (no jq/python/node) — the worker containers
# are minimal. Temp dir honours $TMPDIR and is removed on exit.
#
#   bash mailbox/selftest/root-guard.sh

set -u

SELF="$(cd "$(dirname "$0")" && pwd)"
FBMAIL="$SELF/../bin/fbmail"
[ -f "$FBMAIL" ] || { echo "selftest: cannot find $FBMAIL" >&2; exit 1; }
REAL_ROOT="$(cd "$SELF/../.." && pwd)"
run() { bash "$FBMAIL" "$@"; }

WORK="$(mktemp -d "${FBMAIL_SELFTEST_TMP:-${TMPDIR:-/tmp}}/fbmail-rootguard.XXXXXX")" \
  || { echo "selftest: mktemp failed" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/mailbox/INBOX" "$WORK/mailbox/OUTBOX" "$WORK/mailbox/NAGS" "$WORK/mailbox/BUS"

export FB_INSTANCE=lead
export NO_PROXY=127.0.0.1,localhost

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — want [$3], got [$2]"; fi; }

# status_of <code> <want> <label> — run a command, compare exit code.
code_of() { "$@" >/dev/null 2>&1; echo $?; }

hash_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

mkbrief() { # mkbrief <id> <status-text>
    printf '# TASK-%s — selftest fixture\n\n- Owner: fb2\n- Status: %s\n' "$1" "$2" \
        > "$WORK/mailbox/INBOX/TASK-$1-fixture.md"
}

echo "== 1. FBMAIL_ROOT is honoured or refused (F5) =="

# The hazard this closes: a typo used to fall through to the hard-coded REAL host
# path, so a write aimed at a scratch tree landed in the live project.
LIVE_BRIEF="$(ls "$REAL_ROOT"/mailbox/INBOX/TASK-*.md 2>/dev/null | head -1)"
if [ -n "$LIVE_BRIEF" ]; then
    before="$(hash_of "$LIVE_BRIEF")"

    out="$(FBMAIL_ROOT=/definitely/not/a/root run status 2>&1)"; code=$?
    chk "bogus FBMAIL_ROOT is refused (exit 1)" "$code" "1"
    case "$out" in
        *"/definitely/not/a/root"*) ok "refusal names the offending value" ;;
        *) bad "refusal must name the offending value: [$out]" ;;
    esac

    # A WRITE through the bogus root must refuse too — this is the assertion that
    # actually matters, and the reason is the live-tree hash below.
    out="$(FBMAIL_ROOT=/definitely/not/a/root run claim 001 fb2 2>&1)"; code=$?
    chk "a write through a bogus root is refused (exit 1)" "$code" "1"

    chk "the live brief is byte-identical afterwards" "$(hash_of "$LIVE_BRIEF")" "$before"
else
    bad "no live brief found to hash — cannot prove the live tree is safe"
fi

# An unset FBMAIL_ROOT must keep working exactly as before — from the project dir
# (ascent) AND from an unrelated cwd (the script's own location, which is what makes
# a copy of this mailbox portable to another project).
out="$(cd "$REAL_ROOT" && run check 038 2>&1)"
case "$out" in
    *"cannot locate project root"*) bad "unset FBMAIL_ROOT failed to resolve from the project dir" ;;
    *) ok "unset FBMAIL_ROOT resolves from \$PWD" ;;
esac
out="$(cd / && run check 038 2>&1)"
case "$out" in
    *"cannot locate project root"*) bad "unset FBMAIL_ROOT failed to resolve from an unrelated cwd" ;;
    *) ok "unset FBMAIL_ROOT resolves by self-location (portable copy)" ;;
esac

echo "== 2. check returns one distinct code per outcome (F10) =="

mkbrief 900 "open"                                          # no report yet
chk "no report yet        -> 1" "$(code_of env FBMAIL_ROOT="$WORK" bash "$FBMAIL" check 900)" "1"

printf 'body line\n\nTASK-900-END\n' > "$WORK/mailbox/OUTBOX/TASK-900-REPORT.md"
chk "clean report         -> 0" "$(code_of env FBMAIL_ROOT="$WORK" bash "$FBMAIL" check 900)" "0"

printf 'body line\n\nTASK-900-END\nappended after completion\n' > "$WORK/mailbox/OUTBOX/TASK-900-REPORT.md"
chk "marker not last      -> 2" "$(code_of env FBMAIL_ROOT="$WORK" bash "$FBMAIL" check 900)" "2"

printf '# TASK-901 — unreadable status\n\n- Owner: fb2\n' > "$WORK/mailbox/INBOX/TASK-901-fixture.md"
chk "malformed brief      -> 3" "$(code_of env FBMAIL_ROOT="$WORK" bash "$FBMAIL" check 901)" "3"

echo "== 3. done refuses to close another instance's fresh claim (F11) =="

FRESH="$(date '+%Y-%m-%dT%H:%M')"
mkbrief 902 "claimed by fb3 $FRESH"
B902="$WORK/mailbox/INBOX/TASK-902-fixture.md"
before="$(hash_of "$B902")"
out="$(FBMAIL_ROOT="$WORK" run done 902 2>&1)"; code=$?
chk "fresh claim by another instance -> refusal (2)" "$code" "2"
case "$out" in
    *fb3*) ok "refusal names the holder" ;;
    *) bad "refusal must name the holder: [$out]" ;;
esac
chk "refused done left the brief byte-identical" "$(hash_of "$B902")" "$before"

mkbrief 903 "open"
chk "unclaimed brief still closes" "$(code_of env FBMAIL_ROOT="$WORK" bash "$FBMAIL" done 903)" "0"

# An orphaned lane must stay recoverable: three real lanes were lost to stale claims.
mkbrief 904 "claimed by fb3 2020-01-01T00:00"
chk "stale claim is treated as orphaned and closes" "$(code_of env FBMAIL_ROOT="$WORK" bash "$FBMAIL" done 904)" "0"

mkbrief 905 "claimed by fb2 $FRESH"
chk "your own hold still closes" \
    "$(code_of env FB_INSTANCE=fb2 FBMAIL_ROOT="$WORK" bash "$FBMAIL" done 905)" "0"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
