import { type AgentTool } from "@simorgh/phoenix-core";
import { executeAgent } from "./agent-service";
import { formatFlockStatus, readFlockStatus } from "./flock";
import { splitOutgoingMessage } from "./message-chunks";

// ── Discord — the second chat gateway ────────────────────────────────────────
//
// This is ADR-0008's door 3, and the second instance of a pattern Telegram already
// proved. The host declares the shape; the engine still never learns which messenger
// is on the other end.
//
// Three things make Discord a genuinely different gateway rather than a rename, and
// each is verified against Discord's own documentation (2026-10-10) rather than
// assumed from Telegram's shape:
//
//   1. **The secret is an asymmetric signature, not a shared token.** Telegram signs
//      nothing: it sends `X-Telegram-Bot-Api-Secret-Token` and we compare it. Discord
//      *signs* `X-Signature-Timestamp + raw body` with the app's private key and we
//      verify against its public key. So the check is a `crypto.subtle.verify`, not a
//      constant-time string compare.
//   2. **401 is mandatory, and it is probed.** Discord sends invalid signatures as a
//      routine security check and **removes the interactions endpoint of any app that
//      answers one with a 200**. A handler that is relaxed here does not leak a
//      request, it loses the gateway.
//   3. **There is a hard 3-second deadline.** The initial response must land within
//      3 seconds or the interaction token is invalidated; the token is then good for
//      15 minutes of follow-ups. The flock answers slower than 3 seconds on a cold
//      bird, so this gateway *defers* (`type 5`, a loading state) and edits the
//      response when the answer arrives. Telegram never had to do this, because a
//      Telegram webhook has no such deadline.
//
// The one asymmetry worth stating plainly: **the Interactions Endpoint delivers slash
// commands and component interactions only.** Plain chat messages arrive over the
// Gateway (a persistent WebSocket), which this host does not open. So Discord is
// command-driven where Telegram is message-driven, and that is a platform difference,
// not a shortcut — the help text says so rather than implying /ask is the only way in.

const DISCORD_MAX_TEXT = 2000;
const DISCORD_BODY_LIMIT = 64_000;
const DISCORD_API = "https://discord.com/api/v10";

/** Interaction `type` values, from the interaction-object table. */
const TYPE_PING = 1;
const TYPE_APPLICATION_COMMAND = 2;

/** Callback `type` values, from the interaction-response object table. */
const CALLBACK_PONG = 1;
const CALLBACK_MESSAGE = 4;
const CALLBACK_DEFERRED = 5;

/**
 * The `waitUntil` half of a Workers `ExecutionContext`, as a port.
 *
 * The gateway owns the deferred work; the host owns the request lifetime. Threading
 * the whole context through would hand this module a runtime binding it does not
 * otherwise need, and `src/index.ts` already has the real one.
 */
export interface WaitUntilPort {
  waitUntil(promise: Promise<unknown>): void;
}

export interface DiscordOption {
  name?: string;
  value?: string | number | boolean;
  /** Subcommands and groups nest their real options one or more levels down. */
  options?: DiscordOption[];
}

export interface DiscordInteraction {
  id: string;
  type: number;
  token: string;
  application_id?: string;
  data?: { name?: string; options?: DiscordOption[] };
  /** Present in a guild. */
  member?: { user?: { id?: string } };
  /** Present in a direct message. */
  user?: { id?: string };
}

const HEX_PATTERN = /^[0-9a-f]+$/;

/**
 * Hex → bytes, or `null` for anything that is not even-length lowercase-or-upper hex.
 *
 * Returning `null` rather than throwing matters: the caller treats a malformed
 * signature or key as a *rejected request* (401), and an exception here would turn a
 * garbage header into a 500 — which is both the wrong answer to Discord and a worse
 * failure than a wrong one.
 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !HEX_PATTERN.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Import the app's public key, once per distinct key.
 *
 * `importKey` is cheap and this is not a correctness guard — it is one less thing to
 * redo on every delivery. The cache is keyed by the key itself, so rotating
 * `DISCORD_PUBLIC_KEY` cannot serve a stale key: a new key string is a new entry.
 */
const verifyKeys = new Map<string, CryptoKey>();

async function importVerifyKey(publicKeyHex: string): Promise<CryptoKey> {
  const cached = verifyKeys.get(publicKeyHex);
  if (cached) return cached;
  const raw = hexToBytes(publicKeyHex);
  if (!raw) throw new Error("discord_public_key_not_hex");
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  verifyKeys.set(publicKeyHex, key);
  return key;
}

