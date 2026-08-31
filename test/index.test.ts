import { describe, expect, it } from "vitest";

describe("Simorgh Edge Gateway — core contract", () => {
  it("exports the Hono app with expected routes", async () => {
    const mod = await import("../src/index");
    expect(mod.default).toBeDefined();
    expect(mod.FlockCoordinator).toBeDefined();
    expect(mod.DataTrustVault).toBeDefined();
  });

  it("the flock has Homā as the zero-KYC always-on bird", async () => {
    const { FLOCK } = await import("../src/flock");
    const homa = FLOCK.find((b) => b.id === "homa");
    expect(homa).toBeDefined();
    expect(homa?.keyEnv).toBeUndefined();
    expect(homa?.priority).toBe(30);
  });

  it("the flock sorts by priority (Shāhīn first, Homā last)", async () => {
    const { FLOCK } = await import("../src/flock");
    const sorted = [...FLOCK].sort((a, b) => a.priority - b.priority);
    expect(sorted[0].id).toBe("shahin");
    expect(sorted[sorted.length - 1].id).toBe("homa");
  });

  it("the model catalog lists all current birds", async () => {
    const { getModelCatalog } = await import("../src/models");
    const catalog = getModelCatalog();
    expect(catalog.length).toBe(3);
    expect(catalog.map((m) => m.birdId)).toEqual(
      expect.arrayContaining(["shahin", "bulbul", "homa"])
    );
  });

  it("findModelBird resolves by model id", async () => {
    const { findModelBird } = await import("../src/models");
    const found = findModelBird("cf-llama-3b");
    expect(found?.birdId).toBe("homa");
  });
});
