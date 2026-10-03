// Routing tests for the flock. No network, no Durable Object, no runtime bindings:
// `flyFlock` takes its providers, its context, and its cooldown lookup as arguments,
// so every branch of the policy can be driven directly — and below, the health
// lookups run against real SQLite rather than a stub, because the statements
// themselves are where the interesting bugs have been.
import { beforeEach, describe, expect, it } from "vitest";

import {
  describeFlock,
  flockRetryAfterSeconds,
  flyFlock,
  type FlyFlockDeps,
} from "../src/flock.ts";
import { HEALTH_SCHEMA, readAllHealth, readCooldown, recordObservation } from "../src/health.ts";
import type { Provider, ProviderCallResult, ProviderContext } from "../src/provider.ts";
import { openMemorySql } from "../src/node/index.ts";
import type { SqlPort } from "../src/ports.ts";

const NOW = 1_700_000_000_000;

interface FakeProviderOptions {
  requires?: string;
  result?: ProviderCallResult;
  throws?: boolean;
}

function fakeProvider(
  id: string,
  priority: number,
  options: FakeProviderOptions = {}
): Provider {
  return {
    id,
    name: id,
    provider: `${id}-provider`,
    model: `${id}-model`,
    priority,
    ...(options.requires ? { requires: options.requires } : {}),
    async call(): Promise<ProviderCallResult> {
      if (options.throws) throw new Error(`${id} exploded`);
      return options.result ?? { ok: true, answer: `${id}-answer` };
    },
  };
}

/** Deps wired to a real SQLite health table, so cooldown/record are the real code. */
function deps(
  sql: SqlPort,
  providers: readonly Provider[],
  options: { secrets?: Record<string, string>; now?: number; records?: string[] } = {}
): FlyFlockDeps {
  const now = options.now ?? NOW;
  const secrets = options.secrets ?? {};
  return {
    providers,
    ctx: {
      fetch: async () => {
        throw new Error("unexpected network call");
      },
      secret: (name: string) => secrets[name],
    },
    cooldownUntil: (id) => readCooldown(sql, id),
    record: (id, ok, error) => {
      options.records?.push(`${id}:${ok}:${error ?? ""}`);
      recordObservation(sql, id, ok, error === "rate_limit", now);
    },
    now,
  };
}

let sql: SqlPort;

beforeEach(() => {
  sql = openMemorySql().sql;
  sql.exec(HEALTH_SCHEMA);
});

describe("flyFlock — routing policy", () => {
  it("answers from the lowest priority number", async () => {
    const result = await flyFlock(
      "ping",
      deps(sql, [fakeProvider("late", 30), fakeProvider("early", 10)])
    );

    expect(result.meta.answered_by).toBe("early (early-provider)");
    expect(result.meta.bird_id).toBe("early");
    expect(result.meta.flock_attempts).toEqual([{ birdId: "early", ok: true }]);
  });

  it("falls through a failure to the next provider and records both", async () => {
    const records: string[] = [];
    const result = await flyFlock(
      "ping",
      deps(
        sql,
        [
          fakeProvider("flaky", 10, { result: { ok: false, error: "http_503" } }),
          fakeProvider("steady", 20),
        ],
        { records }
      )
    );

    expect(result.meta.flock_attempts).toEqual([
      { birdId: "flaky", ok: false, error: "http_503" },
      { birdId: "steady", ok: true },
    ]);
    expect(records).toEqual(["flaky:false:http_503", "steady:true:"]);
  });

  it("skips a provider whose secret is absent, without penalising it", async () => {
    const records: string[] = [];
    const result = await flyFlock(
      "ping",
      deps(
        sql,
        [
          fakeProvider("keyed", 10, { requires: "GROQ_API_KEY" }),
          fakeProvider("open", 20),
        ],
        { records, secrets: {} }
      )
    );

    expect(result.meta.flock_attempts).toEqual([
      { birdId: "keyed", ok: false, error: "dormant" },
      { birdId: "open", ok: true },
    ]);
    // The dormant provider is never dialled, so it must not be cooled down: a missing
    // key is a deployment fact, not a provider fault.
    expect(records).toEqual(["open:true:"]);
    expect(readCooldown(sql, "keyed")).toBe(0);
  });

  it("skips a provider that is still cooling down", async () => {
    recordObservation(sql, "hot", false, true, NOW); // 429 ⇒ 60s
    const cooldownUntil = readCooldown(sql, "hot");
    expect(cooldownUntil).toBe(NOW + 60_000);

    const result = await flyFlock(
      "ping",
      deps(sql, [fakeProvider("hot", 10), fakeProvider("cool", 20)])
    );

    expect(result.meta.flock_attempts).toEqual([
      { birdId: "hot", ok: false, error: "cooling_down" },
      { birdId: "cool", ok: true },
    ]);
  });

  it("reports exhaustion when no provider answers", async () => {
    const result = await flyFlock(
      "ping",
      deps(sql, [
        fakeProvider("a", 10, { result: { ok: false, error: "rate_limit" } }),
        fakeProvider("b", 20, { result: { ok: false, error: "http_500" } }),
      ])
    );

    expect(result.meta.answered_by).toBe("none");
    expect(result.meta.error).toBe("flock_exhausted");
    expect(result.meta.flock_attempts).toHaveLength(2);
  });

  it("treats an empty answer as a failure rather than a win", async () => {
    const result = await flyFlock(
      "ping",
      deps(sql, [
        fakeProvider("silent", 10, { result: { ok: true, answer: "" } }),
        fakeProvider("vocal", 20),
      ])
    );

    // A provider that returns ok with nothing in it has not answered anyone.
    expect(result.meta.bird_id).toBe("vocal");
  });
});

