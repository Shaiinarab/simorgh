import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import {
  hexToBytes,
  interactionCommand,
  interactionIdentity,
  parseDiscordInteraction,
  verifyDiscordSignature,
} from "../src/discord";
import { splitOutgoingMessage } from "../src/message-chunks";

// ── What this suite can and cannot prove ─────────────────────────────────────
//
// The flock is stubbed, the way `test/http.test.ts` does it: a real per-request
// provider call would make the suite slow and non-hermetic, and Homā is always-on by
// design. Everything else is real — the KV dedupe really stores, the rate limiter
// really counts, and **the signature verification really verifies**: the keypair below
// is generated inside workerd, the "Discord" signatures are real Ed25519 signatures
// over the exact bytes handed to the handler, and the check is the same call the
// handler makes. Nothing here agrees with a fixture of itself.
//
// The signature check is a detector, so it gets negative controls rather than only a
// happy path: a key the caller does not hold, a body altered after signing, and a
// signature belonging to a different body must each be refused.

let keyPair: CryptoKeyPair;
let publicKeyHex: string;

const hexOf = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // `exportKey` is typed `ArrayBuffer | JsonWebKey`; "raw" is always the former, and
  // the cast is the same one the Workers suite already makes elsewhere.
  publicKeyHex = hexOf(
    (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer
  );
});

/** Discord signs the timestamp string immediately followed by the raw body. */
const sign = async (
  timestamp: string,
  body: string,
  key: CryptoKey = keyPair.privateKey
): Promise<string> =>
  hexOf(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        key,
        new TextEncoder().encode(timestamp + body)
      )
    )
  );

function interactionBody(id: string, type: number, command?: string): string {
  return JSON.stringify({
    id,
    application_id: "app-1",
    type,
    token: "token-" + id,
    ...(type === 2
      ? {
          data: {
            id: "cmd",
            name: command ?? "ask",
            options: [{ name: "query", type: 3, value: "hello" }],
          },
        }
      : {}),
    member: { user: { id: "user-1" } },
  });
}

/** A `waitUntil` port that records the work so a test can await it deliberately. */
function recordingWork(): ExecutionContext & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const port = {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {
      // Not under test; the gateway's own catch already handles its failures.
    },
    props: {},
  };
  // The stub deliberately omits the runtime-only members of a Workers
  // `ExecutionContext` (`exports`, `tracing`, `abort`) — nothing in this suite calls
  // them, and a stub that implemented them would only be pretending.
  return port as unknown as ExecutionContext & { pending: Promise<unknown>[] };
}

const discordHeaders = (timestamp: string, signature: string) => ({
  "Content-Type": "application/json",
  "X-Signature-Ed25519": signature,
  "X-Signature-Timestamp": timestamp,
});

function fakeFlockNamespace(
  opts: { answer?: string; allowed?: boolean } = {}
): unknown {
  const answer = opts.answer ?? "stub-answer";
  const allowed = opts.allowed ?? true;
  return {
    idFromName: (name: string) => name,
    get: () => ({
      async runFlock(prompt: string, tools: string[]) {
        return {
          meta: {
            answered_by: "Stub (test)",
            bird_id: "stub",
            ai_model: "stub-model",
            flock_attempts: [{ birdId: "stub", ok: true }],
          },
          answer,
        };
      },
      async getFlockStatus() {
        return {
          birds: [
            {
              id: "stub",
              name: "Stub",
              provider: "test",
              model: "stub-model",
              dormant: true,
              status: "dormant",
              consecutiveFailures: 0,
              totalCalls: 0,
              totalFailures: 0,
              cooldownUntil: 0,
            },
          ],
          timestamp: 0,
        };
      },
      async sweepStale() {
        return 0;
      },
      async checkRateLimit(_key: string, limit: number, windowMs: number) {
        if (!allowed) {
          return { allowed: false, limit, remaining: 0, resetAt: Date.now() + windowMs };
        }
        return {
          allowed: true,
          limit,
          remaining: limit - 1,
          resetAt: Date.now() + windowMs,
        };
      },
    }),
  };
}

function testEnv(flock: unknown = fakeFlockNamespace(), publicKey?: string): Env {
  return {
    AI: env.AI,
    CONTEXT_STORE: env.CONTEXT_STORE,
    DATA_TRUST_VAULT: env.DATA_TRUST_VAULT,
    FLOCK_COORDINATOR: flock,
    ENVIRONMENT: env.ENVIRONMENT,
    DISCORD_PUBLIC_KEY: publicKey ?? publicKeyHex,
  } as unknown as Env;
}

