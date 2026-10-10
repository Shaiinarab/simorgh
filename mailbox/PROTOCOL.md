# Mailbox protocol — the contract

> Recovered 2026-09-21 from the original engagement mailbox (that project was de-branded and
> published as `projects/pabetoop-league/`; its engagement-only `mailbox/` was stripped, and the
> verbatim original — including the engagement-specific rules — is archived at
> `_archive/shiraz-league-engagement-mailbox-2026-09-21/`). **Both paths are workspace-relative** —
> they resolve from the workspace root (`~/personal/projects/`), not from this repository. This file
> keeps the **generic**
> contract and drops the project-specific rule list, which lives in `mailbox/README.md`.

The Lead agent (main session, host) and the fleet workers (podman instances) coordinate **only
through files in this directory**. There is no interactive control channel; every request, claim,
report and answer is a file. Anything not written to disk did not happen.

---

## 0. The tool

`mailbox/bin/fbmail` — portable bash, no `jq`/`python`/`node` needed, works identically on the host
and inside containers because it resolves its own project root from `BASH_SOURCE`.

```bash
mailbox/bin/fbmail status              # task board + stale claims + open nags
mailbox/bin/fbmail check <id>          # is TASK-<id>'s report present and END-terminated?
mailbox/bin/fbmail doctor              # is my environment healthy? (workers: run at startup)
mailbox/bin/fbmail doctor --fix        # repair it (toolchain, proxies, dirs)
mailbox/bin/fbmail board               # regenerate BOARD.md
mailbox/bin/fbmail nag                 # read open nags (Lead triages)
mailbox/bin/fbmail lock FILE... [-b TASK-XXX]  # advisory: claim files before writing them
mailbox/bin/fbmail unlock FILE... | --all      # release; --expired clears stale locks only
mailbox/bin/fbmail send <inst> "text"  # drop a note the other side will see
mailbox/bin/fbmail watch --interval 60 # poll INBOX, auto-claim own briefs, raise ALERTs
```

**Exit codes.** `check` is one code per outcome — `0` done · `1` no report yet · `2` report not
END-terminated · `3` malformed brief. `status` exits **2** when something needs attention (open
tasks, stale claims, missing END markers), which makes it usable as a gate.

`FBMAIL_ROOT` is honoured-or-refused: set it to a bogus path and `fbmail` exits **1** rather than
silently falling back to the live tree.

---

## 1. Worker protocol (read fully before touching anything)

1. **Orient.** `mailbox/bin/fbmail doctor` (fix if it reports problems), then
   `mailbox/bin/fbmail status`, then read `BOARD.md`.
2. **Pick.** Choose the lowest-numbered brief in `INBOX/TASK-*.md` whose `Owner` is your instance
   or `any`, and whose `Status` is `open`. **Respect dependencies and allowlists** — a brief that
   is not yours is not a hint, it is someone else's lane.

   **Brief-header contract.** A brief's header **must** use the list form below — it is what every
   `fbmail` command reads and what `claim`/`done` write. Copy it exactly:

   ```markdown
   # TASK-0NN — <title>

   - Owner: <inst>
   - Status: open
   - Depends on: nothing · Estimate: 45–70 min
   ```

   `Owner` is an instance name or `any`; `Status` is `open`, `claimed by <inst> <time>`, or
   `done …`. Anything else is **malformed**, not "probably fine": a brief whose `Status` cannot be
   read will not report as `ok` on the board. `fbmail status` shows it as `malformed` and exits
   **2** (naming the file), `fbmail board` keeps it visible across regeneration, and
   `fbmail check <id>` names the line to add — and `claim` refuses it rather than guessing.
3. **Claim.** `mailbox/bin/fbmail claim <id> <your-instance>` (or edit `- Status:` in place to
   `claimed by <instance> <timestamp>`). Claiming is what stops two workers doing the same work.
4. **Lock your files.** Before you write, take the advisory lock on every path in the brief's
   *Allowlist*: `mailbox/bin/fbmail lock <path> [path...] -b TASK-<id>`. Release with
   `fbmail unlock <path>|--all` when you finish — it is safe to call holding nothing.

   Locks are **advisory and always expirable**: at `FBMAIL_LOCK_TTL` (default 120 min) a lock is
   *stale*, the next `fbmail lock` takes it over with a warning, and `fbmail unlock --expired`
   clears it, so an abandoned lock can never wedge the fleet. If you meet a **live** lock you need,
   do not break it: NAG or BUS the Lead and pick another file — or, if you cannot proceed at all,
   write your report `Status: blocked` naming the holder. `fbmail status` and `fbmail doctor` show
   who holds what.
5. **Work.** Touch **only** the files in the brief's *Allowlist*. Read every listed context file
   first. The project rules that always apply are in `mailbox/README.md`, not here.
