# Architecture decisions

One concept per decision, in number order. The operative status remains the `**Status:**` line in each ADR body; the `status` in frontmatter is the OKF document lifecycle.

* [ADR-0001 — The role of the Go workspace](ADR-0001-go-workspace-role.md) — Why gateway/, packages/, bot/ and tools/ exist beside the TypeScript app, and what the Go side may never become.
* [ADR-0002 — Prove portability on a local-storage runtime before adding a networked host](ADR-0002-sqlport-async-before-networked-host.md) — SqlPort stays synchronous because no host wants async, and the Bun experiment proved the port shape rather than the runtime.
* [ADR-0003 — Free-compute capacity lives in the engine, not in a scheduler](ADR-0003-free-compute-capacity.md) — Capacity planning is a pure engine function over quota_state, not a scheduler-specific service.
* [ADR-0004 — upm is the package manager; Node is the only runtime; Bun is gone](ADR-0004-toolchain-upm.md) — Why upm.lock is the single lockfile and why there is exactly one JavaScript runtime.
* [ADR-0005 — FREE_ONLY is the default, and unknown cost is not free](ADR-0005-free-only-mode.md) — A three-state cost model where an unclassified provider is refused rather than optimistically used.
* [ADR-0006 — Auto-Router compatibility: a routing vocabulary and a complexity model](ADR-0006-auto-router-compatibility.md) — Why compatibility means speaking a routing vocabulary, and why the auto-router factory stays unwired.
* [ADR-0007 — What Simorgh adopts from working open source, and what it refuses](ADR-0007-adopted-patterns-from-working-open-source.md) — The adoption cross-walk, the refusal list, and the attribution rule for every ported pattern.
* [ADR-0008 — The unified surface: harness, API gateways and a first-run wizard](ADR-0008-unified-surface-harness-api-gateways-wizards.md) — The three-door model, the chat gateways that reached it, and the amendments to ADR-0007.

## See also

* [..](..) — the documentation map
