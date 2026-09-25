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
