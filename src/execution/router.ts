import type { Quote, QuoteRequest } from "../types.ts";
import { assessQuoteRisk, LIVE_BUY_POLICY, LIVE_SELL_POLICY } from "./risk.ts";
import { quote0x } from "./evm/zeroex.ts";
import { quoteUniswapV2 } from "./evm/uniswap-v2.ts";
import { traderAddress } from "./evm/viem-client.ts";

export async function getBestExecutableQuote(request: QuoteRequest, side: "BUY" | "SELL"): Promise<Quote> {
  const policy = side === "BUY" ? LIVE_BUY_POLICY : LIVE_SELL_POLICY;
  const candidates: Quote[] = [];
  const errors: string[] = [];
  const attempt = async (name: string, fn: () => Promise<Quote>) => {
    try {
      const started = Date.now();
      const q = await fn();
      q.quoteLatencyMs = Date.now() - started;
      const risk = assessQuoteRisk(q, policy);
      if (!risk.pass) throw new Error(risk.reasons.join(","));
      candidates.push(q);
    } catch (e) { errors.push(`${name}: ${String(e).slice(0, 180)}`); }
  };
  // Direct V2 is checked first because the signal is a specific fresh Uniswap pool.
  // 0x remains the preferred aggregator for routes not executable directly.
  if (request.pairAddress) await attempt("uniswap-v2", () => quoteUniswapV2(request));
  await attempt("0x", () => quote0x(request));
  candidates.sort((a, b) => {
    const out = BigInt(b.buyAmount) - BigInt(a.buyAmount);
    if (out !== 0n) return out > 0n ? 1 : -1;
    const impactA = a.priceImpactPct ?? 1e9;
    const impactB = b.priceImpactPct ?? 1e9;
    if (impactA !== impactB) return impactA - impactB;
    return (a.estimatedGasUnits ?? 1e18) - (b.estimatedGasUnits ?? 1e18);
  });
  if (!candidates[0]) throw new Error(`No executable RH route: ${errors.join("; ")}`);
  return candidates[0];
}

export function makeQuoteRequest(args: {
  sellToken: string; buyToken: string; sellAmountBaseUnits: string; slippageBps: number; pairAddress?: string; taker?: string;
}): QuoteRequest {
  return { chain: "robinhood", sellToken: args.sellToken, buyToken: args.buyToken, sellAmountBaseUnits: args.sellAmountBaseUnits, taker: args.taker ?? traderAddress(), slippageBps: args.slippageBps, ...(args.pairAddress ? { pairAddress: args.pairAddress } : {}) };
}
