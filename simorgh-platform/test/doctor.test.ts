// ── simorgh doctor ────────────────────────────────────────────────────────────
//
// These assert on `code` and on `report.ok`, never on prose. The wording of a
// diagnosis is meant to change as we learn what confuses operators; the codes are a
// contract the CLI's exit status and any future alerting depend on.
//
// Everything runs through a stub `fetch`, so no test here needs a running core, a
// network, or a port.

import { describe, expect, it } from "vitest";

import { diagnoseInstances, renderDoctor } from "../src/doctor.ts";
import type { CoreInstance } from "../src/fleet.ts";

interface Route {
  status: number;
  body: unknown;
}

/** A `FetchLike` driven by a path→route table. Unknown paths 404. */
function stubFetch(routes: Record<string, Route>) {
  return async (url: string) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const route = routes[path];
    if (!route) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    };
  };
}

function instance(id: string): CoreInstance {
  return { id, targetId: "node", endpoint: `http://${id}.test`, connector: "rest" };
}

/** A provider line as the core publishes it. */
function bird(id: string, status: "healthy" | "tired" | "dormant") {
  return {
    id,
    name: id,
    provider: "test",
    model: "test-model",
    priority: 1,
    dormant: status === "dormant",
    status,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    totalCalls: 0,
    totalFailures: 0,
  };
}

const HEALTHY_ROUTES: Record<string, Route> = {
  "/health": { status: 200, body: { status: "ok" } },
  "/api/v1/flock/status": {
    status: 200,
    body: { birds: [bird("homa", "healthy")], timestamp: 1 },
  },
};

const codes = (report: { diagnoses: { code: string }[] }) =>
  report.diagnoses.map((d) => d.code);

describe("diagnoseInstances — a healthy fleet", () => {
  it("reports no errors when the core is reachable and serving", async () => {
    const report = await diagnoseInstances([instance("good")], {
      fetch: stubFetch(HEALTHY_ROUTES),
    });

    expect(report.ok).toBe(true);
    expect(codes(report)).toEqual(["ok"]);
    expect(report.diagnoses[0]?.severity).toBe("ok");
  });
});

describe("diagnoseInstances — the unconfigured fleet", () => {
  it("calls an empty fleet a problem rather than an all-clear", async () => {
    // The whole value of this command is that a green result means something. A
    // fresh checkout with nothing connected is not green — it is not set up.
    const report = await diagnoseInstances([]);

    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["no-instances"]);
    expect(report.diagnoses[0]?.severity).toBe("error");
    expect(report.diagnoses[0]?.hint).toContain("simorgh connect");
  });
});

describe("diagnoseInstances — reachability, cause by cause", () => {
  it("names a refused connection as such, rather than just 'unreachable'", async () => {
    const report = await diagnoseInstances([instance("refused")], {
      fetch: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9000");
      },
    });

    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["connection-refused"]);
    expect(report.diagnoses[0]?.detail).toMatch(/ECONNREFUSED/);
  });

  it("diagnoses an unauthenticated status read on a core that answers /health", async () => {
    // The reachable-but-unreadable case: /health is open, so the core looks alive,
    // and the flock read is what 401s. That is a *different* fault from an
    // unreachable host, and the report has to say so rather than call it
    // "unreachable".
    const report = await diagnoseInstances([instance("half-open")], {
      fetch: stubFetch({
        "/health": { status: 200, body: { status: "ok" } },
        "/api/v1/flock/status": { status: 401, body: {} },
      }),
    });

    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["auth-unauthorized"]);
    expect(report.diagnoses[0]?.detail).toMatch(/http_401/);
  });

  it("distinguishes 401 from 503 when the core returns them directly", async () => {
    const four = await diagnoseInstances([instance("four-oh-one")], {
      fetch: stubFetch({ "/health": { status: 401, body: {} } }),
    });
    const five = await diagnoseInstances([instance("five-oh-three")], {
      fetch: stubFetch({ "/health": { status: 503, body: {} } }),
    });

    expect(codes(four)).toEqual(["auth-unauthorized"]);
    expect(codes(five)).toEqual(["auth-not-configured"]);
  });

  it("survives a fetch that throws a non-Error", async () => {
    // Fetch implementations in the wild throw strings and objects. `doctor` must turn
    // any of them into a finding; an unhandled throw here would be a stack trace in
    // place of a diagnosis.
    const report = await diagnoseInstances([instance("weird")], {
      fetch: async () => {
        throw "socket hang up";
      },
    });

    expect(report.ok).toBe(false);
    expect(report.diagnoses[0]?.detail).toMatch(/socket hang up/);
  });
});

