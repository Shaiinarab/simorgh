// Routing tests for the flock. No network, no Durable Object, no runtime bindings:
// `flyFlock` takes its birds, its env, and its cooldown lookup as arguments, so every
// branch of the routing policy can be driven directly.
//
// The alternative — testing routing through the Durable Object — would drag in a real
// Workers AI call on every case, because Homā is the always-on bird by design.
import { afterEach, describe, expect, it } from "vitest";
import { COOLDOWN_FAILURE_MS } from "../src/health";
import { FLOCK, flyFlock, type Bird, type FlyFlockDeps, type FlockEnv } from "../src/flock";

/** A deterministic stand-in for `env.AI`. Never touches the network. */
function fakeEnv(over: Partial<FlockEnv> = {}): FlockEnv {
  return {
    AI: { run: async () => ({ response: "homa-answer" }) } as unknown as Ai,
    ...over,
  };
}

interface FakeBirdOptions {
  keyEnv?: Bird["keyEnv"];
  result?: { ok: boolean; answer?: string; error?: string };
  throws?: boolean;
  answerDelayMS?: number;
}

interface CallLog {
  calls: string[];
}

function fakeBird(
  id: string,
  priority: number,
  opts: FakeBirdOptions = {},
  log: CallLog = { calls: [] }
): Bird {
  return {
    id,
    name: id,
    provider: `${id}-provider`,
    model: `${id}-model`,
    priority,
    ...(opts.keyEnv ? { keyEnv: opts.keyEnv } : {}),
    async call(): Promise<{ ok: boolean; answer?: string; error?: string }> {
      log.calls.push(id);
      if (opts.throws) throw new Error(`${id} exploded`);
      return opts.result ?? { ok: true, answer: `${id}-answer` };
    },
  };
}

/** Build the deps with sane recording defaults so each test states only what it cares about. */
function deps(
  birds: Bird[],
  opts: {
    env?: FlockEnv;
    cooldowns?: Record<string, number>;
    now?: number;
    log?: CallLog;
    records?: Array<[string, boolean, string | undefined]>;
  } = {}
): FlyFlockDeps {
  const cooldowns = opts.cooldowns ?? {};
  return {
    birds,
    env: opts.env ?? fakeEnv(),
    cooldownUntil: (id) => cooldowns[id] ?? 0,
    record: (id, ok, error) => opts.records?.push([id, ok, error]),
    now: opts.now ?? 1_000_000,
  };
}

