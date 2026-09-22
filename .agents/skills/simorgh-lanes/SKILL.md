---
name: simorgh-lanes
description: Running parallel agent lanes against this repo through the mailbox protocol — brief and report format, fbmail exit codes, which headless harness actually works on this box, how to detach a lane so it survives, and how to size its timeout. Use when dispatching, integrating or grading parallel agent work, or when a lane produced nothing.
---

# Mailbox lanes

The repo's consensus mechanism: a Lead writes briefs, headless workers execute them in parallel, and the
Lead integrates. `mailbox/README.md` holds the contract; this skill holds the traps.

## The loop

```
mailbox/INBOX/TASK-<id>-<slug>.md    brief   (Lead writes: why, read-first, deliverables, allowlist, acceptance)
mailbox/OUTBOX/TASK-<id>-REPORT.md   report  (worker writes; last non-empty line MUST be TASK-<id>-END)
mailbox/bin/fbmail check <id>         verdict (machine-readable)
```

`TASK-<id>-END` as the final non-empty line is the **completion signal** — not the process exiting.

## Grade on artifacts and `fbmail check`. Never on the driver's exit code.

This has burned this project repeatedly:

- a lane exited **0** after delivering **one of three** files, and reported success
- a lane exited **0** while another lane's half-written file was the reason typecheck failed
- a harness exited **0** having not read the brief at all (see `pool` below)

`fbmail check` exits: `0` done · `1` no report yet · `2` report not END-terminated · `3` malformed
brief. A board reading `reported=N open=0 malformed=0` is the only summary worth trusting.

**Capturing the code wrong is its own trap:** in `./mailbox/bin/fbmail check 002 | head`, `$?` is
`head`'s status, not fbmail's. Capture it directly, or use `${PIPESTATUS[0]}`.

## Which harness actually works (probed 2026-09-22)

| Harness | Verdict |
|---|---|
| **`codex exec`** | **works.** `-C "$ROOT" --dangerously-bypass-approvals-and-sandbox -o <lastmsg> - < prompt`. Reads stdin, honours the sandbox flag, returns real output. |
| `pool exec -f` | **broken for briefs — do not trust it.** It is *reachable* and exits **0**, but on this box it ignored `-f` entirely and answered as though replaying a redacted prior session's summary. **A harness that exits 0 without doing the work is worse than one that fails.** |
| `freebuff`, fb2/fb3 | interactive TUI only — piped input just renders the model picker. Use fb containers as **verification sandboxes** (clean Node version, mounted tree), never as agent hosts. |
| `opencode run` | produced no output, hit the timeout (124) |
| `hermes` | broken: its provider config points at `localhost:20128`, which is a Next.js dev server, not an LLM router |

`codex` reads `NINE_ROUTER_API_KEY` from its config's `env_key`, so it must be **present in the
launching environment** — it inherits through `setsid`, and never goes on a command line (so it cannot
leak into `ps`).

## Detaching a lane so it survives the tool shell

| Mechanism | Result |
|---|---|
| `setsid nohup … &` **from a script file** | **survives** |
| `… & disown` | dies (same process group) |
| `tmux new-session -d` | dies — the tmux **server** dies with the shell |
| `systemd-run --user` | survives, but does **not** inherit env; the bare `--setenv=NAME` inherit form is unsupported on this systemd ("Invalid environment block") |

**Invoke `setsid` from a script file, never from a `for` loop typed into the tool shell** — the loop
form produced zero processes and zero logs.

Have the wrapper append a **boot record** before anything else can fail, so a lane that dies on line one
leaves evidence instead of a silent gap.

## Size the timeout from the brief's own estimate, with headroom

The brief states its estimate; the launcher adds headroom. Do not size it from patience.
`EXIT=124` means **killed**, never "failed to solve" — and re-dispatching costs the full window again,
so a truncated run is a run that wrote nothing and now costs twice.

This was learned the hard way: a brief saying "45–70 min" was dispatched under `timeout 1800`, the agent
spent the whole budget exploring, wrote nothing, and the work had to be redone by hand.

## Writing a brief

- **Interpolate the real output path.** A generated prompt that hardcodes a path silently misdirects
  every worker — `prompt_for()` must use the actual `${OUT}`.
- **Allowlist the files.** Workers touch only what is listed. New-file-only briefs are the safe default:
  they cannot clobber each other or the Lead.
- **Include a trap-finding test.** The highest-value briefs here asked for a test that *should* fail and
  required the worker to report it — that is how the missing-`return` and the preflight false-positive
  were surfaced.
- **Require verbatim acceptance output**, and require the worker to say what it could **not** run.
  Silence about a skipped check reads as a pass.
- **Ask what the worker found but did not fix.** That is often the most valuable content in the report.
- Say what **not** to touch, explicitly. "Do not add the routes" prevents an enthusiastic worker from
  doing a later task's job badly.

## Integrating

1. `fbmail check <id>` for every lane.
2. **Read the report, then verify its claims yourself.** Run the lane's acceptance commands.
3. **Read the delivered code, not just its tests.** Ask what it does that the brief did not ask for —
   that is where the MCP aliases and the vocabulary mismatch came from.
4. Fix what the brief forbade and the lane did anyway; then tell the lane, in the next brief.
5. Release stale locks (`fbmail unlock --all`) after the run.
6. Note that **parallel lanes share one `typecheck`**: a failure during a run may be another lane's
   in-flight file, not yours. Confirm before "fixing" it.

## Worker rule

A lane **never** runs `git commit`, `git push` or `git rebase`. The Lead integrates and commits.
