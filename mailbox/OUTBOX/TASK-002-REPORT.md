# TASK-002 Report

## Status

Done

## Summary

Documented the phoenix-core / simorgh-platform module boundary in three deliverables:

1. **`docs/ARCHITECTURE.md`** — new file covering all seven sections: two packages and the one-way arrow, host/engine split table, port table for all seven ports (`SqlPort`, `FetchLike`, `HttpLike`, `PhoenixPorts`, `ContextStorePort`, `LedgerPort`, `WorkersAiPort`), target × connector matrix from `targets.ts` (3 targets: cloudflare-workers, node, byo-endpoint), invariant list (7 rules with why and what catches each), three how-to recipes (adding a provider, target, host), and test suite locations with rationale for separation.

2. **`README.md`** — added **Modules** section after Quick Start stating the repo holds two packages (`@simorgh/phoenix-core` and `simorgh-platform`), naming them, linking `docs/ARCHITECTURE.md`. Corrected the Repository Map to include `phoenix-core/` with its src/ and test/ directories. Existing content preserved.

3. **`.github/workflows/ci.yml`** — verified no gap: `package.json` defines `"test": "test:workers && test:node"` and the workflow already runs `npm test`, which covers both suites. Added a workflow comment documenting this rather than adding a redundant step. Preserved the `GOFLAGS: -mod=readonly` comment.

No source files were modified. One observation logged under Next_actions.

## Checks

```
test -f docs/ARCHITECTURE.md && echo OK-file
OK-file
```

```
npm run typecheck && echo OK-typecheck
OK-typecheck
```

```
npm test && echo OK-tests                  # both suites: workers + node

> simorgh-platform@2.0.0 test
> npm run test:workers && npm run test:node

> simorgh-platform@2.0.0 test:workers
> vitest run

 RUN  v4.111 /home/shai/personal/projects/projects/opensource/simorgh-platform

 Test Files  10 passed (10)
      Tests  82 passed (82)

> simorgh-platform@2.0.0 test:node
> vitest run --config vitest.node.config.ts

 RUN  v4.111 /home/shai/personal/projects/projects/opensource/simorgh-platform

 Test Files  11 passed (11)
      Tests  127 passed (127)

OK-tests
```

```
grep -q 'phoenix-core' README.md && echo OK-readme
OK-readme
```

```
grep -q 'simorgh-platform' README.md && echo OK-readme2
OK-readme2
```

```
grep -q 'test:node\|npm test' .github/workflows/ci.yml && echo OK-ci
OK-ci
```

Path honesty check (no MISSING lines):

```
grep -oE '(phoenix-core|simorgh-platform|src|test|docs)/[A-Za-z0-9_./{}-]+\.(ts|md|json|yml)' docs/ARCHITECTURE.md | sort -u | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
Check complete
```

## Next_actions

- **Observation (not a bug):** `phoenix-core/src/security.ts` exports `RequestValidationError` as a class with `readonly` fields assigned in the constructor (not parameter properties). This is the one place in the engine where TypeScript class syntax touches runtime — it works because it avoids parameter properties, but it is flagged in the invariant list for awareness. No fix needed; documented.
- **README "Testing" section** still references the old 65-test count across six files. The current suites run 82 workerd tests (10 files) and 127 Node tests (11 files). This is factual drift in pre-existing content, not introduced by this task — updating it is optional.

## Artifacts

- `docs/ARCHITECTURE.md` (new)
- `README.md` (Modules section added, Repository Map corrected)
- `.github/workflows/ci.yml` (comment added clarifying test coverage)

## NAGs

None

TASK-002-END