describe("discord helpers", () => {
  it("splits at Discord's 2000-char limit, losslessly", () => {
    expect(splitOutgoingMessage("hello", 2000)).toEqual(["hello"]);
    const text = "a".repeat(5000);
    const chunks = splitOutgoingMessage(text, 2000);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers a newline boundary comfortably inside the window", () => {
    // a + "\n" + b is 2101 chars, so it must break; the newline sits at 1200, exactly at
    // the 60% floor of a 2000-char window, which is the last position that still counts
    // as "comfortably inside".
    const a = "a".repeat(1200);
    const b = "b".repeat(900);
    expect(splitOutgoingMessage(a + "\n" + b, 2000)).toEqual([a, b]);
  });

  it("decodes hex and rejects anything that is not hex", () => {
    expect(Array.from(hexToBytes("00ff")!)).toEqual([0, 255]);
    expect(hexToBytes("")).toBeNull();
    expect(hexToBytes("abc")).toBeNull(); // odd length
    expect(hexToBytes("zz")).toBeNull();
  });

  it("reads identity from a guild member or a DM user", () => {
    const guild = parseDiscordInteraction(interactionBody("helper-1", 2))!;
    expect(interactionIdentity(guild)).toBe("user-1");
    const dm = parseDiscordInteraction(
      JSON.stringify({ id: "helper-2", type: 2, token: "t", user: { id: "user-2" } })
    )!;
    expect(interactionIdentity(dm)).toBe("user-2");
  });

  it("descends one level of subcommand options", () => {
    const nested = parseDiscordInteraction(
      JSON.stringify({
        id: "helper-3",
        type: 2,
        token: "t",
        data: {
          name: "ask",
          options: [
            { name: "sub", type: 1, options: [{ name: "query", type: 3, value: "deep" }] },
          ],
        },
      })
    )!;
    const { command, argument } = interactionCommand(nested);
    expect(command).toBe("ask");
    expect(argument).toBe("deep");
  });

  it("rejects malformed and oversized interactions", () => {
    expect(parseDiscordInteraction("not-json")).toBeNull();
    expect(parseDiscordInteraction("x".repeat(64_001))).toBeNull();
    // A signature-verified body must still be a well-formed interaction.
    expect(parseDiscordInteraction(JSON.stringify({ id: "x" }))).toBeNull();
    expect(parseDiscordInteraction(JSON.stringify({ id: "x", type: 2 }))).toBeNull();
    expect(parseDiscordInteraction(JSON.stringify({ id: "x", type: 2, token: 1 }))).toBeNull();
  });
});

describe("discord signature verification", () => {
  it("verifies a real Ed25519 signature over timestamp + raw body", async () => {
    const body = interactionBody("sig-1", 1);
    const timestamp = "1700000000";
    const signature = await sign(timestamp, body);
    expect(await verifyDiscordSignature(publicKeyHex, signature, timestamp, body)).toBe(true);
  });

  it("refuses a signature made by a key the caller does not hold", async () => {
    const attacker = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const body = interactionBody("sig-2", 1);
    const timestamp = "1700000001";
    const signature = await sign(timestamp, body, attacker.privateKey);
    expect(await verifyDiscordSignature(publicKeyHex, signature, timestamp, body)).toBe(
      false
    );
  });

  it("refuses a body that was changed after signing", async () => {
    const body = interactionBody("sig-3", 1);
    const timestamp = "1700000002";
    const signature = await sign(timestamp, body);
    const tampered = body.replace("sig-3", "sig-4");
    expect(await verifyDiscordSignature(publicKeyHex, signature, timestamp, tampered)).toBe(
      false
    );
  });

  it("refuses a wrong-length key or signature instead of throwing", async () => {
    // A malformed key is a 401, not a 500: any of these would throw inside
    // importKey/verify, which would answer Discord's probe with a 500.
    expect(await verifyDiscordSignature("abcd", "ab", "1", "{}")).toBe(false);
    expect(await verifyDiscordSignature("z".repeat(64), "a".repeat(128), "1", "{}")).toBe(
      false
    );
    expect(await verifyDiscordSignature("g".repeat(64), "a".repeat(128), "1", "{}")).toBe(
      false
    );
    expect(await verifyDiscordSignature(publicKeyHex, "a".repeat(126), "1", "{}")).toBe(
      false
    );
  });
});

