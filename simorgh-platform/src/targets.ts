// ── Deployment targets ────────────────────────────────────────────────────────
//
// A target answers three questions about one place a phoenix-core can run:
//
//   1. How does the core get there?      → `steps`
//   2. How does the platform reach it?   → `connectors` + `endpoint`
//   3. What does it need to be given?    → `secrets`
//
// ── Only real targets ──
//
// Every target below has artifacts that exist in this repository today. There is
// deliberately no `deno`, no `kubernetes`, no `lambda` entry: each would need a
// runtime entrypoint and a build we do not ship, and a target that cannot actually
// complete its own step list is worse than a missing one — it turns "deploy" into a
// debugging session at the worst possible moment.
//
// Adding one is a small, honest act: write the entrypoint, then `registerTarget(...)`
// it with a step list that works. `EXTENSION_POINT` in the docs marks the seam.

/**
 * Which way the platform talks to a deployed core.
 *
 * Imported rather than redeclared: a target and a connector must agree on what the
 * kinds are, and two identical unions in two files is how they stop agreeing. It is
 * deliberately not re-exported from here — `connectors/types.ts` owns it, and a
 * second export of the same name makes `export *` in the barrel ambiguous.
 */
import type { ConnectorKind } from "./connectors/types.ts";

/** How a target's steps get executed. */
export type DeploymentMode = "manual" | "cli";

export interface TargetSecret {
  name: string;
  description: string;
  required: boolean;
}

/**
 * One unit of work in a deployment.
 *
 * `run` present ⇒ a machine can do it. `run` absent ⇒ a human must, and `manual`
 * says what they do. Keeping both in one ordered list is what makes `manual` and
 * `cli` two renderings of the same plan instead of two divergent documents.
 */
export interface DeployStep {
  id: string;
  description: string;
  run?: readonly string[];
  /** What the human does, when `run` is absent. */
  manual?: string;
  /** Secret names this step needs in its environment. */
  needs?: readonly string[];
}

export interface DeploymentTarget {
  id: string;
  label: string;
  /** What the core process is. */
  runtime: string;
  /** Connector kinds a core running here speaks. */
  connectors: readonly ConnectorKind[];
  /** `{service}` and `{origin}` are substituted at plan time. */
  endpoint: string;
  modes: readonly DeploymentMode[];
  secrets: readonly TargetSecret[];
  steps: readonly DeployStep[];
  notes: string;
}

const CLOUDFLARE_WORKERS: DeploymentTarget = {
  id: "cloudflare-workers",
  label: "Cloudflare Workers (the edge)",
  runtime: "workerd",
  connectors: ["rest", "mcp"],
  endpoint: "https://{service}.workers.dev",
  modes: ["manual", "cli"],
  secrets: [
    {
      name: "CLOUDFLARE_API_TOKEN",
      description: "Token with Workers Scripts:Edit on the target account.",
      required: true,
    },
    {
      name: "CLOUDFLARE_ACCOUNT_ID",
      description: "Account the Worker deploys into.",
      required: true,
    },
    {
      name: "SIMORGH_API_KEY",
      description:
        "Bearer token every caller must present. Without it the API fails closed with 503.",
      required: true,
    },
    {
      name: "GROQ_API_KEY",
      description: "Unlocks the Shāhīn provider. Optional — Homā needs no key.",
      required: false,
    },
    {
      name: "HF_TOKEN",
      description: "Unlocks the Bulbul provider. Optional.",
      required: false,
    },
    {
      name: "CORS_ORIGINS",
      description: "Comma-separated browser origins. Unset allows no browser origin.",
      required: false,
    },
  ],
  steps: [
    {
      id: "deps",
      description: "Install workspace dependencies",
      run: ["npm", "ci"],
    },
    {
      id: "kv",
      description: "Create the CONTEXT_STORE KV namespace and paste its id into wrangler.toml",
      manual:
        "npx wrangler kv namespace create CONTEXT_STORE, then set the id in wrangler.toml. wrangler dev and --dry-run accept the placeholder; a real deploy does not.",
      needs: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    },
    {
      id: "secrets",
      description: "Upload the API key and any optional provider keys",
      manual:
        "npx wrangler secret put SIMORGH_API_KEY, then optionally GROQ_API_KEY, HF_TOKEN.",
      needs: ["SIMORGH_API_KEY"],
    },
    {
      id: "deploy",
      description: "Typecheck-gated deploy",
      run: ["npm", "run", "deploy"],
      needs: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    },
    {
      id: "verify",
      description: "Confirm the deployed flock answers",
      run: ["curl", "-fsS", "{origin}/health"],
    },
  ],
  notes:
    "The only target with a zero-KYC guarantee: Workers AI is bound in wrangler.toml, so the flock answers with no secrets configured beyond the API key.",
};

