
# Simorgh Platform — Source Map

Source of truth: `/home/shai/simorgh-platform/`.

## Repository Map

```
simorgh-platform/
├── src/
│   ├── index.ts       # Hono app: routes, Intent Shield, tool loop, Data Trust, Context Offload
│   ├── flock.ts       # Flock: bird adapters + FlockCoordinator DO (Swarm-State)
│   ├── models.ts      # Model Registry (Auto-Wrapper catalog)
│   ├── data-trust.ts  # DataTrustVault DO: transparency ledger
│   └── dashboard.ts   # Self-contained Mission Control HTML (inline CSS/JS, no build)
├── test/
│   └── index.test.ts  # Core contract tests (vitest)
├── docs/
│   ├── prd/
│   │   ├── PRD.md                     # Full PRD v2.0 — 13 epics, 63 stories
│   │   ├── EPICS_AND_STORIES.md       # Sprint planning summary
│   │   └── epics.md                   # Epics index
│   └── research/
│       └── 2026-08-round2.md          # Knowledge-gap deep dive (MCP, birds, search)
├── .bmad/                             # BMAD phase artifacts
├── tsconfig.json                      # TypeScript 7 (tsgo) config — strict, noEmit
├── wrangler.toml                      # bindings: AI, KV(CONTEXT_STORE), DOs(FlockCoordinator, DataTrustVault)
├── package.json                       # npm, ESM, tsgo + wrangler + vitest
├── SOUL.md                            # Design philosophy
├── AGENT.md                           # Agent contract (review-first)
├── AGENTS.md                          # AI agent compatibility instructions
└── README.md                          # Getting started, flock table, API reference
```

## Entrypoints

| Entrypoint | Purpose |
|------------|---------|
| `src/index.ts` | Hono app — routes, Intent Shield, execute loop |
| `src/flock.ts` | Bird adapters + FlockCoordinator DO |
| `src/data-trust.ts` | DataTrustVault DO |
| `src/dashboard.ts` | Mission Control UI |
| `src/models.ts` | Model registry |
| `test/index.test.ts` | Core contract tests |
| `docs/prd/PRD.md` | Product requirements |
| `README.md` | Quickstart + architecture snapshot |
| `wrangler.toml` | Cloudflare bindings |

## Package Manager / Scripts

- **package manager**: npm
- **scripts**:
  - `dev`: `wrangler dev --local --port 8787`
  - `typecheck`: `tsgo --noEmit`
  - `test`: `vitest run`
  - `deploy`: `tsgo --noEmit && wrangler deploy`
  - `security:check`: `npm audit --omit=dev && tsgo --noEmit && wrangler deploy --dry-run`

## Key Modules

- Flock federation — `src/flock.ts` (3 birds: Shāhīn, Bulbul, Homā)
- Intent Shield — `src/index.ts` (`TOOL_ALLOW_LIST`)
- Data Trust ledger — `src/data-trust.ts`
- Mission Control dashboard — `src/dashboard.ts`
- Auto-Wrapper catalog — `src/models.ts`

## Notes

- TypeScript 7 via `@typescript/native-preview` (tsgo).
- Zero secrets required for local dev — Homā (Workers AI) is always on.
- Do not overwrite BMAD state.md under `.hermes/projects/simorgh-platform/`; patch fields only.
