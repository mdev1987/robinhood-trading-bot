import { describe, test, expect } from "bun:test";
import { enqueueLiveSell, isRevertError, nextSellSlippageBps, sellRetryDelayMs } from "../src/live.ts";
import type { PendingLiveSell } from "../src/live.ts";

function item(overrides: Partial<PendingLiveSell> = {}): Omit<PendingLiveSell, "attempts" | "nextAttemptAt"> {
  return {
    positionId: "p1",
    kind: "TP",
    level: 1,
    label: "TP1",
    ...overrides,
  };
}

describe("nextSellSlippageBps", () => {
  test("escalates without exceeding the configured 500bps ceiling", () => {
    expect(nextSellSlippageBps(300, 0)).toBe(300);
    expect(nextSellSlippageBps(300, 1)).toBe(400);
    expect(nextSellSlippageBps(300, 2)).toBe(500);
    expect(nextSellSlippageBps(300, 9)).toBe(500);
    expect(nextSellSlippageBps(450, 2)).toBe(500);
  });
});

describe("sellRetryDelayMs", () => {
  test("backs off linearly", () => {
    expect(sellRetryDelayMs(0)).toBe(5000);
    expect(sellRetryDelayMs(2)).toBe(15000);
  });
});

describe("isRevertError", () => {
  test("distinguishes deterministic reverts from unknown failures", () => {
    expect(isRevertError(new Error("RH SELL: transaction reverted 0xabc"))).toBe(true);
    expect(isRevertError("execution reverted: overflow")).toBe(true);
    expect(isRevertError(new Error("probe timeout"))).toBe(false);
    expect(isRevertError(new Error("DexScreener HTTP 429 rate limit"))).toBe(false);
  });
});

describe("enqueueLiveSell", () => {
  test("same label twice is one intent; EXIT supersedes pending TPs", () => {
    const first = enqueueLiveSell([], item());
    expect(first.enqueued).toBe(true);
    const dup = enqueueLiveSell(first.queue, item());
    expect(dup.enqueued).toBe(false);
    expect(dup.queue).toHaveLength(1);
    const tp2 = enqueueLiveSell(first.queue, item({ label: "TP2", level: 2 }));
    expect(tp2.enqueued).toBe(true);
    expect(tp2.queue).toHaveLength(2);
    const exitItem: Omit<PendingLiveSell, "attempts" | "nextAttemptAt"> = {
      positionId: "p1",
      kind: "EXIT",
      label: "EXIT",
    };
    const exit = enqueueLiveSell(tp2.queue, exitItem);
    expect(exit.enqueued).toBe(true);
    expect(exit.queue.map((q) => q.label)).toEqual(["EXIT"]);
  });
});