const NODE: DeploymentTarget = {
  id: "node",
  label: "Self-hosted Node process",
  runtime: "node",
  connectors: ["rest", "mcp"],
  endpoint: "http://{origin}",
  modes: ["manual", "cli"],
  secrets: [
    {
      name: "SIMORGH_API_KEY",
      description: "Bearer token every caller must present.",
      required: true,
    },
    {
      name: "GROQ_API_KEY",
      description: "Unlocks the Shāhīn provider. Optional.",
      required: false,
    },
    {
      name: "HF_TOKEN",
      description: "Unlocks the Bulbul provider. Optional.",
      required: false,
    },
  ],
  steps: [
    {
      id: "deps",
      description: "Install workspace dependencies",
      run: ["npm", "ci"],
    },
    {
      id: "smoke",
      description:
        "Boot a real core on an ephemeral port, probe REST and MCP, and exit",
      run: ["node", "simorgh-platform/src/runtimes/smoke.ts"],
      needs: ["SIMORGH_API_KEY"],
    },
    {
      id: "supervise",
      description: "Keep it running under a supervisor",
      manual:
        "node simorgh-platform/src/runtimes/node.ts --port 8788, wrapped in systemd (Restart=always), pm2, or your platform's supervisor. The process holds no durable state beyond its SQLite file, so a restart is always safe.",
      needs: ["SIMORGH_API_KEY"],
    },
    {
      id: "verify",
      description: "Confirm the supervised core answers at the address you chose",
      manual: "curl -fsS http://{origin}/health, and simorgh status to watch it join the fleet.",
    },
  ],
  notes:
    "No Workers AI here, so Homā is unavailable and the flock is only as available as its configured keys. The core reports that honestly rather than pretending: an unconfigured provider shows as dormant in /api/v1/flock/status.",
};

const BYO_ENDPOINT: DeploymentTarget = {
  id: "byo-endpoint",
  label: "An existing phoenix-core (bring your own)",
  runtime: "unknown",
  connectors: ["rest", "mcp"],
  endpoint: "{origin}",
  modes: ["manual"],
  secrets: [
    {
      name: "SIMORGH_API_KEY",
      description: "The bearer token that core expects, if it authenticates.",
      required: false,
    },
  ],
  steps: [],
  notes:
    "Nothing to deploy. Use this to point the platform at a core someone else runs — including one on a target you have not registered. `simorgh connect` checks reachability before recording it.",
};

const TARGETS: readonly DeploymentTarget[] = [CLOUDFLARE_WORKERS, NODE, BYO_ENDPOINT];

/** Every registered target, in a stable order. */
export function listTargets(): readonly DeploymentTarget[] {
  return TARGETS;
}

export function getTarget(id: string): DeploymentTarget {
  const found = TARGETS.find((t) => t.id === id);
  if (!found) {
    throw new Error(
      `Unknown target '${id}'. Known targets: ${TARGETS.map((t) => t.id).join(", ")}.`
    );
  }
  return found;
}

export const EXTENSION_POINT =
  "To add a target: ship its runtime entrypoint, then append a DeploymentTarget with a " +
  "step list that actually completes. A target whose steps cannot run is worse than none.";