describe("flyFlock — routing policy", () => {
  it("tries birds in priority order and stops at the first answer", async () => {
    const log: CallLog = { calls: [] };
    const records: Array<[string, boolean, string | undefined]> = [];
    // Registered out of order on purpose: routing must sort, not use array position.
    const result = await flyFlock(
      "hi",
      deps(
        [
          fakeBird("late", 90, { result: { ok: true, answer: "late-answer" } }, log),
          fakeBird("early", 5, { result: { ok: true, answer: "early-answer" } }, log),
        ],
        { log, records }
      )
    );

    expect(log.calls).toEqual(["early"]);
    expect(result.answer).toBe("early-answer");
    expect(result.meta.answered_by).toBe("early (early-provider)");
    expect(result.meta.bird_id).toBe("early");
    expect(result.meta.ai_model).toBe("early-model");
    expect(result.meta.flock_attempts).toEqual([{ birdId: "early", ok: true }]);
    expect(records).toEqual([["early", true, undefined]]);
  });

  it("falls through to the next bird when one fails, recording each attempt", async () => {
    const log: CallLog = { calls: [] };
    const result = await flyFlock(
      "hi",
      deps(
        [
          fakeBird("flaky", 1, { result: { ok: false, error: "http_503" } }, log),
          fakeBird("steady", 2, { result: { ok: true, answer: "steady-answer" } }, log),
        ],
        { log }
      )
    );

    expect(log.calls).toEqual(["flaky", "steady"]);
    expect(result.answer).toBe("steady-answer");
    expect(result.meta.flock_attempts).toEqual([
      { birdId: "flaky", ok: false, error: "http_503" },
      { birdId: "steady", ok: true },
    ]);
  });

  it("treats an empty answer as a miss and keeps looking", async () => {
    // A provider that returns 200 with no content has not answered. Stopping here
    // would hand the user an empty string while healthy birds sat unused.
    const log: CallLog = { calls: [] };
    const result = await flyFlock(
      "hi",
      deps(
        [
          fakeBird("mute", 1, { result: { ok: true, answer: "" } }, log),
          fakeBird("vocal", 2, { result: { ok: true, answer: "vocal-answer" } }, log),
        ],
        { log }
      )
    );

    expect(log.calls).toEqual(["mute", "vocal"]);
    expect(result.answer).toBe("vocal-answer");
  });

  it("surfaces flock_exhausted when every bird fails", async () => {
    const result = await flyFlock(
      "hi",
      deps([
        fakeBird("a", 1, { result: { ok: false, error: "http_500" } }),
        fakeBird("b", 2, { result: { ok: false, error: "http_500" } }),
      ])
    );

    expect(result.meta.error).toBe("flock_exhausted");
    expect(result.meta.answered_by).toBe("none");
    expect(result.meta.bird_id).toBeUndefined();
    expect(result.meta.flock_attempts).toHaveLength(2);
    expect(result.answer).toMatch(/tired/i);
  });

  it("skips a dormant bird without dialling it, and without charging it a failure", async () => {
    // The distinction that matters: a missing secret is a deployment fact, not a
    // provider fault. Dialling it would be pointless, and recording a failure would
    // cool down a bird that was never called.
    const log: CallLog = { calls: [] };
    const records: Array<[string, boolean, string | undefined]> = [];
    const result = await flyFlock(
      "hi",
      deps(
        [
          fakeBird("keyed", 1, { keyEnv: "GROQ_API_KEY" }, log),
          fakeBird("open", 2, { result: { ok: true, answer: "open-answer" } }, log),
        ],
        { env: fakeEnv(), log, records } // no GROQ_API_KEY in env
      )
    );

    expect(log.calls).toEqual(["open"]);
    expect(records).toEqual([["open", true, undefined]]);
    expect(result.meta.flock_attempts).toEqual([
      { birdId: "keyed", ok: false, error: "dormant" },
      { birdId: "open", ok: true },
    ]);
  });

  it("dialled a keyed bird once its secret is present", async () => {
    const log: CallLog = { calls: [] };
    await flyFlock(
      "hi",
      deps([fakeBird("keyed", 1, { keyEnv: "GROQ_API_KEY" }, log)], {
        env: fakeEnv({ GROQ_API_KEY: "sk-test" }),
        log,
      })
    );

    expect(log.calls).toEqual(["keyed"]);
  });

  it("skips a bird that is cooling down, and retries it once the cooldown expires", async () => {
    const now = 1_000_000;
    const log: CallLog = { calls: [] };
    const birds = [
      fakeBird("hot", 1, { result: { ok: true, answer: "hot-answer" } }, log),
      fakeBird("cold", 2, { result: { ok: true, answer: "cold-answer" } }, log),
    ];

    const during = await flyFlock(
      "hi",
      deps(birds, { log, now, cooldowns: { hot: now + COOLDOWN_FAILURE_MS } })
    );
    expect(log.calls).toEqual(["cold"]);
    expect(during.answer).toBe("cold-answer");
    expect(during.meta.flock_attempts[0]).toEqual({
      birdId: "hot",
      ok: false,
      error: "cooling_down",
    });

    log.calls.length = 0;
    const after = await flyFlock("hi", deps(birds, { log, now, cooldowns: { hot: now - 1 } }));
    expect(log.calls).toEqual(["hot"]);
    expect(after.answer).toBe("hot-answer");
  });

  it("lets a thrown provider error escape the routing loop (adapters must catch their own)", async () => {
    const records: Array<[string, boolean, string | undefined]> = [];
    const log: CallLog = { calls: [] };
    await expect(
      flyFlock(
        "hi",
        deps(
          [
            fakeBird("boom", 1, { throws: true }, log),
            fakeBird("survivor", 2, { result: { ok: true, answer: "survivor-answer" } }, log),
          ],
          { log, records }
        )
      )
    ).rejects.toThrow("boom exploded");

    // Documents real behaviour: the *adapter* is responsible for catching its own
    // transport errors (every built-in bird does). A bird that throws escapes the
    // routing loop — which is why the loop must not be the only line of defence.
    expect(records).toEqual([]);
  });

  it("passes rate_limit through to record() so the caller can back off longer", async () => {
    const records: Array<[string, boolean, string | undefined]> = [];
    await flyFlock(
      "hi",
      deps(
        [
          fakeBird("limited", 1, { result: { ok: false, error: "rate_limit" } }),
          fakeBird("ok", 2, { result: { ok: true, answer: "ok-answer" } }),
        ],
        { records }
      )
    );

    expect(records).toEqual([
      ["limited", false, "rate_limit"],
      ["ok", true, undefined],
    ]);
  });
});

