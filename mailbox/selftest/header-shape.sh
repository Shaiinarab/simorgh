#!/usr/bin/env bash
# mailbox/selftest/header-shape.sh — TASK-034/035 regression test for the
# mailbox's two integrity signals: brief headers and report END markers.
#
# Runs the REAL `mailbox/bin/fbmail` against a throwaway FBMAIL_ROOT, so the
# shared INBOX is never touched. Proves:
#   * the authoritative "- Owner:" / "- Status:" list form still parses;
#   * the markdown-bold inline form is tolerated on READ (owner + status);
#   * a brief whose Status cannot be read is reported `malformed` (status exit 2,
#     path + fix shown; board shows it; check names the fix) and is NOT silently
#     rewritten by claim;
#   * a tolerated bold-header brief is claimable — claim writes the list form;
#   * `watch` survives a malformed brief (does not abort the loop).
#   * a report whose last non-empty line is not `TASK-<id>-END` is reported
#     `report-no-END` with the file and the line actually found (TASK-035: it
#     used to be masked as a healthy `claimed-but-reported` row while status
#     still exited 2 with nothing explaining why); board flags it too.
#
# Portable: POSIX bash + coreutils only (no jq/python/node), because the worker
# containers are minimal. Temp dir honours $TMPDIR and is removed on exit.
#
#   bash mailbox/selftest/header-shape.sh

set -u

SELF="$(cd "$(dirname "$0")" && pwd)"
FBMAIL="$SELF/../bin/fbmail"
[ -f "$FBMAIL" ] || { echo "selftest: cannot find $FBMAIL" >&2; exit 1; }
run() { bash "$FBMAIL" "$@"; }

WORK="$(mktemp -d "${FBMAIL_SELFTEST_TMP:-${TMPDIR:-/tmp}}/fbmail-selftest.XXXXXX")" \
  || { echo "selftest: mktemp failed" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT

export FBMAIL_ROOT="$WORK"
export FB_INSTANCE=fb2
export NO_PROXY=127.0.0.1,localhost
mkdir -p "$WORK/mailbox/INBOX" "$WORK/mailbox/OUTBOX"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }

# assert_has <haystack> <needle> <label>
assert_has() {
    case "$1" in
        *"$2"*) ok "$3" ;;
        *) bad "$3"; printf '        expected to contain: %s\n        got: %s\n' "$2" "$1" ;;
    esac
}
# assert_no <haystack> <needle> <label>
assert_no() {
    case "$1" in
        *"$2"*) bad "$3"; printf '        expected NOT to contain: %s\n        got: %s\n' "$2" "$1" ;;
        *) ok "$3" ;;
    esac
}
assert_eq() {
    if [ "$1" = "$2" ]; then ok "$3"; else bad "$3"; printf '        expected [%s], got [%s]\n' "$2" "$1"; fi
}

echo "=== fbmail header-shape selftest (root=$WORK) ==="

# --- fixtures ---------------------------------------------------------------
cat > "$WORK/mailbox/INBOX/TASK-001-list-form.md" <<'BRIEF'
# TASK-001 — authoritative list form

- Owner: fb2
- Status: open
BRIEF

cat > "$WORK/mailbox/INBOX/TASK-002-bold-form.md" <<'BRIEF'
# TASK-002 — tolerated bold inline form

**Owner:** fb2 · **Status:** open · **Depends on:** nothing · **Estimate:** 5 min
BRIEF

cat > "$WORK/mailbox/INBOX/TASK-003-malformed.md" <<'BRIEF'
# TASK-003 — no readable Status (typo'd key)

**Owner:** fb2 · **Statuss:** open · **Depends on:** nothing
BRIEF

cat > "$WORK/mailbox/INBOX/TASK-004-empty-status.md" <<'BRIEF'
# TASK-004 — Status present but empty

- Owner: fb3
- Status:
BRIEF

