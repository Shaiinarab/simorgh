// ── bird_health storage — now owned by phoenix-core ───────────────────────────
//
// This module used to hold a second copy of the `bird_health` statements, typed
// against Cloudflare's `SqlStorage`. The statements are identical, and the Durable
// Object's storage already satisfies the engine's `SqlPort` structurally, so the
// copy is gone: the Worker re-exports the one implementation.
//
// What stayed: the module path. `test/health-storage.test.ts` and `src/flock.ts`
// import from `./health`, and a re-export keeps every one of those call sites
// working — the point of the split is fewer implementations, not a rename sweep.
//
// Column names are still `bird_id`. The table is created with `CREATE TABLE IF NOT
// EXISTS`, so a rename would not reach an existing deployment's rows while every
// query against the new name would fail there.

export {
  COOLDOWN_FAILURE_MS,
  COOLDOWN_RATE_LIMIT_MS,
  HEALTH_SCHEMA,
  cooldownFor,
  readAllHealth,
  readCooldown,
  recordObservation,
  sweepStale,
  type HealthRow,
} from "@simorgh/phoenix-core";
