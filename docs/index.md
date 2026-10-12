# Simorgh documentation

## TL;DR

Read in this order: [current TODOs](todo/index.md) → [roadmap spine](ROADMAP-SPINE.md) → [current state](STATE-OF-PROJECT.md) → [security audit](SECURITY-AUDIT.md) → [reference architecture](REFERENCE-ARCHITECTURE.md).

Planning documents use OKF v0.2: Markdown with YAML frontmatter, sources/provenance, generation time, lifecycle status, freshness deadline, and ordinary Markdown cross-links. Task progress is recorded in the task concept's `work_status`; OKF `status` remains the document lifecycle (draft/stable/deprecated). No custom database, index service, or required validator is introduced.

## How this bundle conforms

**The bundle root is the repository root**, and `docs/` is a subdirectory of it. SPEC §3 lets a bundle
sit inside a larger repository; here the repository is the bundle, with the vendored trees listed
below held outside it. `okf_version: "0.2"` is declared in the bundle-root
[`index.md`](../index.md) — the only place the spec permits frontmatter in an `index.md`. The rules
below are the OKF v0.2 ones this tree actually uses, so a new document can be written correctly
without opening the spec.

| Rule | What it means here |
|---|---|
| Every non-reserved `.md` has parseable YAML frontmatter with a non-empty `type` | Conformance, SPEC §11. `type` is the only always-required field. This covers the six root documents too — `README.md`, `AGENTS.md`, `AGENT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SOUL.md` — which are bundle-root concepts like any other. |
| `index.md` and `log.md` are reserved | They carry **no** frontmatter — the one exception is `okf_version` on this bundle-root index. |
| `sources` entries need a `resource` that resolves | A bundle-relative path (`../ROADMAP-SPINE.md`) or an absolute URL. Docs anchored to code point at real files, and a wrong path is a bug worth the same fix as a broken link. |
| `generated: {by, at}` | `at` is ISO 8601 **with** an explicit offset, and `by` follows the actor convention `<producer>/<version>` for agents, `human:<id>` for people, `process:<id>` for processes. |
| `verified` | A mapping or list of `{by, at}` events. It is **not** a formality: it means someone or something checked the content against the code. Absent ⇒ unverified, which is the honest state for a dated research record. |
| `status` / `stale_after` | `draft` / `stable` / `deprecated`. A dated record whose numbers are superseded is `deprecated`, not silently left `stable`. |
| Cross-links | Markdown links, bundle-relative or relative. Broken links are tolerated by consumers and fixed by us. |
| Directory indexes | `adr/`, `research/` (+ `research/adoption/`), `prd/`, `design/` and `history/` each have an `index.md` listing their concepts with the frontmatter `description`. Regenerate them from the frontmatter rather than hand-editing. |

**Out of bundle.** These trees hold third-party markdown with its own format and are not concepts:
`.agents/skills/` (vendored BMAD and simorgh skills), `_bmad/`, `_bmad-output/`, `.bmad/`, `bench/`,
`.serena/`, `.claude/`, `.openclaw/`, `dist/`, `mailbox/`. The port and safety facts those skills
assert are still ours to verify — see [AGENTS.md](../AGENTS.md) §"Verification discipline".

**Repo-specific extension fields** are allowed by the spec and used here: `work_status`, `priority`
and `depends_on` on task concepts. They are our vocabulary, not OKF's, and the spec's `status` stays
the document lifecycle.

## Core

- [Roadmap spine](ROADMAP-SPINE.md) — architecture, phases, dependencies and frozen non-goals.
- [TODO index](todo/index.md) — ordered implementation queue and task links.
- [Project state](STATE-OF-PROJECT.md) — evidence-backed capabilities and known gaps.
- [Architecture](ARCHITECTURE.md) and [reference architecture](REFERENCE-ARCHITECTURE.md) — invariants and reusable mechanisms.
- [Security audit](SECURITY-AUDIT.md) — findings, severity and disposition.

## Decisions and research

- [Architecture decisions](adr/) — decisions that constrain implementation.
- [Research](research/) — ecosystem evidence, benchmarks and adoption studies.
- [Continuation review](research/CONTINUATION-REVIEW-2026-10-10.md) — why the next work is identity → quota-aware durable execution → knowledge → swarm.
- [Retirement record](history/coordination-retirement-2026-10-10.md) — where the former coordination framework's conclusions now live.

## Documentation rules

- Prefer the existing implementation and proven mechanisms; add a dependency only when a port cannot reuse what is already installed.
- Every claim about current behavior names code/tests or carries a source.
- Keep a short **TL;DR** near the beginning of substantial docs.
- Keep task docs small, independently reviewable and linked to prerequisites.
- Do not change runtime behavior in a documentation-only task.