describe("discord interactions endpoint", () => {
  it("acknowledges PING without touching the flock", async () => {
    const body = JSON.stringify({ id: "ping-unique-1", type: 1, token: "t" });
    const timestamp = "1700000010";
    const response = await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      testEnv(),
      recordingWork()
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("returns 401 for a missing, forged, or mismatched signature", async () => {
    const body = JSON.stringify({ id: "ping-unique-2", type: 1, token: "t" });
    const timestamp = "1700000011";

    const post = (headers: Record<string, string>) =>
      app.fetch(
        new Request("https://simorgh.example/api/v1/discord/webhook", {
          method: "POST",
          headers,
          body,
        }),
        testEnv(),
        recordingWork()
      );

    // No signature at all — the probe a scanner hits first.
    expect((await post({ "Content-Type": "application/json" })).status).toBe(401);

    // A correctly-formed signature from a key we do not hold.
    const attacker = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const forged = await sign(timestamp, body, attacker.privateKey);
    expect((await post(discordHeaders(timestamp, forged))).status).toBe(401);

    // A genuine signature over a *different* body — the replayed-interaction case.
    const other = await sign(
      timestamp,
      JSON.stringify({ id: "ping-other", type: 1, token: "t" })
    );
    expect((await post(discordHeaders(timestamp, other))).status).toBe(401);
  });

  it("fails closed with 503 when no public key is configured", async () => {
    const body = JSON.stringify({ id: "ping-unique-3", type: 1, token: "t" });
    const timestamp = "1700000012";
    const response = await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      // An *empty* value, not `undefined`: the helper defaults to the suite key when the
      // binding is absent, so passing undefined would have tested the configured path
      // and asserted the wrong thing happily.
      testEnv(fakeFlockNamespace(), ""),
      recordingWork()
    );
    expect(response.status).toBe(503);
  });

  it("refuses a 405 rather than parsing a GET", async () => {
    // Called on the handler directly: the route is registered as POST-only, so Hono
    // answers a GET with a 404 before the handler exists. That absence is worth
    // asserting, and the handler's own method check is worth exercising — otherwise
    // neither is tested.
    const { handleDiscordWebhook } = await import("../src/discord");
    expect(
      (await handleDiscordWebhook(
        new Request("https://simorgh.example/api/v1/discord/webhook", { method: "GET" }),
        testEnv(),
        recordingWork()
      )).status
    ).toBe(405);
  });

  it("defers an application command, then edits the response with the answer", async () => {
    const sent: { method: string; url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        method: String(init?.method ?? "GET"),
        url: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 200 });
    });

    const body = interactionBody("cmd-unique-1", 2);
    const timestamp = "1700000020";
    const work = recordingWork();

    const response = await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      testEnv(),
      work
    );

    // The acknowledgement must land inside Discord's 3-second deadline, so the answer
    // is not in the response body at all — it is in the deferred work.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 5 });
    expect(sent).toEqual([]);

    await Promise.all(work.pending);

    const [edit] = sent;
    expect(edit.method).toBe("PATCH");
    // The first chunk edits the deferred acknowledgement rather than stacking a
    // second message under the loading state.
    expect(edit.url).toBe(
      "https://discord.com/api/v10/webhooks/app-1/token-cmd-unique-1/messages/@original"
    );
    expect(JSON.parse(edit.body)).toMatchObject({ content: "stub-answer" });
    // The answer is model-authored text, so a model-written mention must not ping.
    expect(JSON.parse(edit.body).allowed_mentions).toEqual({ parse: [] });
  });

  it("sends an over-long answer as a deferred edit plus follow-ups", async () => {
    const sent: { method: string; url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        method: String(init?.method ?? "GET"),
        url: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 200 });
    });

    const body = interactionBody("cmd-unique-2", 2);
    const timestamp = "1700000021";
    const work = recordingWork();

    await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      testEnv(fakeFlockNamespace({ answer: "b".repeat(4500) })),
      work
    );
    await Promise.all(work.pending);

    // 4500 chars over a 2000-char ceiling is three chunks: one edit, two follow-ups,
    // joined back to exactly what the flock answered.
    expect(sent.map((s) => s.method)).toEqual(["PATCH", "POST", "POST"]);
    const contents = sent.map((s) => JSON.parse(s.body).content as string);
    expect(contents.every((c) => c.length <= 2000)).toBe(true);
    expect(contents.join("")).toBe("b".repeat(4500));
  });

  it("answers /status inline from the real Durable Object", async () => {
    const body = interactionBody("cmd-unique-3", 2, "status");
    const timestamp = "1700000030";
    const response = await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      testEnv(),
      recordingWork()
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { type: number; data: { content: string } };
    expect(payload.type).toBe(4);
    expect(payload.data.content).toContain("Stub");
  });

  it("refuses a rate-limited caller without spending the flock", async () => {
    const body = interactionBody("cmd-unique-4", 2);
    const timestamp = "1700000040";
    const work = recordingWork();
    const response = await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      testEnv(fakeFlockNamespace({ allowed: false })),
      work
    );
    const payload = (await response.json()) as { type: number; data: { content: string } };
    expect(payload.data.content).toContain("Rate limit reached");
    expect(work.pending).toEqual([]);
  });

  it("refuses an interaction with no identifying user", async () => {
    const body = JSON.stringify({
      id: "cmd-unique-5",
      application_id: "app-1",
      type: 2,
      token: "t",
      data: { name: "ask", options: [{ name: "query", type: 3, value: "hi" }] },
    });
    const timestamp = "1700000050";
    const response = await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      testEnv(),
      recordingWork()
    );
    const payload = (await response.json()) as { type: number; data: { content: string } };
    expect(payload.data.content).toContain("without an identifying user");
  });

  it("answers a redelivered interaction once, and says so", async () => {
    const body = interactionBody("cmd-unique-6", 2, "status");
    const timestamp = "1700000060";
    const work = recordingWork();
    const first = await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      testEnv(),
      work
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      new Request("https://simorgh.example/api/v1/discord/webhook", {
        method: "POST",
        headers: discordHeaders(timestamp, await sign(timestamp, body)),
        body,
      }),
      testEnv(),
      recordingWork()
    );
    const payload = (await second.json()) as { data: { content: string } };
    expect(payload.data.content).toContain("already handled");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
