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
  test: {
    // Scoped to `test/`, which is the Worker's own suite. Without this, vitest's
    // default glob reaches into the workspace packages and tries to run
    // phoenix-core's Node tests inside workerd — where they would fail for the exact
    // reason they exist. The packages have their own config: vitest.node.config.ts.
    include: ["test/**/*.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },

      // `remoteBindings` defaults to true, which makes the pool open a *remote proxy
      // session* through wrangler at startup — so the suite needs a Cloudflare login
      // (CLOUDFLARE_API_TOKEN) before a single test runs. That made CI fail at
      // "Failed to start the remote proxy session", for a suite that never touches a
      // provider: the routing tests pass a fake env, and the HTTP tests stub the flock.
      //
      // Turning it off also stops the AI binding being dialled, which is what printed
      // "Establishing remote connection" and held the process open past the test run.
      remoteBindings: false,
    }),
  ],
});
