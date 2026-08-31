// ── Model Registry (Auto-Wrapper) ────────────────────────────────
// Catalog of models that can be called by the flock.
// Future: auto-generate MCP wrappers for any REST/OpenAPI service.

interface ModelEntry {
  id: string;
  birdId: string;
  model: string;
  provider: string;
  contextWindow?: number;
}

const MODEL_CATALOG: ModelEntry[] = [
  { id: "groq-llama-70b", birdId: "shahin", model: "llama-3.3-70b-versatile", provider: "Groq", contextWindow: 128000 },
  { id: "hf-llama-70b", birdId: "bulbul", model: "meta-llama/Llama-3.3-70B-Instruct", provider: "HuggingFace", contextWindow: 128000 },
  { id: "cf-llama-3b", birdId: "homa", model: "@cf/meta/llama-3.2-3b-instruct", provider: "Cloudflare Workers AI", contextWindow: 8000 },
];

export function getModelCatalog(): ModelEntry[] {
  return MODEL_CATALOG;
}

export function findModelBird(modelId: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === modelId || m.model === modelId);
}
