import { describe, expect, it } from "vitest";

import type { FetchLike } from "@simorgh/phoenix-core";

import {
  addInstance,
  createFleet,
  instanceIdFor,
  removeInstance,
  type CoreInstance,
} from "../src/fleet.ts";

const instance = (id: string, endpoint = `https://${id}.example`): CoreInstance => ({
  id,
  targetId: "cloudflare-workers",
  endpoint,
  connector: "rest",
});

/** A core that answers everything, or fails in a specified way. */
function core(options: { health?: number; ask?: "ok" | "exhausted" | "down"; answer?: string } = {}) {
  return options;
}

function fetchFor(behaviour: Map<string, ReturnType<typeof core>>): FetchLike {
  return async (url) => {
    const host = new URL(url).host;
    const config = behaviour.get(host);
    if (!config || config.ask === "down") {
      throw new TypeError(`connect ECONNREFUSED ${host}`);
    }
    if (url.endsWith("/health")) {
      const status = config.health ?? 200;
      return {
        ok: status < 400,
        status,
        headers: { get: () => null },
        json: async () => ({ status: "ok" }),
      };
    }
    if (url.endsWith("/api/v1/flock/status")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ birds: [{ id: `${host}-homa`, status: "healthy" }], timestamp: 1 }),
      };
    }
    const exhausted = config.ask === "exhausted";
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        success: !exhausted,
        agentResponse: exhausted ? "" : (config.answer ?? `answer from ${host}`),
        meta: {
          answered_by: exhausted ? "none" : host,
          flock_attempts: [{ birdId: "homa", ok: !exhausted }],
          ...(exhausted ? { error: "flock_exhausted" } : {}),
        },
      }),
    };
  };
}

describe("createFleet.status", () => {
  it("aggregates the flock of every reachable core", async () => {
    const instances = [instance("a"), instance("b")];
    const fleet = createFleet(instances, {
      fetch: fetchFor(new Map([["a.example", core()], ["b.example", core()]])),
    });

    const reports = await fleet.status();
    expect(reports).toHaveLength(2);
    expect(reports[0]?.health.reachable).toBe(true);
    expect(reports[0]?.flock?.birds[0]?.id).toBe("a.example-homa");
  });

  it("reports an unreachable core without failing the others", async () => {
    const instances = [instance("a"), instance("b")];
    const fleet = createFleet(instances, {
      fetch: fetchFor(new Map([["a.example", core()], ["b.example", core({ ask: "down" })]])),
    });

    const reports = await fleet.status();
    expect(reports[0]?.health.reachable).toBe(true);
    expect(reports[1]?.health.reachable).toBe(false);
  });

  it("distinguishes reachable-but-unreadable from unreachable", async () => {
    const instances = [instance("a")];
    const fleet = createFleet(instances, {
      fetch: async (url) => {
        const status = url.endsWith("/health") ? 200 : 401;
        return {
          ok: status < 400,
          status,
          headers: { get: () => null },
          json: async () => ({}),
        };
      },
    });

    const [report] = await fleet.status();
    expect(report?.health.reachable).toBe(true);
    expect(report?.error).toContain("401");
  });
});

describe("createFleet.ask", () => {
  it("answers from the first core that can", async () => {
    const instances = [instance("a"), instance("b")];
    const fleet = createFleet(instances, {
      fetch: fetchFor(new Map([["a.example", core()], ["b.example", core()]])),
    });

    const outcome = await fleet.ask({ prompt: "hi" });
    expect(outcome.instance.id).toBe("a");
    expect(outcome.result.answer).toBe("answer from a.example");
  });

  it("fails over past a dead core and a core with an exhausted flock", async () => {
    const instances = [instance("dead"), instance("tired"), instance("alive")];
    const fleet = createFleet(instances, {
      fetch: fetchFor(
        new Map([
          ["dead.example", core({ ask: "down" })],
          ["tired.example", core({ ask: "exhausted" })],
          ["alive.example", core({ answer: "made it" })],
        ])
      ),
    });

    const outcome = await fleet.ask({ prompt: "hi" });
    expect(outcome.instance.id).toBe("alive");
    expect(outcome.result.answer).toBe("made it");
    expect(outcome.skipped).toEqual([
      { id: "dead", error: expect.stringContaining("ECONNREFUSED") },
      { id: "tired", error: "flock_exhausted" },
    ]);
  });

  it("honours a preference order without dropping the rest", async () => {
    const instances = [instance("a"), instance("b")];
    const fleet = createFleet(instances, {
      fetch: fetchFor(new Map([["a.example", core()], ["b.example", core()]])),
    });

    expect((await fleet.ask({ prompt: "hi" }, { prefer: ["b"] })).instance.id).toBe("b");
    // An unknown preference does not narrow the fleet.
    expect((await fleet.ask({ prompt: "hi" }, { prefer: ["nope"] })).instance.id).toBe("a");
  });

  it("names every failure when nothing answers", async () => {
    const instances = [instance("a"), instance("b")];
    const fleet = createFleet(instances, {
      fetch: fetchFor(new Map([["a.example", core({ ask: "down" })], ["b.example", core({ ask: "exhausted" })]])),
    });

    // Reporting only the last error would send the operator to the wrong core.
    await expect(fleet.ask({ prompt: "hi" })).rejects.toThrow(/a: .*b: flock_exhausted/);
  });
});

describe("instance bookkeeping", () => {
  it("upserts by id rather than duplicating a reconnected endpoint", () => {
    const first = addInstance([], instance("a"));
    const reconnected = addInstance(first, { ...instance("a"), apiKey: "new" });
    expect(reconnected).toHaveLength(1);
    expect(reconnected[0]?.apiKey).toBe("new");
  });

  it("removes by id and ignores an unknown one", () => {
    const instances = [instance("a"), instance("b")];
    expect(removeInstance(instances, "a").map((i) => i.id)).toEqual(["b"]);
    expect(removeInstance(instances, "zzz")).toHaveLength(2);
  });

  it("derives a stable handle from target and endpoint", () => {
    expect(instanceIdFor("node", "http://127.0.0.1:8788")).toBe("node:127.0.0.1:8788");
    expect(instanceIdFor("cloudflare-workers", "https://flock.workers.dev")).toBe(
      "cloudflare-workers:flock.workers.dev"
    );
    // A non-URL is used as written rather than throwing.
    expect(instanceIdFor("node", "localhost:9000")).toBe("node:localhost:9000");
  });
});
