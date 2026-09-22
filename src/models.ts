// ── Model Registry (Auto-Wrapper) — now owned by phoenix-core ────────────────
//
// The catalog is data about providers, not about this deployment, so it belongs to
// the engine that routes between them. The engine's copy renamed two members:
// `birdId` → `providerId` and `findModelBird` → `findModelProvider`, because the
// engine's vocabulary is provider-generic and the metaphor belongs to the host.
//
// `findModelBird` is kept as an alias rather than a second definition: it is named
// in the README's repository map, and a reader following that link should land on
// something real.

export {
  getModelCatalog,
  findModelProvider,
  type ModelEntry,
} from "@simorgh/phoenix-core";

/** Back-compat alias for `findModelProvider`; see the note above. */
export { findModelProvider as findModelBird } from "@simorgh/phoenix-core";
