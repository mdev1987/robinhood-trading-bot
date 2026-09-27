import { test, expect } from "bun:test";
import { config, RH, isEntryPausedAt, isPoolEntryBandValid, parseHourSet } from "../src/config.ts";

test("Robinhood config is single-chain", () => {
  expect(RH.chain).toBe("robinhood");
  expect(RH.chainId).toBe(4663);
  expect(config.entry.maxOpenPositions).toBeLessThanOrEqual(3);
  expect(config.dexPaprika.minAgeSec).toBe(60);
  expect(config.dexPaprika.maxAgeSec).toBe(120);
});

test("paused hours parse", () => {
  const set = parseHourSet("20,21,22,23");
  expect(isEntryPausedAt(new Date("2026-01-01T20:00:00Z"), set)).toBe(true);
  expect(isEntryPausedAt(new Date("2026-01-01T03:00:00Z"), set)).toBe(false);
});

test("execution risk configuration is wired to the entry impact setting", () => {
  expect(config.entry.maxImpactPct).toBeGreaterThan(0);
});


test("final pool entry band is inclusive at the configured boundaries", () => {
  const now = 1_000_000_000;
  expect(isPoolEntryBandValid(now - config.dexPaprika.minAgeSec * 1000, config.dexPaprika.minLiquidityUsd, now)).toBe(true);
  expect(isPoolEntryBandValid(now - config.dexPaprika.maxAgeSec * 1000, config.dexPaprika.maxLiquidityUsd, now)).toBe(true);
  expect(isPoolEntryBandValid(now - (config.dexPaprika.maxAgeSec + 1) * 1000, config.dexPaprika.minLiquidityUsd, now)).toBe(false);
  expect(isPoolEntryBandValid(now - config.dexPaprika.minAgeSec * 1000, config.dexPaprika.minLiquidityUsd - 1, now)).toBe(false);
});
