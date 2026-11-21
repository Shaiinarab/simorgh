# Simorgh documentation

## TL;DR

Read in this order: [current TODOs](todo/index.md) → [roadmap spine](ROADMAP-SPINE.md) → [current state](STATE-OF-PROJECT.md) → [security audit](SECURITY-AUDIT.md) → [reference architecture](REFERENCE-ARCHITECTURE.md).

Planning documents use OKF v0.3: Markdown with YAML frontmatter, sources/provenance, generation time, lifecycle status, freshness deadline, and ordinary Markdown cross-links. Task progress is recorded in the task concept's `work_status`; OKF `status` remains the document lifecycle (draft/stable/deprecated). No custom database, index service, or required validator is introduced.

## How this bundle conforms

**The bundle root is the repository root**, and `docs/` is a subdirectory of it. SPEC §3 lets a bundle
sit inside a larger repository; here the repository is the bundle, with the vendored trees listed
below held outside it. `okf_version: "0.3"` is declared in the bundle-root
[`index.md`](../index.md) — the only place the spec permits frontmatter in an `index.md`. The rules
below are the OKF v0.3 ones this tree actually uses, so a new document can be written correctly
without opening the spec.

| Rule | What it means here |
|---|---|
| Every non-reserved `.md` has parseable YAML frontmatter with a non-empty `type` | Conformance, SPEC §11. `type` is the only always-required field. A `.md` without `type` is **not a concept** (v0.3 §3.2) — this covers root files like `README.md` and `AGENTS.md`, which are bundle-root concepts like any other, and lets tooling files stay plain Markdown. |
| `index.md` and `log.md` are reserved | They carry **no** frontmatter — the one exception is `okf_version` (plus `title`/`description`/`license`) on the bundle-root index (v0.3 §8.1). |
| `sources` entries need a `resource` that resolves | A path relative to the file's own directory (`../ROADMAP-SPINE.md`) or an absolute URL; a leading `/` resolves from the bundle root (v0.3 §6.2 — the v0.2 bundle-root fallback no longer applies once `okf_version` is 0.3). Docs anchored to code point at real files, and a wrong path is a bug worth the same fix as a broken link. |
| `generated: {by, at}` | `at` is RFC 3339 **with** an explicit offset, and `by` follows the actor convention `<producer>/<version>` for agents, `human:<id>` for people, `team:<id>` for groups, `process:<id>` for processes (v0.3 §7). |
| `verified` | A mapping or list of `{by, at}` events. It is **not** a formality: it means someone or something checked the content against the code. Only events at or after `generated.at` are **current** and give the trust tier (v0.3 §5.3): no current event ⇒ unverified, non-human current events ⇒ machine-confirmed, a current `human:` event ⇒ human-reviewed. Absent ⇒ unverified, which is the honest state for a dated research record. |
| `status` / `stale_after` | `draft` / `stable` / `deprecated`. A dated record whose numbers are superseded is `deprecated`, not silently left `stable`; `superseded_by` names the replacement (v0.3 §5.4). A `stale_after` that does not parse is never fresh. |
| Cross-links | Markdown links, relative or bundle-root. Broken links are tolerated by consumers and fixed by us. |
| Extension keys | `x-<producer>-<name>` for anything OKF does not define (v0.3 §4.1); our `work_status`, `priority` and `depends_on` are pre-existing repo vocabulary and stay as they are. |
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
- [ADR-0009 — module adoption](adr/ADR-0009-module-adoption-retrieval.md) — the retrieval port, the zero-dependency FTS5 baseline, optional Orama / conditional AI Search, and the refusal list.
- [ADR-0010 — native-module policy](adr/ADR-0010-native-module-policy.md) — why the Rust/Wasm core stays rejected while native modules are allowed as optional, differentially tested, measured, default-OFF accelerators (the output shield in `native/`).
- [November 2026 deep recon](research/NOVEMBER-2026-DEEP-RECON.md) — the 2026-11-21 reconnaissance behind roadmap v2: final MCP 2026-07-28, Go-gateway convergence, the free-tier roster, and the native-shield measurement.
- [Security audit](SECURITY-AUDIT.md) — findings, severity and disposition.
- [REST contract](api/CONTRACT.md) — the single API/config surface used by the CLI, dashboard and Android client.
- [Simorgh Control Center](design/simorgh-control-center.md) — six-step onboarding, secure provisioning boundary, identity handoff and client profile design.
- [ADR-0011](adr/ADR-0011-control-center-provisioning-boundary.md) — Pages stays static; a loopback CLI companion owns secrets and deployment.

## Decisions and research

- [Architecture decisions](adr/) — decisions that constrain implementation.
- [Research](research/) — ecosystem evidence, benchmarks and adoption studies.
- [PRD research programme (August 2026)](research/prd-program-2026-08/index.md) — the brief, the epics digest and the 1M-user capacity arithmetic the August PRD was written from.
- [Continuation review](research/CONTINUATION-REVIEW-2026-10-10.md) — why the next work is identity → quota-aware durable execution → knowledge → swarm.
- [Retirement record](history/coordination-retirement-2026-10-10.md) — where the former coordination framework's conclusions now live.

## Documentation rules

- Prefer the existing implementation and proven mechanisms; add a dependency only when a port cannot reuse what is already installed.
- Every claim about current behavior names code/tests or carries a source.
- Keep a short **TL;DR** near the beginning of substantial docs.
- Keep task docs small, independently reviewable and linked to prerequisites.
- Do not change runtime behavior in a documentation-only task.
