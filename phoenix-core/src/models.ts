// ── Model Registry (Auto-Wrapper) ────────────────────────────────
// Catalog of models that can be called by the flock.
// Future: auto-generate MCP wrappers for any REST/OpenAPI service.

export interface ModelEntry {
  id: string;
  providerId: string;
  model: string;
  provider: string;
  contextWindow?: number;
}

const MODEL_CATALOG: readonly ModelEntry[] = [
  { id: "groq-llama-70b", providerId: "shahin", model: "llama-3.3-70b-versatile", provider: "Groq", contextWindow: 128000 },
  { id: "hf-llama-70b", providerId: "bulbul", model: "meta-llama/Llama-3.3-70B-Instruct", provider: "HuggingFace", contextWindow: 128000 },
  { id: "cf-llama-3b", providerId: "homa", model: "@cf/meta/llama-3.2-3b-instruct", provider: "Cloudflare Workers AI", contextWindow: 8000 },
];

export function getModelCatalog(): readonly ModelEntry[] {
  return MODEL_CATALOG;
}

export function findModelProvider(modelId: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === modelId || m.model === modelId);
}
