# AGENTS.md

## Quick start

- Install dependencies: `npm install`
- Run typecheck: `npm run typecheck` (TypeScript 7 / tsgo)
- Run tests: `npm test`
- Local dev: `npm run dev` (wrangler dev, port 8787)
- Deploy: `npm run deploy` (typecheck-gated)

## Architecture

- Repository: `simorgh-platform`
- Primary language: TypeScript (TypeScript 7 / tsgo — `@typescript/native-preview`)
- Runtime: Cloudflare Workers (Hono framework)
- State: Durable Objects (SQLite) + KV
- Entry: `src/index.ts` (Hono app)

## Key directories

- `src/` — application source (index, flock, models, dashboard)
- `test/` — test files (vitest)
- `docs/prd/` — PRD with epics & stories
- `.bmad/` — BMAD Method state + phase artifacts

## Code style

- ESM (`"type": "module"`)
- Strict TypeScript validation before dry-runs or deployment
- Match existing patterns; prefer boring, stable technology

## Testing

- Tests use vitest
- `npm test` runs all tests
- 100% pass required before review/merge
- Test files: `*.test.ts`

## Performance & simplicity

- Cost to run: $0 (all free-tier primitives)
- Never guess at bottlenecks; measure before optimizing
- Prefer simple algorithms until workload data proves otherwise

## PR guidelines

- Descriptive, imperative commit messages
- Reference issues: `Fixes #123` or `Closes #123`
- Keep PRs focused; include test evidence for non-trivial changes
