# TODO — live implementation queue

## TL;DR

**Do next: A3 — credential-derived principal identity.** Then wire the existing task graph and scheduler
through quota admission and usage reconciliation. Only after one durable task is correct should we build
retrieval, knowledge, memory, the first swarm workflow, and current-revision MCP.

**Order:** A3 → B1 → B2 → B3 → B4 → C1 → C2 → C3 → C4 → D1 → E1 → E2 → E3.

| Order | Task | Work status | Depends on |
|---:|---|---|---|
| 1 | [A3 — Principal identity](A3-principal-identity.md) | next | — |
| 2 | [B1 — Unified execution](B1-unified-execution.md) | queued | A3 |
| 3 | [B2 — Quota admission](B2-quota-admission.md) | queued | A3, B1 |
| 4 | [B3 — Usage reconciliation](B3-usage-reconciliation.md) | queued | B2 |
| 5 | [B4 — Truthful durable outcomes](B4-durable-outcomes.md) | queued | B1–B3 |
| 6 | [C1 — RetrievalPort](C1-retrieval-port.md) | queued | B4 |
| 7 | [C2 — Knowledge API](C2-knowledge-api.md) | queued | A3, C1 |
| 8 | [C3 — Principal/agent namespaces](C3-knowledge-namespaces.md) | queued | C2 |
| 9 | [C4 — Layered memory](C4-layered-memory.md) | queued | C3 |
| 10 | [D1 — Research digest](D1-research-digest.md) | queued | B4, C2, C4 |
| 11 | [E1 — Current-revision MCP](E1-mcp-current-revision.md) | queued | B1, D1 |
| 12 | [E2 — Provider discovery](E2-provider-discovery.md) | queued | B2, capabilities |
| 13 | [E3 — Evidence-gated validation birds](E3-validation-birds.md) | later | E2 |

## Working rules

- The [roadmap](../ROADMAP-SPINE.md) is the strategic source of truth; these linked documents are the executable queue.
- Each task records dependencies, acceptance checks, source evidence, and work status.
- A task is complete only when the artifacts and acceptance checks prove it; exit code alone is not proof.
- No parallel lanes, mailbox protocol, second scheduler, second task DB, giant policy engine, Rust/Wasm core, pooled credentials, automatic account creation, provider-count chase, or giant PWA.
- Use the code and official provider terms as truth. A repo-reported test count is not proof that the suite was rerun in the current session.