6. **Report.** Write `OUTBOX/TASK-<id>-REPORT.md` (template in §4) and make
   `TASK-<id>-END` the **last non-empty line**. That marker is the completion signal — never write
   it before the deliverable exists on disk. The check is **strict**: only exactly `TASK-<id>-END`
   counts. Any content after the marker fails, because that means the report was modified after
   completion. When it fails, `fbmail status` reports the row as `report-no-END` and names the file
   and the last non-empty line actually found; `fbmail board` flags it `⛔no-END`; and `watch`
   raises an ALERT.
7. **Blocked.** Still write the report with `Status: blocked` / `error` and say precisely what is
   missing. **Faking completion is the one unforgivable failure.**
8. **Finish clean.** `mailbox/bin/fbmail doctor > /dev/null` before you stop, so the next session
   inherits a working environment. If your brief forbade `*_test.go`, say so in the report.

---

## 2. NAG channel (workers: use it, it is a duty)

You run in a container. The Lead runs on the real host with capabilities you lack. Asking is
cheaper than improvising around a missing capability.

Add `NAG: <what you need> — <why it helps>` to your report, or drop `NAGS/open-<topic>.md`.

What the Lead can do for you (non-exhaustive — ask for anything):

- **Frozen files** — files a brief declares off-limits. Request the change instead of working
  around it.
- **Full-suite verification** — the project's whole build/vet/test pipeline across every lane, plus
  its live end-to-end gate.
- **Cross-lane integration** — merging two workers' files, wiring handlers into the router,
  resolving route collisions, deleting dead code after a swap.
- **Network/docs** — fetch upstream docs, resolve version questions, verify a mirror is alive.
- **Host tooling** — browser QA of rendered pages, context lookups, git operations (branching,
  committing your verified work).
- **Process** — clarify a brief, widen an allowlist, fix a wrong dependency or a stale spec
  reference.

Lead triages every nag between verification cycles: answered nags move to `NAGS/done-<topic>.md`
with the outcome. An unanswered nag gets re-added to your next report — never drop one silently.

---

## 3. File map

```
mailbox/
  README.md            project-specific rules + entry point
  PROTOCOL.md          this contract
  BOARD.md             generated status board (never hand-edit)
  bin/fbmail           the CLI (see §0)
  INBOX/TASK-*.md      briefs; the Status field drives the lifecycle
  OUTBOX/*-REPORT.md   worker reports, each terminated by TASK-<id>-END
  NAGS/open-*.md       worker requests for host-side help
  NAGS/done-*.md       triaged nags (what was asked → what was done)
  BUS/                 timestamped Lead↔worker notes
  HEALTH/<inst>.json   latest `fbmail doctor` result per instance
  ALERTS/ALERT-*.md    stale claims / reports missing their END marker
  selftest/            header-shape.sh, root-guard.sh
  .state/              seen/claimed markers (internal)
  .state/locks/        advisory file locks, one file per (path, holder); gitignored
```

---

## 4. Report template

> A **brief** uses the header contract in §1 step 2; a **report** uses the template below and must
> end with `TASK-<id>-END` as its last non-empty line (that marker is the completion signal).

```markdown
# TASK-<id> Report — <title>

Status: success | partial | blocked | error

## Summary
<what exists on disk now, and what it does>

## Checks
- <the project's build / vet / test commands, with their results>
- <live evidence: curl output, smoke result, byte counts, test list>

## Next_actions
1. <integration the Lead must do, if any>

## Artifacts
- <files created/modified>

## NAGs
- `NAG: <what you need> — <why it helps>`

TASK-<id>-END
```

---

## 5. Lead responsibilities

- Write briefs with explicit allowlists, real acceptance criteria, and **section references that
  exist**.
- Verify worker output (build/vet/test, the live gate, diff review) **before** integrating.
  Workers never commit.
- Answer every NAG; re-brief or take over a task that reports `blocked` twice.
- Watch `ALERTS/`: a *stale claim* usually means "the work landed but the report didn't" rather
  than failure — check the files on disk before re-opening the task.
- Keep the environment fixed: run `mailbox/bin/fbmail doctor --fix` against each worker home when a
  container is recreated.

---

## 6. Verification discipline (learned the expensive way)

**Never conclude "it works" from a passing build and vet.** Neither can see a route-level fault.
Both failures below were invisible to `build` + `vet` + the test suite:

- **A defined-but-unmounted lane** — a `Register*Routes` function existed and every handler in it
  was correctly access-guarded, but nothing called it: the two admin URLs answered **404** for
  ~20 h while build, vet, tests and the smoke gate were all green, because the gate only checked
  two other paths.
- **A duplicated `mux.Handle` pattern** — panics inside the router constructor at *runtime*, i.e.
  the whole app dies on the first request, health endpoint included. Only actually executing the
  constructor catches it.

So: **any claim that a surface works must come from executing it**, not from reading that it is
registered. A route-level change without live evidence is an unverified change.
