// ── Secrets — the half of `Env` that `wrangler types` cannot see ──────────────
//
// `wrangler types` introspects wrangler.toml, so it captures bindings and `[vars]`
// but never secrets: they are write-only, and a fresh checkout has none. It also
// regenerates `worker-configuration.d.ts` wholesale, so anything typed there is lost
// on the next run. Those declarations live here instead.
//
// Two augmentations, not one — and this is the part that is easy to get wrong:
//
//   * the top-level `Env` is what Hono's `Bindings` and the runtime's global `env` use;
//   * `Cloudflare.Env` is what `WorkerEntrypoint` and `DurableObject` default their
//     `Env` type parameter to (see the generated `DurableObject<Env = Cloudflare.Env>`).
//
// They are separate interfaces. Declaring a secret on only one of them gives you an
// `env.GROQ_API_KEY` that typechecks in the router and fails inside a Durable Object,
// or vice versa, with no hint that the two are unrelated.
interface SimorghSecrets {
  /** Groq API key. Absent ⇒ the Shāhīn bird is dormant; the flock still answers. */
  GROQ_API_KEY?: string;
  /** HuggingFace token. Absent ⇒ the Bulbul bird is dormant; the flock still answers. */
  HF_TOKEN?: string;
}

interface Env extends SimorghSecrets {}

declare namespace Cloudflare {
  interface Env extends SimorghSecrets {}
}
