import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run in workerd, not Node: src/flock.ts and src/data-trust.ts import
// `cloudflare:workers` (DurableObject) and the tests import the whole app, so a plain
// Node environment cannot resolve them. The pool also hands the tests a real
// AI/KV/DO binding set read from wrangler.toml, for free.
//
// Two APIs exist in 0.22 and they are not interchangeable:
//
//   cloudflarePool(...)  a Vitest *pool initializer*, passed as `test.pool`
//   cloudflareTest(...)  a Vite *plugin*, added to `plugins`
//
// Only the plugin registers resolution for the `cloudflare:test` module. With
// `test.pool` the module typechecks (the types are declared) and then fails at runtime
// with "Cannot find package 'cloudflare:test'" — which is exactly the kind of gap that
// makes a passing typecheck misleading.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
