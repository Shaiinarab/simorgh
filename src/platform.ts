// ── The connector matrix — every platform this deployment can talk to ─────────
//
// A connector is one platform, and it answers three questions:
//
//   1. what does it do for us?      → `summary`
//   2. how do we reach it?          → `surfaces`
//   3. what does it take to be on?  → `secrets`
//
// ── Why `status` has three values and not two ──
//
// `on` / `off` cannot tell "you forgot a key" apart from "nobody wrote the code".
// Those are different jobs for different people: the first is a secret to add, the
// second is an integration to build. Collapsing them means a panel that says `off`
// for both, and an operator who adds a token to a platform nothing calls — which is
// how a deployment ends up with a configured-but-dead connector and no way to see it.
//
// So the three states are `live`, `needs-secret`, and `not-wired`, and `not-wired`
// is derived from `wired: false` rather than from a missing secret. A connector with
// no runtime path in this repo is not "missing a key"; it is unbuilt, and it says so.
//
// ── Why the registry is data, not code ──
//
// The page renders it, the API serves it, and the test asserts the wiring, all from
// one array. A connector that exists only as HTML is a connector whose readiness no
// one can check, and the first thing to rot would be exactly the `live` badge.

import { AGENT_TOOLS, MAX_TOOL_ITERATIONS, MAX_TOOL_RESULT_CHARS } from "./agent";

export type ConnectorStatus = "live" | "needs-secret" | "not-wired";

/** One route in a deployment's surface. `auth` mirrors what the route enforces. */
export interface ConnectorSurface {
  method: "GET" | "POST";
  path: string;
  auth: boolean;
  note?: string;
}

export interface ConnectorSecretNeed {
  name: string;
  required: boolean;
  description: string;
}

export interface Connector {
  id: string;
  label: string;
  kind: "host" | "chat" | "forge";
  summary: string;
  /**
   * Does anything in *this* repository actually call the platform at runtime?
   * `false` is a statement about the code, not about the deployment — see the
   * header on why it must not be folded into "missing a secret".
   */
  wired: boolean;
  secrets: readonly ConnectorSecretNeed[];
  surfaces: readonly ConnectorSurface[];
  docs: string;
}

/**
 * The declared matrix.
 *
 * Every `surfaces` entry below names a route that exists in `src/index.ts` or
 * `src/telegram.ts` today, and every `secrets` entry names a key the code reads. A
 * connector whose surface list is aspirational would make the panel a wishlist, so
 * the list is kept to what is wired.
 */
export const CONNECTORS: readonly Connector[] = [
  {
    id: "cloudflare",
    label: "Cloudflare Workers",
    kind: "host",
    summary:
      "The host. Workers routes, two Durable Objects, a KV namespace, one cron trigger, and the Workers AI binding.",
    // Always wired: this process *is* the connector, which is what makes its
    // readiness a fact rather than a configuration question.
    wired: true,
    secrets: [],
    surfaces: [
      { method: "GET", path: "/health", auth: false },
      { method: "GET", path: "/dashboard", auth: false },
      {
        method: "GET",
        path: "/api/v1/flock/status",
        auth: false,
        note: "Open by design; see SECURITY.md AUTH-001",
      },
      { method: "POST", path: "/api/v1/agent/execute", auth: true },
      { method: "GET", path: "/api/v1/context/:refId", auth: true },
      { method: "GET", path: "/api/v1/user/:userId/logs", auth: true },
      { method: "GET", path: "/api/v1/quota", auth: true },
      { method: "GET", path: "/api/v1/schedule", auth: true },
      { method: "POST", path: "/api/v1/schedule", auth: true },
    ],
    docs: "docs/ARCHITECTURE.md",
  },
  {
    id: "telegram",
    label: "Telegram",
    kind: "chat",
    summary:
      "Operator chat: the bot answers commands and forwards prompts to the flock.",
    wired: true,
    secrets: [
      {
        name: "TELEGRAM_BOT_TOKEN",
        required: true,
        description: "Bot token from BotFather; without it no reply can be sent.",
      },
      {
        name: "TELEGRAM_WEBHOOK_SECRET",
        required: false,
        description:
          "Checked on every webhook delivery. Absent means the webhook is unauthenticated.",
      },
    ],
    surfaces: [
      {
        method: "POST",
        path: "/api/v1/telegram/webhook",
        auth: false,
        note: "Authenticated by the webhook secret header, not by bearer",
      },
    ],
    docs: "src/telegram.ts",
  },
  {
    id: "github",
    label: "GitHub",
    kind: "forge",
    summary:
      "Where the code and the CI live. Nothing in this Worker calls the GitHub API yet, so the connector is declared but unbuilt.",
    // The honesty hinge. A `GITHUB_TOKEN` present would still change nothing,
    // because no runtime path reads one — so claiming `needs-secret` here would
    // send an operator to add a token that no code consumes.
    wired: false,
    secrets: [
      {
        name: "GITHUB_TOKEN",
        required: true,
        description:
          "Fine-grained PAT, needed only once a runtime path exists to use it.",
      },
    ],
    surfaces: [],
    docs: ".github/",
  },
];

/** Trimmed, non-empty value of a secret by name; the registry's reader. */
function secretValue(env: Env, name: string): string | undefined {
  const raw = (env as unknown as Record<string, unknown>)[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export interface ConnectorSecretState extends ConnectorSecretNeed {
  present: boolean;
}

export interface ConnectorReadiness
  extends Omit<Connector, "secrets" | "wired"> {
  status: ConnectorStatus;
  /** Required names that are absent — the to-do list, empty when `live`. */
  missing: readonly string[];
  secrets: readonly ConnectorSecretState[];
}

/**
 * Derive each connector's state from the live environment.
 *
 * Precedence is deliberate: `not-wired` is checked *first*, so an unbuilt connector
 * cannot be reported as `needs-secret` merely because its secret happens to be
 * absent. Reversing the two would make the panel tell an operator to set a token for
 * an integration that does not exist — the exact wrong-but-plausible page this file
 * exists to prevent.
 */
export function connectorReadiness(env: Env): ConnectorReadiness[] {
  return CONNECTORS.map((connector) => {
    const secrets = connector.secrets.map((need) => ({
      ...need,
      present: secretValue(env, need.name) !== undefined,
    }));
    const missing = secrets
      .filter((s) => s.required && !s.present)
      .map((s) => s.name);

    const status: ConnectorStatus = !connector.wired
      ? "not-wired"
      : missing.length > 0
        ? "needs-secret"
        : "live";

    return { ...connector, status, missing, secrets };
  });
}

// ── The tool surface ─────────────────────────────────────────────────────────

export interface ToolSurface {
  name: string;
  kind: "agent-tool" | "budget";
  detail: string;
}

/**
 * What this deployment can actually be asked to do.
 *
 * Re-exported from `phoenix-core` rather than retyped, so the panel cannot drift
 * from the allow-list the executor vets against: a tool showing on the dashboard and
 * absent from `AGENT_TOOLS` would be a tool the panel offered and the boundary
 * refused.
 */
export function toolSurface(): ToolSurface[] {
  return [
    ...AGENT_TOOLS.map(
      (name): ToolSurface => ({
        name,
        kind: "agent-tool",
        detail: "Allow-listed; results are folded back as untrusted data.",
      })
    ),
    {
      name: `≤${MAX_TOOL_ITERATIONS} iterations`,
      kind: "budget",
      detail: "Tool-call cap per request.",
    },
    {
      name: `≤${MAX_TOOL_RESULT_CHARS} chars/result`,
      kind: "budget",
      detail: "Tool output folded into the next prompt.",
    },
  ];
}
