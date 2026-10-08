#!/usr/bin/env bash
# ── Does the dashboard's inline client script actually parse? ────────────────────
#
# The Worker suite asserts the page's *content* — that the connector matrix is
# server-rendered, that no secret leaks. It cannot assert that the client script is
# valid JavaScript, because the script is just a string there, and workerd has no
# `eval` to hand it to.
#
# That gap shipped a real bug: a string literal opened with `"` and closed with `'`.
# TypeScript is happy (it sits inside a template literal), the page still renders, and
# every content assertion still passes — while the browser throws a SyntaxError and the
# entire dashboard goes dead, because one malformed token kills the whole IIFE.
#
# So: extract the inline script from the source, substitute the single server-side
# interpolation for a literal, and hand it to `node --check`. Cheap, and it fails on
# exactly the class of mistake the rest of the suite is blind to.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC=src/dashboard.ts
OUT=$(mktemp -t dashboard-client-XXXXXX.js)
trap 'rm -f "$OUT"' EXIT

python3 - "$SRC" "$OUT" <<'PY'
import pathlib, re, sys

src = pathlib.Path(sys.argv[1]).read_text()
start = src.find("return `<!DOCTYPE html>")
if start < 0:
    sys.exit("dashboard-client-check: could not find the page template literal in " + sys.argv[1])

scripts = re.findall(r"<script>(.*?)</script>", src[start:], re.S)
if len(scripts) != 1:
    sys.exit("dashboard-client-check: expected exactly 1 inline <script>, found %d" % len(scripts))

# The one place the server interpolates into the client script. Stood in for a literal
# so the remaining JS is checked verbatim; a silent change to that interpolation would
# show up here as a syntax error rather than passing unexamined.
js = scripts[0].replace("${jsonIsland(connectors)}", "[]")

if len(js) < 1000:
    # `node --check` exits 0 on an empty file, which would make this whole gate a
    # rubber stamp. Refuse to report a pass we cannot justify.
    sys.exit("dashboard-client-check: extracted script is only %d bytes — refusing to pass" % len(js))

pathlib.Path(sys.argv[2]).write_text(js)
print("dashboard-client-check: %d bytes of inline client JS extracted" % len(js))
PY

node --check "$OUT"
echo "dashboard-client-check: PASS — the inline client script parses"