# Report-marker fixtures (TASK-035): claimed briefs whose reports are not
# terminated by the canonical `TASK-<id>-END`.
cat > "$WORK/mailbox/INBOX/TASK-010-bad-marker.md" <<'BRIEF'
# TASK-010 — claimed, report ends with an older marker shape

- Owner: fb2
- Status: claimed by fb2 2026-01-01T00:00
BRIEF
cat > "$WORK/mailbox/OUTBOX/TASK-010-REPORT.md" <<'REPORT'
# TASK-010 Report

Status: success

TASK-010-WRONG-END
REPORT

cat > "$WORK/mailbox/INBOX/TASK-011-no-marker.md" <<'BRIEF'
# TASK-011 — claimed, report has no marker at all

- Owner: fb2
- Status: claimed by fb2 2026-01-01T00:00
BRIEF
cat > "$WORK/mailbox/OUTBOX/TASK-011-REPORT.md" <<'REPORT'
# TASK-011 Report

Status: success

no marker at all
REPORT

cat > "$WORK/mailbox/INBOX/TASK-012-good.md" <<'BRIEF'
# TASK-012 — claimed, report correctly terminated

- Owner: fb2
- Status: claimed by fb2 2026-01-01T00:00
BRIEF
cat > "$WORK/mailbox/OUTBOX/TASK-012-REPORT.md" <<'REPORT'
# TASK-012 Report

Status: success

TASK-012-END
REPORT

# --- Deliverable 1: both header shapes read --------------------------------
echo "-- read tolerance --"
out="$(run status 2>&1)"; rc=$?
assert_eq "$rc" "2" "status exits 2 while work is open/malformed"
assert_has "$out" "fb2" "bold-form brief exposes a readable Owner"
has_002="$(printf '%s\n' "$out" | grep -E '^TASK-002  +fb2  +-  +open' || true)"
[ -n "$has_002" ] && ok "bold-form brief reads as owner=fb2 status=open" || bad "bold-form brief reads as owner=fb2 status=open"

# --- Deliverable 2: unreadable Status is loud, never `ok` -------------------
echo "-- malformed is loud --"
assert_has "$out" "malformed" "status shows the malformed state"
assert_has "$out" "TASK-003-malformed.md" "status names the malformed brief's path"
assert_has "$out" "fix: add a list-form" "status names the fix"
assert_no "$out" "command not found" "status fix text is not shell-expanded"
assert_has "$out" "TASK-004" "empty '- Status:' counts as malformed"
no_ok="$(printf '%s\n' "$out" | grep -E '^TASK-00[234]  +[a-z0-9-]+  +-  +ok' || true)"
assert_eq "$no_ok" "" "no malformed brief reads as ok"

run board >/dev/null 2>&1; brc=$?
assert_eq "$brc" "0" "board regenerates"
board="$(cat "$WORK/mailbox/BOARD.md" 2>/dev/null)"
assert_has "$board" "malformed" "board shows the malformed state"
assert_has "$board" "TASK-003" "board lists the malformed brief"

chk="$(run check 003 2>&1)"; crc=$?
# TASK-039 gave `check` one distinct code per outcome (F10): a malformed brief is 3,
# while 2 now means "report present but the END marker is missing/not last".
assert_eq "$crc" "3" "check on a malformed brief exits 3"
assert_has "$chk" "MALFORMED" "check says MALFORMED, not 'NO REPORT'"
assert_has "$chk" "- Status:" "check names the line to add"
assert_no "$chk" "command not found" "check's fix text is not shell-expanded"
assert_has "$chk" 'add `- Status: open`' "check shows the exact line to add"

