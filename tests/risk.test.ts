import { test, expect } from "bun:test";
import { assessQuoteRisk } from "../src/execution/risk.ts";

const q:any = { sellAmount:"100", buyAmount:"90", to:"0x0000000000000000000000000000000000000001", calldata:"0x01", sellToken:"0x01", buyToken:"0x02" };

test("risk requires executable calldata", () => {
  expect(assessQuoteRisk({ ...q, calldata:"" }, { maxSlippageBps:100, maxTaxBps:100, maxImpactPct:5, requireExecutable:true }).pass).toBe(false);
});

test("risk rejects excessive tax", () => {
  expect(assessQuoteRisk({ ...q, buyTaxBps:500 }, { maxSlippageBps:100, maxTaxBps:100, maxImpactPct:5, requireExecutable:true }).pass).toBe(false);
});


test("unknown venue impact is explicit rather than silently passing the impact gate", () => {
  const result = assessQuoteRisk({ ...q, priceImpactPct: null, priceImpactSource: "unknown" }, { maxSlippageBps:100, maxTaxBps:100, maxImpactPct:5, requireExecutable:true });
  expect(result.pass).toBe(true);
  expect(result.reasons).not.toContain("price impact exceeds limit");
});
