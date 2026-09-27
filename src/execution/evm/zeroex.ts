import type { Quote, QuoteRequest } from "../../types.ts";
import { RH, config } from "../../config.ts";

const BASE = "https://api.0x.org/swap/allowance-holder/quote";
const EEEE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

interface ZeroExResponse {
  liquidityAvailable?: boolean;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  minBuyAmount?: string;
  gas?: string | number;
  tokenMetadata?: {
    buyToken?: { buyTaxBps?: string | number; sellTaxBps?: string | number };
    sellToken?: { buyTaxBps?: string | number; sellTaxBps?: string | number };
  };
  transaction?: { to?: string; data?: string; gas?: string | number; value?: string };
  allowanceTarget?: string;
  issues?: { allowance?: { spender?: string } | null; balance?: unknown; simulationIncomplete?: boolean };
}

function nativeAlias(value: string): string {
  return /^0x0{40}$/i.test(value) ? EEEE : value;
}

export function mapZeroExQuote(request: QuoteRequest, raw: ZeroExResponse): Quote {
  if (raw.liquidityAvailable === false) throw new Error("0x: liquidity unavailable");
  if (raw.issues?.balance) throw new Error("0x: insufficient taker balance");
  if (raw.issues?.simulationIncomplete === true) throw new Error("0x: quote simulation incomplete");
  const sellAmount = raw.sellAmount ?? "";
  const buyAmount = raw.buyAmount ?? "";
  const tx = raw.transaction ?? {};
  if (!sellAmount || !buyAmount || !tx.to || !tx.data) throw new Error("0x: incomplete executable quote");
  return {
    source: "0x",
    chain: RH.chain,
    sellToken: String(raw.sellToken ?? request.sellToken),
    buyToken: String(raw.buyToken ?? request.buyToken),
    sellAmount,
    buyAmount,
    ...(raw.minBuyAmount ? { minBuyAmount: raw.minBuyAmount } : {}),
    priceImpactPct: null,
    priceImpactSource: "unknown",
    buyTaxBps: raw.tokenMetadata?.buyToken?.buyTaxBps == null ? null : Number(raw.tokenMetadata.buyToken.buyTaxBps),
    sellTaxBps: raw.tokenMetadata?.sellToken?.sellTaxBps == null ? null : Number(raw.tokenMetadata.sellToken.sellTaxBps),
    estimatedGasUnits: tx.gas != null ? Number(tx.gas) : raw.gas != null ? Number(raw.gas) : null,
    to: tx.to,
    calldata: tx.data,
    value: tx.value ?? (request.sellToken.toLowerCase() === EEEE.toLowerCase() ? sellAmount : "0"),
    raw: { ...raw, allowanceTarget: raw.issues?.allowance?.spender ?? raw.allowanceTarget },
  };
}

export async function quote0x(request: QuoteRequest): Promise<Quote> {
  if (!config.live.zeroExKey) throw new Error("ZEROEX_API_KEY is not configured");
  const url = new URL(BASE);
  url.searchParams.set("chainId", String(RH.chainId));
  url.searchParams.set("sellToken", nativeAlias(request.sellToken));
  url.searchParams.set("buyToken", nativeAlias(request.buyToken));
  url.searchParams.set("sellAmount", request.sellAmountBaseUnits);
  url.searchParams.set("taker", request.taker);
  url.searchParams.set("slippageBps", String(request.slippageBps));
  const response = await fetch(url, {
    headers: { accept: "application/json", "0x-api-key": config.live.zeroExKey, "0x-version": "v2" },
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`0x HTTP ${response.status}: ${body.slice(0, 300)}`);
  return mapZeroExQuote(request, JSON.parse(body) as ZeroExResponse);
}