# --- claim: bold tolerated, malformed refused ------------------------------
echo "-- claim --"
c2="$(run claim 002 fb2 2>&1)"; c2rc=$?
assert_eq "$c2rc" "0" "bold-header brief is claimable"
assert_has "$c2" "claimed TASK-002" "claim confirms the bold-header brief"
assert_has "$(cat "$WORK/mailbox/INBOX/TASK-002-bold-form.md")" "- Status: claimed by fb2" "claim wrote the authoritative list Status line"
assert_has "$(cat "$WORK/mailbox/INBOX/TASK-002-bold-form.md")" "**Owner:**" "claim left the tolerated bold header intact"

c3="$(run claim 003 fb2 2>&1)"; c3rc=$?
assert_eq "$c3rc" "2" "malformed brief is refused, not silently claimed"
assert_has "$c3" "MALFORMED" "claim explains the malformation"
assert_no "$c3" "command not found" "claim's fix text is not shell-expanded"
assert_has "$c3" 'add `- Status: open`' "claim shows the exact line to add"
assert_no "$(cat "$WORK/mailbox/INBOX/TASK-003-malformed.md")" "- Status:" "claim did NOT rewrite the malformed brief"

# --- watch survives a malformed brief --------------------------------------
echo "-- watch --"
w="$(run watch --once 2>&1)"; wrc=$?
assert_eq "$wrc" "0" "watch --once exits 0 with a malformed brief present"
assert_has "$w" "NEW TASK-003" "watch reached the malformed brief without aborting"
assert_has "$w" "NEW TASK-010" "watch reached the bad-report task without aborting"

# --- JSON stays valid and carries the malformed flag -----------------------
echo "-- json --"
j="$(run status --json 2>&1)"
case "$j" in
    "{"*"}") ok "status --json is brace-balanced" ;;
    *) bad "status --json is brace-balanced"; printf '        got: %s\n' "$j" ;;
esac
assert_has "$j" '"verdict":"malformed"' "json marks the malformed verdict"
assert_has "$j" '"malformed":true' "json sets the malformed flag"

# --- TASK-035: a report missing TASK-<id>-END is visible, not masked -------
echo "-- report END marker --"
out2="$(run status 2>&1)"; rc2=$?
assert_eq "$rc2" "2" "status exits 2 when a report lacks TASK-<id>-END"

row010="$(printf '%s\n' "$out2" | grep -E '^TASK-010')"
assert_has "$row010" "report-no-END" "bad report on a claimed brief is NOT masked as claimed-but-reported"
row012="$(printf '%s\n' "$out2" | grep -E '^TASK-012')"
assert_has "$row012" "claimed-but-reported" "a good claimed report still reads claimed-but-reported"
assert_no "$row012" "report-no-END" "a good claimed report is not flagged"
assert_no "$(printf '%s\n' "$out2" | grep -E '^TASK-010')" "claimed-but-reported" "the masked verdict is gone for the bad report"

assert_has "$out2" '--- reports not terminated by TASK-<id>-END ---' "status prints the bad-report section header"
assert_has "$out2" 'last non-empty line: [TASK-010-WRONG-END]' "status names the older marker it found"
assert_has "$out2" 'last non-empty line: [no marker at all]' "status names a report with no marker at all"
assert_has "$out2" 'fix: append `TASK-010-END` as the last non-empty line.' "status names the exact fix for an older marker"
assert_no "$out2" "command not found" "bad-report fix text is not shell-expanded"

run board >/dev/null 2>&1
board2="$(cat "$WORK/mailbox/BOARD.md" 2>/dev/null)"
assert_has "$board2" "⛔no-END" "board flags the bad report and survives regeneration"

w2="$(run watch --once 2>&1)"; w2rc=$?
assert_eq "$w2rc" "0" "watch --once exits 0 with bad reports present"
assert_no "$w2" "command not found" "watch emits no shell error on a bad report"

j2="$(run status --json 2>&1)"
assert_has "$j2" '"verdict":"report-no-END"' "json marks the bad-report verdict"
assert_has "$j2" '"bad_reports":2' "json totals count the bad reports"

echo
echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ] || exit 1
echo "HEADER-SHAPE OK"
