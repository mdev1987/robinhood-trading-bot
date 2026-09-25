import { config } from "./config.ts";
import { SlidingWindowRateLimiter } from "./rate-limiter.ts";
import type { DexScreenerPair } from "./types.ts";

interface PairResponse {
  pairs?: DexScreenerPair[] | null;
}

const limiter = new SlidingWindowRateLimiter(config.dexScreener.maxRpm);

async function getJson<T>(url: URL): Promise<T> {
  await limiter.acquire();
  // Bounded: a hung DexScreener socket must never stall the price tracker
  // or the confirm worker past one poll interval.
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) throw new Error("DexScreener HTTP 429 rate limit");
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  return await response.json() as T;
}

export async function getPair(chain: string, pairAddress: string): Promise<DexScreenerPair | null> {
  const url = new URL(
    `${config.dexScreener.baseUrl}/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pairAddress)}`,
  );
  const data = await getJson<PairResponse>(url);
  return data.pairs?.[0] ?? null;
}

/**
 * Fetch many pair prices while keeping the documented endpoint request rate bounded.
 * The endpoint accepts one or multiple pair addresses for a chain.
 */
export async function getPairsByChain(
  chain: string,
  pairAddresses: string[],
): Promise<DexScreenerPair[]> {
  const unique = [...new Set(pairAddresses)].filter(Boolean);
  if (unique.length === 0) return [];

  const out: DexScreenerPair[] = [];
  for (let offset = 0; offset < unique.length; offset += config.dexScreener.batchSize) {
    const batch = unique.slice(offset, offset + config.dexScreener.batchSize);
    const path = batch.map((pair) => encodeURIComponent(pair)).join(",");
    const url = new URL(
      `${config.dexScreener.baseUrl}/latest/dex/pairs/${encodeURIComponent(chain)}/${path}`,
    );
    const data = await getJson<PairResponse>(url);
    out.push(...(data.pairs ?? []));
  }
  return out;
}

export function parsePrice(pair: DexScreenerPair): number | null {
  const price = Number(pair.priceUsd);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export interface ConfirmationQuote {
  price: number;
  /** Null when the venue didn't report liquidity — never treated as zero. */
  liquidityUsd: number | null;
}

/**
 * Two-snapshot entry confirmation (pure, unit-tested). Compares a re-quote
 * against the qualifying observation and rejects only deterioration: a
 * material price slide or liquidity collapse means the pool has already
 * begun failing. Rising/flat prints always pass — this is not momentum.
 * Unknown liquidity on either side skips the liquidity check (price still
 * applies) so an API omission can't veto an entry.
 */
export function assessConfirmation(
  first: ConfirmationQuote,
  second: ConfirmationQuote,
  maxPriceDropPct: number,
  maxLiqDropPct: number,
): { ok: boolean; reason?: string } {
  if (!Number.isFinite(second.price) || second.price <= 0) {
    return { ok: false, reason: "no-price" };
  }
  const priceDropPct = ((first.price - second.price) / first.price) * 100;
  if (priceDropPct > maxPriceDropPct) {
    return { ok: false, reason: `price-declining ${priceDropPct.toFixed(1)}%` };
  }
  const liqDropPct = first.liquidityUsd !== null && first.liquidityUsd > 0 && second.liquidityUsd !== null
    ? ((first.liquidityUsd - second.liquidityUsd) / first.liquidityUsd) * 100
    : 0;
  if (liqDropPct > maxLiqDropPct) {
    return { ok: false, reason: `liquidity-collapsing ${liqDropPct.toFixed(1)}%` };
  }
  return { ok: true };
}

/**
 * Venue liquidity USD, or null when the venue didn't report it. Missing is
 * *unknown*, not zero — callers must not treat it as drained.
 */
export function pairLiquidityUsd(pair: DexScreenerPair): number | null {
  const raw = pair.liquidity?.usd;
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
