import { test, expect } from "bun:test";
import { config, RH, isEntryPausedAt, parseHourSet } from "../src/config.ts";

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