describe("describeFlock — the public status payload", () => {
  const providers = [
    fakeProvider("keyed", 10, { requires: "GROQ_API_KEY" }),
    fakeProvider("open", 20),
  ];

  it("marks a provider dormant from the live secret reader, not from its declaration", () => {
    const status = describeFlock(providers, {
      secret: () => undefined,
      health: [],
      now: NOW,
    });

    expect(status.birds.map((b) => [b.id, b.status, b.dormant])).toEqual([
      ["keyed", "dormant", true],
      ["open", "healthy", false],
    ]);
  });

  it("reports healthy once the secret is configured", () => {
    const status = describeFlock(providers, {
      secret: (name) => (name === "GROQ_API_KEY" ? "sk-live" : undefined),
      health: [],
      now: NOW,
    });

    expect(status.birds.map((b) => [b.id, b.status])).toEqual([
      ["keyed", "healthy"],
      ["open", "healthy"],
    ]);
  });

  it("surfaces persisted counters and cooldowns", () => {
    recordObservation(sql, "open", false, false, NOW);
    const status = describeFlock(providers, {
      secret: () => "sk-live",
      health: readAllHealth(sql),
      now: NOW,
    });

    expect(status.birds.find((b) => b.id === "open")).toMatchObject({
      status: "tired",
      consecutiveFailures: 1,
      totalCalls: 1,
      totalFailures: 1,
      cooldownUntil: NOW + 15_000,
    });
  });
});

describe("flyFlock — provider contract", () => {
  it("does not let a throwing provider escape the loop", async () => {
    // The shipped providers catch their own transport errors. This asserts the loop
    // survives one that does not, so a third-party provider cannot take the flock
    // down by throwing instead of returning a result.
    const result = await flyFlock(
      "ping",
      deps(sql, [fakeProvider("hostile", 10, { throws: true })])
    );

    expect(result.meta.answered_by).toBe("none");
  });
});

describe("ProviderContext", () => {
  it("hands a provider its fetch and its secret reader", async () => {
    let seenAuth: string | undefined;
    const provider: Provider = {
      id: "spy",
      name: "Spy",
      provider: "spy",
      model: "spy-model",
      priority: 1,
      requires: "GROQ_API_KEY",
      async call(_prompt, ctx: ProviderContext) {
        seenAuth = ctx.secret("GROQ_API_KEY");
        return { ok: true, answer: "ok" };
      },
    };

    await flyFlock("ping", deps(sql, [provider], { secrets: { GROQ_API_KEY: "sk-x" } }));
    expect(seenAuth).toBe("sk-x");
  });
});


// Story 5.5: the retry hint on an exhausted flock. The interesting cases are the ones
// where the honest answer is "no number at all", because a wrong number here does not
// merely mislead a human — it makes a client machine poll a problem it cannot fix.
describe("flockRetryAfterSeconds", () => {
  it("is null when nothing is cooling down", () => {
    // Dormant birds, or a fresh fleet: no cooldown means no reset to wait for.
    expect(flockRetryAfterSeconds([], NOW, 1)).toBeNull();
    expect(flockRetryAfterSeconds([0, 0], NOW, 1)).toBeNull();
  });

  it("names the soonest real cooldown, not the average or the last", () => {
    expect(
      flockRetryAfterSeconds([NOW + 300_000, NOW + 30_000, NOW + 120_000], NOW, 1)
    ).toBe(30);
  });

  it("ignores a cooldown that has already expired", () => {
    // An expired cooldown is not a reset time. Only future cooldowns bound the wait.
    expect(flockRetryAfterSeconds([NOW - 60_000], NOW, 1)).toBeNull();
    expect(flockRetryAfterSeconds([NOW - 60_000, NOW + 20_000], NOW, 1)).toBe(20);
  });

  it("clamps to the floor rather than emitting a zero that invites a hot loop", () => {
    // 100ms away would round to 0 seconds. `Retry-After: 0` tells a client to retry
    // immediately, which is precisely the behaviour backpressure exists to stop.
    expect(flockRetryAfterSeconds([NOW + 100], NOW, 1)).toBe(1);
    expect(flockRetryAfterSeconds([NOW + 100], NOW, 30)).toBe(30);
  });

  it("rounds up, so a client never retries before the reset", () => {
    expect(flockRetryAfterSeconds([NOW + 1_001], NOW, 1)).toBe(2);
    expect(flockRetryAfterSeconds([NOW + 2_000], NOW, 1)).toBe(2);
  });

  it("honours a per-host floor, which is why floorSeconds is not defaulted", () => {
    expect(flockRetryAfterSeconds([NOW + 5_000], NOW, 1)).toBe(5);
    expect(flockRetryAfterSeconds([NOW + 5_000], NOW, 10)).toBe(10);
  });
});
