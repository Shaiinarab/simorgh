// Does the Worker (workerd) actually resolve the workspace package?
//
// This looks like a trivial test and is not: the whole Phase-3 rewire depends on
// `@simorgh/phoenix-core` resolving *inside workerd*, not merely under Node. Vite
// pre-bundles dependencies in `node_modules`, and a workspace package whose entry is
// raw TypeScript is exactly the case that can resolve under Node and fail here — or
// worse, resolve and then be served untransformed. A one-import test settles it
// before the rewire commits to the dependency.

import { describe, expect, it } from "vitest";
import { byPriority, flyFlock, type Provider } from "@simorgh/phoenix-core";

function provider(id: string, priority: number, answer: string): Provider {
  return {
    id,
    name: id,
    provider: "test",
    model: "test-model",
    priority,
    async call() {
      return { ok: true, answer };
    },
  };
}

describe("phoenix-core under workerd", () => {
  it("resolves and runs the real engine inside the Workers pool", async () => {
    const result = await flyFlock("ping", {
      providers: [provider("b", 20, "B"), provider("a", 10, "A")],
      ctx: { fetch: globalThis.fetch, secret: () => undefined },
      cooldownUntil: () => 0,
      record: () => {},
      now: 0,
    });

    // Priority order, not array order — proves the engine's own logic is executing.
    expect(result.answer).toBe("A");
    expect(result.meta.bird_id).toBe("a");
    expect(result.meta.answered_by).toBe("a (test)");
  });

  it("sorts by priority through the exported helper", () => {
    expect(byPriority([provider("z", 30, ""), provider("a", 10, "")]).map((p) => p.id)).toEqual([
      "a",
      "z",
    ]);
  });
});
