# TODO — live implementation queue

## TL;DR

**Do next: B1.** A3 (credential-derived principal identity) shipped 2026-11-16. Retrieval (C1)
shipped 2026-11-20 (RetrievalPort + FTS5 baseline, 17 tests). **C2 shipped 2026-11-21** — the four
knowledge routes, chunked FTS5 indexing with passage-level provenance, replace-on-reindex,
principal-scoped namespaces (workers 19 files / 193 tests, node 30 files / 561 tests,
platform:smoke green). Then B1–B4 (the execution spine), E1 against the final MCP 2026-07-28 spec,
and the new 2026 levers: **G2 Go-gateway convergence** and **G3 MCP Apps**. G1 (native shield) is
done and default-off; the 2026-11-21 native exploration measured honestly (1.5–1.7× slower than V8).

**Order:** A3 → C2 (land) → B1 → B2 → B3 → B4 → C3 → E1 → G2 → G3 → C4 → D1 → E2 → E3.
G1 is optional/parallel; F (scale) only after B–D prove out.

| Order | Task | Work status | Depends on |
|---:|---|---|---|
| 1 | [A3 — Principal identity](A3-principal-identity.md) | done | — |
| 2 | [C1 — RetrievalPort](C1-retrieval-port.md) | done | B4 |
| 3 | [C2 — Knowledge API](C2-knowledge-api.md) | done | A3, C1 |
| 4 | [B1 — Unified execution](B1-unified-execution.md) | queued | A3 |
| 5 | [B2 — Quota admission](B2-quota-admission.md) | queued | A3, B1 |
| 6 | [B3 — Usage reconciliation](B3-usage-reconciliation.md) | queued | B2 |
| 7 | [B4 — Truthful durable outcomes](B4-durable-outcomes.md) | queued | B1–B3 |
| 8 | [C3 — Principal/agent namespaces](C3-knowledge-namespaces.md) | queued | C2 |
| 9 | [E1 — Current-revision MCP](E1-mcp-current-revision.md) | queued | B1, C2 |
| 10 | [G2 — Go gateway convergence](G2-go-gateway-convergence.md) | queued | A3 |
| 11 | [G3 — MCP Apps dashboard](G3-mcp-apps-dashboard.md) | queued | E1 |
| 12 | [G4 — Control Center wizard](G4-control-center-wizard.md) | queued | A3, existing deploy planner, ADR-0011 |
| 13 | [C4 — Layered memory](C4-layered-memory.md) | queued | C3 |
| 14 | [D1 — Research digest](D1-research-digest.md) | queued | B4, C2, C4 |
| 15 | [E2 — Provider discovery](E2-provider-discovery.md) | later | B2, C1 |
| 16 | [E3 — Evidence-gated validation birds](E3-validation-birds.md) | later | E2 |
| — | [G1 — Native output shield](G1-native-output-shield.md) | **done (default OFF)** | — |

## Working rules

- The [roadmap](../ROADMAP-SPINE.md) is the strategic source of truth; these linked documents are the executable queue.
- Each task records dependencies, acceptance checks, source evidence, and work status.
- A task is complete only when the artifacts and acceptance checks prove it; exit code alone is not proof.
- No parallel lanes, mailbox protocol, second scheduler, second task DB, giant policy engine, Rust/Wasm core, pooled credentials, automatic account creation, provider-count chase, or giant PWA.
- Native modules are allowed only under [ADR-0010](../adr/ADR-0010-native-module-policy.md): optional accelerators behind ports, differentially tested, measured, default OFF.
- Use the code and official provider terms as truth. A repo-reported test count is not proof that the suite was rerun in the current session.