/**
 * Verify Discord's Ed25519 signature.
 *
 * The signed message is the `X-Signature-Timestamp` value immediately followed by the
 * **exact request bytes**, with no separator — so the body must be verified as it
 * arrived, never after a JSON round-trip. Re-serializing would change the bytes and
 * reject every legitimate delivery.
 *
 * The host is a Worker, which has no `node:` import, so this is WebCrypto rather than
 * `node:crypto` — workerd implements Ed25519 and accepts the 32-byte raw form Discord
 * publishes, which is asserted by `test/discord.test.ts` with a signature generated
 * and verified in the real runtime rather than a fixture.
 */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string
): Promise<boolean> {
  const publicKey = hexToBytes(publicKeyHex);
  const signature = hexToBytes(signatureHex);
  if (!publicKey || !signature) return false;
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await importVerifyKey(publicKeyHex);
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    // A malformed key is a rejected request, never a 500.
    return false;
  }
}

export function parseDiscordInteraction(
  raw: string
): DiscordInteraction | null {
  if (raw.length > DISCORD_BODY_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const interaction = parsed as Partial<DiscordInteraction>;
  if (typeof interaction.id !== "string") return null;
  if (typeof interaction.type !== "number") return null;
  if (typeof interaction.token !== "string") return null;
  return parsed as DiscordInteraction;
}

/**
 * The invoking user, or `undefined` when Discord sent neither identity.
 *
 * `member.user.id` in a guild, `user.id` in a DM. A missing identity is a decision
 * point rather than a fallback case — see the handler on why it fails closed.
 */
export function interactionIdentity(
  interaction: DiscordInteraction
): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

/**
 * The command name and its string argument.
 *
 * Subcommands and groups nest: `/ask group name prompt` arrives as an option whose own
 * `options` hold the real value. Reading only the flat level would run the command with
 * an empty argument and reply to the wrong thing — a wrong-but-plausible answer, which
 * this repo treats as worse than a crash. So descend while there is exactly one nested
 * option, and stop there rather than guessing a shape Discord does not send.
 */
export function interactionCommand(interaction: DiscordInteraction): {
  command: string;
  argument: string;
} {
  let options: DiscordOption[] = Array.isArray(interaction.data?.options)
    ? interaction.data.options
    : [];
  while (options.length === 1 && Array.isArray(options[0]?.options)) {
    options = options[0].options ?? [];
  }
  const command = String(interaction.data?.name ?? "").toLowerCase();
  const option = options.find(
    (o) => typeof o?.value === "string" && typeof o?.name === "string"
  );
  const argument = typeof option?.value === "string" ? option.value.trim() : "";
  return { command, argument };
}

/**
 * `globalThis.fetch` is resolved at call time, on purpose: the Workers suite replaces
 * the global per test, and a captured reference would bypass every stub while the
 * tests still passed. Same rule `agent-service.ts` documents.
 */
async function discordApi(
  method: string,
  path: string,
  body: unknown
): Promise<void> {
  const response = await globalThis.fetch(DISCORD_API + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error("discord_" + method.toLowerCase() + "_http_" + response.status);
  }
}

function replyBody(content: string): {
  content: string;
  allowed_mentions: { parse: string[] };
} {
  return {
    // The answer is model-authored text. Without `allowed_mentions`, an `@everyone` or
    // a user mention the model echoed would ping from this app's own account — the
    // model writing into the app's voice. `parse: []` suppresses every mention.
    allowed_mentions: { parse: [] },
    content,
  };
}

/**
 * Deliver `text` as one interaction response.
 *
 * The first chunk *edits* the deferred acknowledgement, so the answer replaces the
 * loading state instead of stacking a second message under it. Remaining chunks are
 * genuine follow-ups, which is why the splitter has to be lossless rather than merely
 * short.
 */
async function sendDiscordReply(
  applicationId: string,
  token: string,
  text: string
): Promise<void> {
  const chunks = splitOutgoingMessage(text || "No answer returned.", DISCORD_MAX_TEXT);
  await discordApi(
    "PATCH",
    "/webhooks/" + applicationId + "/" + token + "/messages/@original",
    replyBody(chunks[0] ?? "")
  );
  for (const chunk of chunks.slice(1)) {
    await discordApi("POST", "/webhooks/" + applicationId + "/" + token, replyBody(chunk));
  }
}

const USAGE =
  "🦅 Simorgh on Discord\n\n" +
  "/ask <query> — ask the flock\n" +
  "/search <query> — search the web\n" +
  "/time — current server time\n" +
  "/status — flock health\n\n" +
  "Plain chat messages are not delivered to an Interactions Endpoint; use /ask.";

export async function handleDiscordWebhook(
  request: Request,
  env: Env,
  work: WaitUntilPort
): Promise<Response> {
  const publicKey = env.DISCORD_PUBLIC_KEY?.trim();
  if (!publicKey) {
    return Response.json(
      { ok: false, error: "discord_not_configured" },
      { status: 503 }
    );
  }

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  // The raw bytes, read once and verified before anything parses them.
  const rawBody = await request.text();
  if (rawBody.length > DISCORD_BODY_LIMIT) {
    return Response.json({ ok: false, error: "body_too_large" }, { status: 413 });
  }

  const signature = request.headers.get("X-Signature-Ed25519")?.trim() ?? "";
  const timestamp = request.headers.get("X-Signature-Timestamp")?.trim() ?? "";

  if (!(await verifyDiscordSignature(publicKey, signature, timestamp, rawBody))) {
    // 401, deliberately, and not a 403 or a 500: Discord's own security check sends
    // bad signatures and drops the endpoint of anything that answers them with a 2xx.
    return Response.json(
      { ok: false, error: "invalid_request_signature" },
      { status: 401 }
    );
  }

  const interaction = parseDiscordInteraction(rawBody);
  if (!interaction) {
    return Response.json({ ok: false, error: "invalid_interaction" }, { status: 400 });
  }

  if (interaction.type === TYPE_PING) {
    return Response.json({ type: CALLBACK_PONG });
  }

  // Discord redelivers when it has not seen a 200 in time, so the same interaction can
  // arrive more than once. The rate limiter would answer the duplicate, but the flock
  // would be paid for it twice.
  const dedupeKey = "discord_interaction_" + interaction.id;
  if (await env.CONTEXT_STORE.get(dedupeKey)) {
    return Response.json({
      type: CALLBACK_MESSAGE,
      data: replyBody("This interaction was already handled."),
    });
  }
  await env.CONTEXT_STORE.put(dedupeKey, "1", { expirationTtl: 86_400 });

  const identity = interactionIdentity(interaction);
  if (!identity) {
    // Fail closed. Without an identity the rate limiter can only key on the
    // interaction id — which is unique per delivery — so a caller who strips `user`
    // and `member` would get a fresh, empty budget on every attempt. An unidentifiable
    // interaction is refused rather than metered by nothing.
    return Response.json({
      type: CALLBACK_MESSAGE,
      data: replyBody("Discord sent this interaction without an identifying user."),
    });
  }
  const userId = "discord:" + identity;

  const limiter = env.FLOCK_COORDINATOR.get(env.FLOCK_COORDINATOR.idFromName("global"));
  const decision = await limiter.checkRateLimit(userId, 20, 60_000);

  if (!decision.allowed) {
    const seconds = Math.ceil((decision.resetAt - Date.now()) / 1000);
    return Response.json({
      type: CALLBACK_MESSAGE,
      data: replyBody(
        "Rate limit reached. Try again in about " + seconds + " seconds."
      ),
    });
  }

  if (interaction.type !== TYPE_APPLICATION_COMMAND) {
    // Components and modals are real interaction types, and answering them honestly is
    // better than deferring into a loading state that never resolves.
    return Response.json({
      type: CALLBACK_MESSAGE,
      data: replyBody("This interaction type is not supported yet."),
    });
  }

  // `data.name` is the command as registered — `ask`, not `/ask`. The leading slash is
  // what a Discord user types; it is not part of the payload.
  const { command, argument } = interactionCommand(interaction);

  if (command === "status") {
    // Local read, so it answers inline — no reason to take the deferred path and spend
    // a token for something the Durable Object can answer inside the 3-second budget.
    return Response.json({
      type: CALLBACK_MESSAGE,
      data: replyBody(formatFlockStatus(await readFlockStatus(env))),
    });
  }

  if (command !== "ask" && command !== "search" && command !== "time") {
    return Response.json({ type: CALLBACK_MESSAGE, data: replyBody(USAGE) });
  }
  if (command !== "time" && argument === "") {
    return Response.json({
      type: CALLBACK_MESSAGE,
      data: replyBody("Usage: /" + command + " <query>"),
    });
  }

  const prompt = command === "time" ? "What is the current server time?" : argument;
  // Typed as the engine's `AgentTool[]` rather than inferred: a bare `string[]` is not
  // assignable to the allow-list type, and the point of that type is that a caller
  // cannot name a tool the executor has never heard of.
  const tools: AgentTool[] =
    command === "search"
      ? ["search_web"]
      : command === "time"
        ? ["get_server_time"]
        : [];
  const applicationId = interaction.application_id ?? "";
  const requestId = "discord:" + interaction.id;

  // Defer now, answer later. Returning `type 5` acknowledges inside the 3-second
  // deadline and leaves the user a loading state; the flock's answer is written back
  // over the same interaction when it exists.
  work.waitUntil(
    (async () => {
      try {
        const result = await executeAgent(env, {
          prompt,
          tools,
          userId,
          tier: "Free-Volunteer",
          requestId,
        });
        await sendDiscordReply(applicationId, interaction.token, result.agentResponse);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "discord_interaction_error",
            error: String(error),
            interactionId: interaction.id,
          })
        );
        try {
          await sendDiscordReply(
            applicationId,
            interaction.token,
            "The flock hit an internal error. Please try again."
          );
        } catch {
          // Keep a failed reply from becoming an error storm against Discord.
        }
      }
    })()
  );

  return Response.json({ type: CALLBACK_DEFERRED });
}
