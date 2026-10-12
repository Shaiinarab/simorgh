---
okf_version: "0.2"
---

# Simorgh documentation bundle

This is the bundle root: an [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
corpus covering the repository's own documentation. Every non-reserved `.md` file in it carries YAML
frontmatter with a `type`, plus provenance, trust and lifecycle fields. The conventions this tree
follows, and the list of held-out vendored directories, are written down in
[docs/index.md](docs/index.md).

## Start here

* [README.md](README.md) — what Simorgh is, the flock, the API surface and the repository map.
* [AGENTS.md](AGENTS.md) — the operating contract: architecture rule, commands, traps, definition of done.
* [AGENT.md](AGENT.md) — what an agent connected to Simorgh may do, and the provider effects it may never cause.
* [SOUL.md](SOUL.md) — what the project is for.
* [CONTRIBUTING.md](CONTRIBUTING.md) — setup, the two suites, and the pins a new provider breaks.
* [SECURITY.md](SECURITY.md) — threat model, trusted and untrusted input, reporting.

## The plan and the queue

* [Roadmap spine](docs/ROADMAP-SPINE.md) — architecture, phases, dependencies, frozen non-goals.
* [TODO index](docs/todo/index.md) — the live ordered queue of thirteen tasks.
* [Project state](docs/STATE-OF-PROJECT.md) — evidence-backed capabilities and known gaps, re-measured 2026-10-12.

## Directories

* [docs/](docs/) — the documentation map, and every planning concept.
  * [Architecture decisions](docs/adr/) — eight ADRs, decision status in each body.
  * [Research](docs/research/) — ecosystem evidence and audits, dated records marked `deprecated`.
  * [Adoption specs](docs/research/adoption/) — what to take from each open-source system, and what to refuse.
  * [Product requirements](docs/prd/) — the historical August PRD and epic breakdowns.
  * [Design](docs/design/) — surfaces not yet settled.
  * [History](docs/history/) — retired frameworks and where their conclusions live.

## Out of bundle

`.agents/skills/`, `_bmad/`, `_bmad-output/`, `.bmad/`, `bench/`, `.serena/`, `.claude/`,
`.openclaw/`, `dist/` and `mailbox/` hold third-party or generated markdown with its own format and
are deliberately not concepts.
