import { describe, expect, it } from "vitest";
import { parseTelegramUpdate, splitTelegramMessage } from "../src/telegram";

describe("Telegram helpers", () => {
  it("preserves short messages", () => expect(splitTelegramMessage("hello")).toEqual(["hello"]));
  it("splits long messages without loss", () => { const text = "a".repeat(9000), chunks = splitTelegramMessage(text); expect(chunks.every((x) => x.length <= 4096)).toBe(true); expect(chunks.join("")).toBe(text); });
  it("prefers newline boundaries", () => { const a = "a".repeat(3000), b = "b".repeat(2000); expect(splitTelegramMessage(a + "\n" + b, 4096)).toEqual([a, b]); });
  it("rejects malformed updates", () => { expect(parseTelegramUpdate("not-json")).toBeNull(); expect(parseTelegramUpdate("x".repeat(64001))).toBeNull(); });
});
