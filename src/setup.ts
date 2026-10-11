// ── First-run setup — validating a provider key without ever keeping it ───────
//
// The setup wizard's promise is "paste a provider key and the flock wakes up".
// The honest version of that promise has a hard edge: **a browser cannot set a
// Cloudflare secret**, and it must never be able to. So this module does the one
// thing that is both useful and safe:
//
//   validate the pasted key against the real provider API, live, and hand the
//   operator the exact `wrangler secret put` command that makes it permanent.
//
// The key is therefore *transient*: it arrives, it is used once against one URL
// out of the table below, and it is dropped. It is never written to KV, never
// logged, and never echoed back — not even redacted, because a redacted echo
// still teaches an attacker which characters matched.
//
// ── Why the URLs are a table and not user input ──
//
// An endpoint that dialled a caller-supplied URL would be SSRF, and this repo
// already carries SSRF-001 as an open HIGH finding. So `provider` is a key into
// `PROVIDER_KEY_CHECKS` and the URL comes from *our* table. A caller asking for a
// provider that is not in it gets a refusal, not a request.
//
// Every URL below was probed live with a deliberately invalid key on 2026-10-11,
// with a bogus path as the control (401/400 = the endpoint exists and validates;
// 404 would have meant we were reading a 404 body as a rejection).

import type { HeaderLike } from "@simorgh/phoenix-core";

export interface ProviderKeyCheck {
  /** The `Env` binding name this key will become. */
  secret: string;
  /** What the operator sees. */
  label: string;
  /** Where a key is obtained, for the panel's help text. */
  signup: string;
  method: "GET";
  url: string;
  /** How the key travels: bearer header, or query parameter. */
  via: "bearer" | "query";
  /**
   * What a *good* key looks like, so a 200 can be described rather than just
   * asserted. `note` is what the panel shows on success.
   */
  note: string;
}

/**
 * The four activate-a-bird keys, and how to check each one.
 *
 * Homā is absent on purpose: it is the Workers AI binding, it needs no key, and it
 * is what makes a zero-secret deployment answer at all. A row for it would tell an
 * operator to go and get a key that does not exist.
 */
export const PROVIDER_KEY_CHECKS: readonly ProviderKeyCheck[] = [
  {
    secret: "GROQ_API_KEY",
    label: "Groq",
    signup: "console.groq.com/keys",
    method: "GET",
    url: "https://api.groq.com/openai/v1/models",
    via: "bearer",
    note: "Shāhīn flies on this one — the free tier is the flock's workhorse.",
  },
  {
    secret: "GEMINI_API_KEY",
    label: "Google Gemini",
    signup: "aistudio.google.com/apikey",
    method: "GET",
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    via: "query",
    note: "Free tier via AI Studio; no card for the key itself.",
  },
  {
    secret: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    signup: "openrouter.ai/keys",
    method: "GET",
    url: "https://openrouter.ai/api/v1/key",
    via: "bearer",
    note: "One key, many models — including the :free variants.",
  },
  {
    secret: "HF_TOKEN",
    label: "Hugging Face",
    signup: "huggingface.co/settings/tokens",
    method: "GET",
    url: "https://huggingface.co/api/whoami-v2",
    via: "bearer",
    note: "Read token is enough for inference on the free tier.",
  },
];

export interface ValidationResult {
  ok: boolean;
  /** A one-line, key-free explanation. Never contains the key. */
  detail: string;
}

/** Resolve a caller's provider name to a check, or `undefined`. */
export function findProviderKeyCheck(
  provider: string
): ProviderKeyCheck | undefined {
  const wanted = provider.trim().toLowerCase();
  return PROVIDER_KEY_CHECKS.find(
    (c) => c.label.toLowerCase() === wanted || c.secret.toLowerCase() === wanted.toLowerCase()
  );
}

/**
 * Validate one key against its provider.
 *
 * `http` is injected rather than reaching for `globalThis.fetch` at module scope so
 * the test can drive the branch table without a network — but it resolves at call
 * time in the host, the same rule `agent-service.ts` documents, so the Workers
 * suite's global stubs are honoured.
 */
export async function validateProviderKey(
  http: typeof fetch,
  provider: string,
  key: string
): Promise<ValidationResult> {
  const check = findProviderKeyCheck(provider);
  if (!check) {
    return {
      ok: false,
      detail: "No such provider. Choose one from the list.",
    };
  }

  const trimmed = key.trim();
  if (trimmed === "") {
    return { ok: false, detail: "Paste a key first." };
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  let url = check.url;
  if (check.via === "bearer") {
    headers.Authorization = "Bearer " + trimmed;
  } else {
    url = check.url + "?key=" + encodeURIComponent(trimmed);
  }

  try {
    const response = await http(url, { method: check.method, headers });
    if (response.ok) return { ok: true, detail: check.note };

    // The status is the whole message: a key that is present but rejected reads
    // differently from one that is rate-limited, and both differ from "the provider
    // is down", which is not the operator's fault and must not read as theirs.
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: "Rejected — that key is not valid." };
    }
    if (response.status === 429) {
      return {
        ok: false,
        detail: "Rate-limited while checking. Wait a moment and try again.",
      };
    }
    return {
      ok: false,
      detail:
        "Could not check it right now (provider answered " +
        response.status +
        "). Try again shortly.",
    };
  } catch {
    // Network failure is not a bad key, and must not be reported as one.
    return {
      ok: false,
      detail: "Could not reach the provider to check it. Try again shortly.",
    };
  }
}

/**
 * The command that makes a validated key permanent — generated, never guessed,
 * so the operator cannot get the binding name wrong.
 */
export function secretPutCommand(secret: string): string {
  return "wrangler secret put " + secret;
}

/** Rows for the setup panel, as an embeddable island. */
export interface SetupProviderRow {
  secret: string;
  label: string;
  signup: string;
  command: string;
}

export function setupProviderRows(): SetupProviderRow[] {
  return PROVIDER_KEY_CHECKS.map((c) => ({
    secret: c.secret,
    label: c.label,
    signup: c.signup,
    command: secretPutCommand(c.secret),
  }));
}

export type { HeaderLike };
