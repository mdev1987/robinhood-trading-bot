import { test, expect } from "bun:test";
import { assessConfirmation } from "../src/dexscreener.ts";

test("confirmation rejects a material price slide", () => {
  expect(assessConfirmation({ price: 100, liquidityUsd: 20_000 }, { price: 94, liquidityUsd: 20_000 }, 5, 30).ok).toBe(false);
});

test("confirmation rejects a liquidity collapse", () => {
  expect(assessConfirmation({ price: 100, liquidityUsd: 20_000 }, { price: 101, liquidityUsd: 12_000 }, 5, 30).ok).toBe(false);
});

test("confirmation accepts non-deteriorating print", () => {
  expect(assessConfirmation({ price: 100, liquidityUsd: 20_000 }, { price: 103, liquidityUsd: 19_500 }, 5, 30).ok).toBe(true);
});
