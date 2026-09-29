import { test, expect } from "bun:test";
import { assessConfirmation, buyRatio5m, isStaleLiquidity, priceChange5m } from "../src/dexscreener.ts";
import type { DexScreenerPair } from "../src/types.ts";

test("confirmation rejects a material price slide", () => {
  expect(assessConfirmation({ price: 100, liquidityUsd: 20_000 }, { price: 94, liquidityUsd: 20_000 }, 5, 30).ok).toBe(false);
});

test("confirmation rejects a liquidity collapse", () => {
  expect(assessConfirmation({ price: 100, liquidityUsd: 20_000 }, { price: 101, liquidityUsd: 12_000 }, 5, 30).ok).toBe(false);
});

test("confirmation accepts non-deteriorating print", () => {
  expect(assessConfirmation({ price: 100, liquidityUsd: 20_000 }, { price: 103, liquidityUsd: 19_500 }, 5, 30).ok).toBe(true);
});

function pairWith(overrides: Partial<DexScreenerPair>): DexScreenerPair {
  return {
    chainId: "robinhood", dexId: "uniswap", pairAddress: "0xpair",
    baseToken: { address: "0xbase", name: "B", symbol: "B" },
    quoteToken: { address: "0xquote", name: "Q", symbol: "WETH" },
    ...overrides,
  };
}

test("stale liquidity is byte-identical positive prints only", () => {
  expect(isStaleLiquidity(21655.24, 21655.24)).toBe(true);
  expect(isStaleLiquidity(21655.24, 21655.25)).toBe(false);
  expect(isStaleLiquidity(null, 21655.24)).toBe(false);
  expect(isStaleLiquidity(0, 0)).toBe(false);
});

test("buy ratio reads the 5m txn mix", () => {
  expect(buyRatio5m(pairWith({ txns: { m5: { buys: 26, sells: 22 } } }))).toBeCloseTo(26 / 48, 8);
  expect(buyRatio5m(pairWith({ txns: { m5: { buys: 1, sells: 9 } } }))).toBeCloseTo(0.1, 8);
  expect(buyRatio5m(pairWith({}))).toBe(null);
});

test("5m pump reads priceChange", () => {
  expect(priceChange5m(pairWith({ priceChange: { m5: 66.8 } }))).toBe(66.8);
  expect(priceChange5m(pairWith({}))).toBe(null);
});
