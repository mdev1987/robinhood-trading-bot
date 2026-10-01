import { test, expect } from "bun:test";
import { openPosition, updatePosition, trailingStopPrice } from "../src/position.ts";
import { robinhoodExitProfile } from "../src/config.ts";

function p() { return openPosition({ id:"rh:test", chain:"robinhood", pairAddress:"0x0000000000000000000000000000000000000001", tokenAddress:"0x0000000000000000000000000000000000000002", symbol:"TEST", tokenName:"Test", quoteSymbol:"WETH", dexId:"uniswap", marketPrice:100, usdSize:10, exitProfile:robinhoodExitProfile(), now:1 }); }

test("TP and trailing thresholds use RH profile", () => {
  const x = p();
  const ev = updatePosition(x, 131, 2, { liquidityUsd: 20_000 });
  expect(ev.some((e) => e.type === "TP")).toBe(true);
  expect(ev.some((e) => e.type === "TRAIL_ACTIVATED")).toBe(true);
  expect(trailingStopPrice(x)).toBeCloseTo(111.35, 2);
});

test("early stop is tighter than initial stop", () => {
  const x = p();
  const ev = updatePosition(x, 90, 2, { liquidityUsd: 20_000 });
  expect(ev.some((e) => e.type === "EARLY_EXIT")).toBe(true);
});

test("flat drift exits inactive instead of riding to the time stop", () => {
  const x = p();
  const t26m = 1 + 26 * 60_000;
  const ev = updatePosition(x, 105, t26m, { liquidityUsd: 20_000 });
  expect(ev.some((e) => e.type === "INACTIVE_EXIT")).toBe(true);
  expect(x.status).toBe("CLOSED");
});

test("inactivity exit spares TP1-banked and pre-window positions", () => {
  const worked = p();
  updatePosition(worked, 131, 2, { liquidityUsd: 20_000 });
  const t26m = 1 + 26 * 60_000;
  const evBanked = updatePosition(worked, 105, t26m, { liquidityUsd: 20_000 });
  expect(evBanked.some((e) => e.type === "INACTIVE_EXIT")).toBe(false);
  const fresh = p();
  const evEarly = updatePosition(fresh, 105, 1 + 10 * 60_000, { liquidityUsd: 20_000 });
  expect(evEarly.some((e) => e.type === "INACTIVE_EXIT")).toBe(false);
  expect(fresh.status).toBe("OPEN");
});


test("same-tick TP events report their own remaining quantity and realized PnL snapshot", () => {
  const x = p();
  const ev = updatePosition(x, 208, 2, { liquidityUsd: 20_000 });
  const tps = ev.filter((e): e is Extract<typeof e, { type: "TP" }> => e.type === "TP");

  expect(tps.map((e) => e.level)).toEqual([1, 2, 3]);
  expect(tps.map((e) => Math.round(e.remainingPct))).toEqual([75, 50, 25]);
  expect(tps[0]?.realizedPnlUsd).toBeLessThan(tps[1]?.realizedPnlUsd ?? Infinity);
  expect(tps[1]?.realizedPnlUsd).toBeLessThan(tps[2]?.realizedPnlUsd ?? Infinity);
  expect(x.quantity / x.originalQuantity * 100).toBeCloseTo(25, 8);
});
