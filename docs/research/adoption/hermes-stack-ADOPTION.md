# Hermes-stack → Simorgh adoption spec

Source: `github.com/Godde3s/hermes-stack` (Python, ~32★). MIT — the attribution line to record in
every derived file and in the root `NOTICE` is copied **verbatim from the upstream `LICENSE`**
(holder + year), naming `github.com/Godde3s/hermes-stack`. This file is the anchor ADR-0007 §4 row 11
and ADR-0008 point at; research pass 2026-10-09, read alongside the HF deploy debug session.

## 1. What it is

One free Hugging Face Space running the whole stack behind Caddy: the **Hermes Agent** (the chat /
tool loop), **9Router** and **OmniRouter** (the model-routing layer), an **OpenAI-compatible API**,
agent **dashboards**, **Telegram control**, **hourly backups to a private HF dataset**, a **keep-alive
GitHub Action**, and a **self-healing supervisor** that restarts what dies. The operator-facing piece
is a client-side GitHub-Pages **wizard**: it validates provider tokens live, writes secrets into a
generated repo, and dispatches the deploy workflow (the pattern ADR-0008 §3 copies for Door 3).

## 2. The finding that killed the Docker path (verified-free, dated)

Since **2026-07-08** Hugging Face returns **`402 Payment Required` for *new* compute Spaces on free
`cpu-basic`** — *"Static Spaces are free for everyone, but hosting Gradio and Docker Spaces on free
cpu-basic requires a PRO subscription."* Existing Spaces keep running; none can be created free.
**Static Spaces remain free.** Evidence: the 2026-10-09 debug session export
(`~/personal/projects/session-githubactiondebug.md`), HF's own docs, and the community threads that
session quotes. Simorgh's consequence is already decided — ADR-0008 §4 keeps HF in the target matrix
as **Static-only (dashboards)**, with the PRO-gate fact displayed in the wizard instead of
rediscovered.

## 3. What Simorgh adopts

| Pattern | Source component | Lands in | Effort |
|---|---|---|---|
| Wizard as a **target-matrix front-end**: validate tokens live against the provider, write secrets to a generated repo, dispatch the deploy, probe the live result | the deploy wizard | `simorgh-platform/src/deploy/wizard/*` — CLI and GitHub-Pages twins over the same planner (Epic 16) | **M** |
| **Self-healing supervisor**: exponential backoff on restart, never a crash-loop hammer | the supervisor process | `phoenix-core/src/scheduled.ts` | **S** |
| **Hourly state backup** to a private remote store, restore on boot | the hourly backup job | `MemoryStore` snapshot transports — Telegram `sendDocument`, Google Drive (Epic 15); snapshots stay off the answer path | **M** |
| One OpenAI-compatible door among several | its API layer | ADR-0008 Door 2 — already the shape of `/api/v1/*`; no port needed | — |

## 4. What Simorgh refuses

| Refused | Why |
|---|---|
| The **single-target premise** — one wizard, one host | A wizard that hardcodes one target dies when that target's policy moves; the 402 *is* that death (ADR-0008 §4: targets are data with dated verified-free citations, re-verified in CI) |
| **Browser automation** for capacity | The same line ADR-0007 §3 draws against omnirouter's web bridges: a logged-in browser session is not a bird, and scraped capacity is not capacity |

## MIT notice

The rows above copy **ideas and cadences, not code**, so no notice is required yet — this anchor
records what must happen *if* a port ever copies code (the supervisor's restart loop is the only
candidate): the upstream `LICENSE` line verbatim in the file header, plus a root `NOTICE` entry naming
`github.com/Godde3s/hermes-stack`. ADR-0007 §5's rule stands — row 11 states its own attribution need
when it ships, exactly as the other four adoption specs do.
