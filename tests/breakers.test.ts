import { describe, test, expect } from "bun:test";
import { isRepeatSymbol, recentStopCount } from "../src/breakers.ts";

describe("isRepeatSymbol", () => {
  test("flags open and closed same-chain symbols, case-insensitively", () => {
    expect(isRepeatSymbol(["Felis"], [], "robinhood", "felis")).toBe(true);
    expect(
      isRepeatSymbol(
        [],
        [{ chain: "robinhood", symbol: "Felis" }],
        "robinhood",
        "FELIS",
      ),
    ).toBe(true);
    expect(isRepeatSymbol([], [], "robinhood", "NewCoin")).toBe(false);
    // Different chain is a different exposure.
    expect(
      isRepeatSymbol(
        [],
        [{ chain: "solana", symbol: "Felis" }],
        "robinhood",
        "Felis",
      ),
    ).toBe(false);
    expect(isRepeatSymbol([], [], "robinhood", "   ")).toBe(false);
  });

  test("Felis regression: second CA under the same symbol is rejected", () => {
    // First Felis pool traded and closed; a new Felis pair/CA appears.
    const closed = [{ chain: "robinhood", symbol: "Felis" }];
    expect(isRepeatSymbol([], closed, "robinhood", "Felis")).toBe(true);
  });
});

describe("recentStopCount", () => {
  test("counts stop/drain reasons inside the window only", () => {
    const now = Date.now();
    const closed = [
      { id: "a", chain: "robinhood", symbol: "A", dexId: "d", pnlUsd: -1, pnlPct: -10, reason: "STOP_EXIT", durationMs: 1, openedAt: now - 1000, closedAt: now - 60_000 },
      { id: "b", chain: "robinhood", symbol: "B", dexId: "d", pnlUsd: 1, pnlPct: 10, reason: "TIME_EXIT", durationMs: 1, openedAt: now - 1000, closedAt: now - 60_000 },
      { id: "c", chain: "robinhood", symbol: "C", dexId: "d", pnlUsd: -1, pnlPct: -10, reason: "DRAIN_EXIT", durationMs: 1, openedAt: now - 1000, closedAt: now - 40 * 60_000 },
    ];
    expect(recentStopCount(closed, "robinhood", now, 30)).toBe(1);
  });
});
