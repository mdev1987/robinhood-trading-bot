import { config } from "../config.ts";
import type { Quote } from "../types.ts";

export interface RiskPolicy {
  maxSlippageBps: number;
  maxTaxBps: number;
  maxImpactPct: number;
  requireExecutable: boolean;
}

export const LIVE_BUY_POLICY: RiskPolicy = {
  maxSlippageBps: 100,
  maxTaxBps: 500,
  maxImpactPct: config.entry.maxImpactPct,
  requireExecutable: true,
};

export const LIVE_SELL_POLICY: RiskPolicy = {
  maxSlippageBps: 500,
  maxTaxBps: 500,
  maxImpactPct: 10,
  requireExecutable: true,
};

function positiveBigInt(value: string): bigint | null {
  try {
    if (!/^\d+$/.test(value)) return null;
    const n = BigInt(value);
    return n > 0n ? n : null;
  } catch { return null; }
}

export function assessQuoteRisk(quote: Quote, policy: RiskPolicy): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (policy.requireExecutable && (!/^0x[0-9a-fA-F]{40}$/.test(quote.to) || !/^0x[0-9a-fA-F]*$/.test(quote.calldata))) reasons.push("not-executable");
  if (!positiveBigInt(quote.sellAmount)) reasons.push("invalid-sell-amount");
  if (!positiveBigInt(quote.buyAmount)) reasons.push("invalid-buy-amount");
  for (const [name, bps] of [["buy-tax", quote.buyTaxBps], ["sell-tax", quote.sellTaxBps]] as const) {
    if (bps === undefined || bps === null) continue;
    if (!Number.isFinite(bps) || bps < 0) reasons.push(`${name}-unparseable`);
    else if (bps > policy.maxTaxBps) reasons.push(`${name}-${bps}bps`);
  }
  if (quote.priceImpactPct != null) {
    if (!Number.isFinite(quote.priceImpactPct) || quote.priceImpactPct < 0) reasons.push("impact-unparseable");
    else if (quote.priceImpactPct > policy.maxImpactPct) reasons.push(`impact-${quote.priceImpactPct.toFixed(2)}%`);
  }
  if (quote.minBuyAmount !== undefined) {
    try {
      const buy = BigInt(quote.buyAmount);
      const min = BigInt(quote.minBuyAmount);
      if (min < 0n || min > buy) reasons.push("invalid-minBuyAmount");
      else {
        const slippage = Number((buy - min) * 10_000n / buy);
        if (!Number.isFinite(slippage) || slippage > policy.maxSlippageBps) reasons.push("slippage-beyond-policy");
      }
    } catch { reasons.push("invalid-minBuyAmount"); }
  }
  return { pass: reasons.length === 0, reasons };
}
