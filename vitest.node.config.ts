import { defineConfig } from "vitest/config";

// ── The Node suite ────────────────────────────────────────────────────────────
//
// Deliberately a *separate* config from `vitest.config.ts`.
//
// That one runs the Worker app inside workerd, because `src/**` imports
// `cloudflare:workers` and the test pool hands out real AI/KV/Durable-Object
// bindings. This one runs the two library packages under plain Node, with no pool,
// no wrangler, and no runtime bindings at all.
//
// The split is the portability proof, not a workaround: if `@simorgh/phoenix-core`
// ever picks up a runtime dependency — a `cloudflare:` import, a global binding, a
// `crypto` global — this suite stops resolving and goes red, while the workerd suite
// keeps passing. That is the signal we want, in the suite named for it.
export default defineConfig({
  test: {
    include: ["phoenix-core/test/**/*.test.ts", "simorgh-platform/test/**/*.test.ts"],
    environment: "node",
  },
});