describe("diagnoseInstances — the conditions that waste an afternoon", () => {
  it("flags a reachable core whose every provider is dormant", async () => {
    // The core answers /health, the fleet is green, and every request returns
    // flock_exhausted because no provider key is configured anywhere.
    const report = await diagnoseInstances([instance("dormant")], {
      fetch: stubFetch({
        "/health": { status: 200, body: { status: "ok" } },
        "/api/v1/flock/status": {
          status: 200,
          body: { birds: [bird("shahin", "dormant"), bird("bulbul", "dormant")], timestamp: 1 },
        },
      }),
    });

    expect(codes(report)).toEqual(["all-providers-dormant"]);
    expect(report.diagnoses[0]?.severity).toBe("warn");
    expect(report.diagnoses[0]?.detail).toMatch(/no provider keys/);
  });

  it("flags a flock that is entirely cooling down", async () => {
    const report = await diagnoseInstances([instance("tired")], {
      fetch: stubFetch({
        "/health": { status: 200, body: { status: "ok" } },
        "/api/v1/flock/status": {
          status: 200,
          body: { birds: [bird("shahin", "tired"), bird("homa", "tired")], timestamp: 1 },
        },
      }),
    });

    expect(codes(report)).toEqual(["all-providers-tired"]);
    expect(report.diagnoses[0]?.hint).toContain("provider");
  });

  it("does not flag dormant as a problem when at least one provider can answer", async () => {
    // This is the zero-KYC deployment: two keyed providers dormant, Homā serving.
    // Calling that unwell would make the diagnosis noise, and noise gets ignored.
    const report = await diagnoseInstances([instance("zero-kyc")], {
      fetch: stubFetch({
        "/health": { status: 200, body: { status: "ok" } },
        "/api/v1/flock/status": {
          status: 200,
          body: { birds: [bird("shahin", "dormant"), bird("homa", "healthy")], timestamp: 1 },
        },
      }),
    });

    expect(report.ok).toBe(true);
    expect(codes(report)).toEqual(["ok"]);
  });
});

describe("diagnoseInstances — a fleet is more than one core", () => {
  it("reports one instance's failure without hiding another's success", async () => {
    const report = await diagnoseInstances(
      [instance("good"), instance("refused")],
      {
        fetch: async (url: string) => {
          if (url.includes("refused")) {
            throw new Error("connect ECONNREFUSED");
          }
          const route = HEALTHY_ROUTES[url.replace(/^https?:\/\/[^/]+/, "")];
          if (!route) return { ok: false, status: 404, json: async () => ({}) };
          return { ok: true, status: route.status, json: async () => route.body };
        },
      }
    );

    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("ok");
    expect(codes(report)).toContain("connection-refused");
    expect(report.diagnoses.map((d) => d.subject)).toEqual(["good", "refused"]);
  });
});

describe("renderDoctor", () => {
  it("prints a code and a hint for every finding", async () => {
    const report = await diagnoseInstances([], {});
    const text = renderDoctor(report);

    expect(text).toContain("no-instances");
    expect(text).toContain("simorgh connect");
    expect(text).toContain("✗");
  });

  it("marks a healthy fleet with a tick and no hint", async () => {
    const report = await diagnoseInstances([instance("good")], {
      fetch: stubFetch(HEALTHY_ROUTES),
    });
    const text = renderDoctor(report);

    expect(text).toContain("✓");
    expect(text).not.toContain("→");
  });
});
