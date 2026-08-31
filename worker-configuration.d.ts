// ── Env type for Cloudflare Workers bindings ─────────────────────
interface Env {
  // AI binding — always available (Homā bird, zero-KYC guarantee)
  AI: Ai;

  // KV namespace — Context Offload
  CONTEXT_STORE: KVNamespace;

  // Durable Objects
  FLOCK_COORDINATOR: DurableObjectNamespace;
  DATA_TRUST_VAULT: DurableObjectNamespace;

  // Secrets (optional — absent = dormant bird, safe by default)
  GROQ_API_KEY?: string;
  HF_TOKEN?: string;
}
