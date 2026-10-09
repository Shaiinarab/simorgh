# REA MCP contract-generation — adoption for Simorgh

Evidence: morluto/rea `docs/mcp-contracts.md`, `docs/tool-design.md`,
`scripts/generate-mcp-tool-catalog.mjs`, `src/contracts/toolContracts.ts`,
`tests/fixtures/mcpToolCatalog.ts`, `tests/boundary/mcp/toolSchemaValidity.test.ts`.

## The pattern

1. **Source of truth — one contract array.** `src/contracts/toolContracts.ts`
   exports `TOOL_CONTRACTS`, one `ToolContract` per public tool
   (`name, title, description, kind, inputSchema` [Zod]`, outputSchema`,
   `effects`, `annotations`, `examples`). A tool exists only as a contract.
2. **Generator.** `npm run mcp-catalog:generate` runs
   `scripts/generate-mcp-tool-catalog.mjs`: it registers every contract into a
   *real* `McpServer` via `toolRegistrationOptions()` (Zod → JSON Schema),
   connects an SDK `Client` over `InMemoryTransport`, calls `tools/list`,
   Ajv2020-validates each advertised schema, canonicalizes JSON, writes
   `.cache/mcp-tool-catalog.json`. `--check` fails when stale or missing.
3. **Consumers/test.** `tests/fixtures/mcpToolCatalog.ts` reads that JSON
   (type-guarded) as `GENERATED_MCP_TOOL_CATALOG`;
   `tests/boundary/mcp/toolSchemaValidity.test.ts` asserts schema validity, no
   recursive `$ref`, annotation hints, and strict parity (Zod `safeParse` vs
   Ajv-compiled advertised schema). CI runs `npm run docs:check` →
   `generate-mcp-tool-catalog.mjs --check`; release also runs
   `git diff --exit-code`.

Naming rules: task shapes (`inspect/search/list/trace/compare/workflow/capture`)
are guidance, not prefixes; name for the action+object an agent reasons about,
provider-neutral, distinct from neighbours, strict object inputs, complete
results, truthfully declared effects.

## Apply to Simorgh

Both tool lists are handwritten and duplicated: `simorgh_*` inline in
`simorgh-platform/src/runtimes/node.ts` (`tools/list`), `platform_*` inline in
`simorgh-platform/src/mcp/server.ts`.

- **Contract file:** `simorgh-platform/src/mcp/toolContracts.ts` —
  `MCP_TOOL_CONTRACTS` (name, description, inputSchema, effects, annotations,
  examples) for all five tools; both handlers import it instead of literals.
- **Generated:** `.cache/mcp-tool-catalog.json` from
  `scripts/generate-mcp-tool-catalog.mjs` (`upm` scripts `mcp-catalog:generate`
  / `mcp-catalog:check`) — drive the real handlers' `tools/list`, snapshot,
  Ajv-validate.
- **Test pinning both:** `simorgh-platform/test/mcp-tool-catalog.test.ts` —
  load the generated catalog (stale ⇒ fail), assert each live handler's
  `tools/list` equals it with `toEqual` on sorted names (completeness, not
  `toContain`), and assert the prefix invariant: no `platform_*` in the core
  catalog, no `simorgh_*` in the platform catalog. Run `mcp-catalog:check` in CI
  beside `upm test`. First locate the route mounting `platformMcpHandler`
  (open NAG-001).
