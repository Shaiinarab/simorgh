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

## Status (2026-09-16, before the first fleet wave)

- `mailbox/` is newly created — no briefs yet.
- The repo has **uncommitted** Go work (`bot/`, `gateway/`, `tools/`, `packages/`, `go.work`) — see
  the session note in `memory/2026-09-16.md` at the workspace root.