describe("flyFlock — the real flock", () => {
  it("is ordered Shāhīn → Bulbul → Homā, with Homā key-free", () => {
    const sorted = [...FLOCK].sort((a, b) => a.priority - b.priority);
    expect(sorted.map((b) => b.id)).toEqual(["shahin", "bulbul", "homa"]);

    const homa = FLOCK.find((b) => b.id === "homa");
    expect(homa?.keyEnv).toBeUndefined();
  });

  it("delivers the zero-KYC guarantee: with no secrets at all, Homā still answers", async () => {
    // This is the product promise. Fake the AI binding, supply no keys, and the
    // flock must still return an answer — via Homā, the only bird that needs nothing.
    const result = await flyFlock("what is the server time?", deps(FLOCK, { env: fakeEnv() }));

    expect(result.meta.answered_by).toBe("Homā (Cloudflare Workers AI)");
    expect(result.answer).toBe("homa-answer");
    expect(result.meta.flock_attempts).toEqual([
      { birdId: "shahin", ok: false, error: "dormant" },
      { birdId: "bulbul", ok: false, error: "dormant" },
      { birdId: "homa", ok: true },
    ]);
  });
});

describe("flyFlock — real provider adapters", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("Shāhīn calls the Groq chat-completions shape and returns the message content", async () => {
    let seenURL = "";
    let seenAuth = "";
    let seenBody: { model?: string; messages?: { role: string; content: string }[] } = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenURL = String(input);
      seenAuth = new Headers(init?.headers).get("Authorization") ?? "";
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "groq-says-hi" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await flyFlock("ping", deps(FLOCK, { env: fakeEnv({ GROQ_API_KEY: "sk-test" }) }));

    expect(seenURL).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(seenAuth).toBe("Bearer sk-test");
    expect(seenBody.model).toBe("llama-3.3-70b-versatile");
    expect(seenBody.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(result.answer).toBe("groq-says-hi");
    expect(result.meta.bird_id).toBe("shahin");
  });

  it("turns a 429 into a rate_limit failure and falls through to the next bird", async () => {
    const records: Array<[string, boolean, string | undefined]> = [];
    globalThis.fetch = (async () =>
      new Response("slow down", { status: 429 })) as typeof fetch;

    const result = await flyFlock(
      "ping",
      deps(FLOCK, { env: fakeEnv({ GROQ_API_KEY: "sk-test" }), records })
    );

    expect(records[0]).toEqual(["shahin", false, "rate_limit"]);
    expect(result.meta.flock_attempts[0]).toEqual({
      birdId: "shahin",
      ok: false,
      error: "rate_limit",
    });
    // Bulbul has no token configured, so Homā is the one that picks it up.
    expect(result.meta.bird_id).toBe("homa");
  });

  it("records a transport throw from a real adapter as a failure, not an escape", async () => {
    // The built-in adapters catch their own transport errors. The routing loop above
    // only survives a throw because they do — assert the contract they hold up.
    const records: Array<[string, boolean, string | undefined]> = [];
    globalThis.fetch = (async () => {
      throw new TypeError("network unreachable");
    }) as typeof fetch;

    const result = await flyFlock(
      "ping",
      deps(FLOCK, { env: fakeEnv({ GROQ_API_KEY: "sk-test" }), records })
    );

    expect(records[0]?.[0]).toBe("shahin");
    expect(records[0]?.[1]).toBe(false);
    expect(records[0]?.[2]).toMatch(/network unreachable/);
    expect(result.meta.bird_id).toBe("homa");
  });
});
