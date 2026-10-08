# Mailbox — simorgh-platform

Lead ↔ worker coordination, derived from the original engagement mailbox protocol (that project was
de-branded and published 2026-09-21 as `projects/pabetoop-league/`, whose engagement-only
`mailbox/` was stripped — the archived source is `Shaiinarab/Ararat-platform`). The full contract
(worker protocol, NAG channel, file map, Lead duties, report template) is reproduced in
`mailbox/PROTOCOL.md` inside this directory; the summary below covers the project-specific parts.

Ported 2026-09-16 by taking the TASK-039/TASK-042 `fbmail` (portable root resolution, guarded
`check` exit codes, guarded `done`). The binary is the same file; it resolves **this** project from
its own location, so no path edits were needed.

```bash
mailbox/bin/fbmail status        # board + stale claims + open nags
mailbox/bin/fbmail doctor        # is my environment healthy? (--fix to repair)
mailbox/bin/fbmail check <id>    # 0 done · 1 no report yet · 2 report not END-terminated · 3 malformed brief
mailbox/bin/fbmail lock <path> -b TASK-<id>   # before you write
mailbox/bin/fbmail unlock --all
bash mailbox/selftest/header-shape.sh   # 47 assertions
bash mailbox/selftest/root-guard.sh     # 16 assertions
```

`FBMAIL_ROOT` is honoured-or-refused: set it wrongly and `fbmail` exits **1** rather than silently
falling back to the live tree.

## Project rules that always apply

- **Stack is pinned**: TypeScript 7 (`tsgo`, `@typescript/native-preview`), Hono, Cloudflare Workers,
  Durable Objects (SQLite), KV; the Go lanes (`bot/`, `gateway/`, `tools/`, `packages/`) are plain Go
  under `go.work`. Never substitute or downgrade "for safety".
- **`npm install` is required once** — `node_modules/` is not committed. Use the npm mirror
  (`mirror.atlantiscloud.ir/npm`); do not reach for PyPI or a Go proxy:
  `mirror.kargadan.ir` is **banned** as a Go proxy (tampered modules, workspace AGENTS.md).
- **Never** run `git commit` / `git push` / `git rebase`. The Lead integrates and commits.
- Workers touch **only** the files in their brief's Allowlist. Lock them first.

## Status (2026-09-24)

- **Ten briefs, all integrated.** TASK-001…006 landed in the modularization pass; TASK-007…009 are the
  audit lanes (Go gateway tests, quality audit, trust-boundary audit); TASK-010 proves the engine on
  Bun, a third runtime with a third SQL dialect.
- **The SQL port is portable across three dialects.** TASK-010 found `bun:sqlite` satisfies the
  *synchronous* `SqlPort` with **no `phoenix-core` change**, and `createNodePorts` runs unchanged on
  Bun. The only residual differences (`db.query()` vs `prepare()`, `Uint8Array` bindings) live in the
  host adapter. Record the verdict in `ADR-0002` so the next host decision does not re-test it.
- **The Go workspace is committed and green** (`7a54d64 feat(go): land the self-hosted gateway workspace`,
  2026-09-16) — build, vet and test all pass, locally and in CI. An earlier version of this section said
  the Go work was uncommitted; that was wrong. Its role is now decided in `docs/adr/ADR-0001`.
- The `go` job in `.github/workflows/ci.yml` runs the Go gates, and a `security` job runs
  `scripts/security-scan.sh` (secrets scan + `npm audit --omit=dev`).

### Harness reality — read before dispatching a lane

- **`codex exec` is the working headless harness.** `pool exec -f` is *reachable* and exits `0` but
  **ignores the brief** — do not trust it. `freebuff` and the fb containers are interactive TUI only, so
  fb2/fb3 are verification sandboxes, not agent hosts.
- **Never grade a lane on its driver's exit code.** Grade on the artifacts plus `fbmail check`. A lane has
  already exited `0` having delivered one of three files.
- Full detail, including how to detach a lane so it survives and how to size its timeout, is in the
  `simorgh-lanes` skill.
