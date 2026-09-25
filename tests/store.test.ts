import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadState, saveState } from "../src/store.ts";

test("state persistence is atomic and reloadable", () => {
  const dir = mkdtempSync("rh-bot-");
  const file = join(dir, "state.json");
  saveState(file, { version:1, savedAt:0, cashUsd:123, closedTrades:[], openPositions:[] });
  expect(loadState(file).cashUsd).toBe(123);
  rmSync(dir, { recursive:true, force:true });
});


test("state loader filters malformed open positions", () => {
  const dir = mkdtempSync("rh-bot-invalid-");
  const file = join(dir, "state.json");
  saveState(file, { version:1, savedAt:0, cashUsd:123, closedTrades:[], openPositions:[{ id:"bad", status:"CLOSED" }] as any });
  expect(loadState(file).openPositions).toHaveLength(0);
  rmSync(dir, { recursive:true, force:true });
});
