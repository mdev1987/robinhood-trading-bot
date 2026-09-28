export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: unknown;
  boosts?: { active?: number };
}

export interface Candidate {
  key: string;
  chain: "robinhood";
  poolAddress: string;
  pairAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  quoteSymbol: string;
  dexId: string;
  pair: DexScreenerPair;
  discoveredAt: number;
  poolCreatedAt: number;
}

export type PositionStatus = "OPEN" | "CLOSED";

export interface ExitProfile {
  tp: ReadonlyArray<{ gainPct: number; sellPct: number }>;
  initialStopPct: number;
  trailActivationPct: number;
  trailDistancePct: number;
  trailConfirmTicks: number;
  breakevenArmPct: number;
  breakevenBufferPct: number;
  breakevenAfterTp1: boolean;
  earlyStopPct: number;
  earlyStopWindowSec: number;
  maxPositionAgeMin: number;
  drainLiquidityPct: number;
  deadLiquidityUsd: number;
}

export interface Position {
  id: string;
  chain: "robinhood";
  pairAddress: string;
  tokenAddress: string;
  symbol: string;
  tokenName: string;
  quoteSymbol: string;
  dexId: string;
  pairUrl?: string;

  entryPrice: number;
  currentPrice: number;
  highestPrice: number;
  lowestPrice: number;
  highestAt: number;
  lowestAt: number;
  quantity: number;
  originalQuantity: number;
  initialUsdSize: number;

  realizedPnlUsd: number;
  totalEntryFeeUsd: number;
  totalExitFeeUsd: number;
  totalSlippageUsd: number;
  shadowFeeUsd: number;
  shadowSlipUsd: number;

  openedAt: number;
  updatedAt: number;
  closedAt?: number;
  closedReason?: string;
  exitTriggerPrice?: number;

  trailingActive: boolean;
  breakevenArmed: boolean;
  trailHigh?: number;
  highStreak?: number;
  status: PositionStatus;
  tpHit: [boolean, boolean, boolean];
  exitProfile?: ExitProfile;
  balanceBeforeUsd?: number;
  balanceAfterUsd?: number;
  poolAddress?: string;
  entryLiquidityUsd?: number;
  entryAgeSec?: number;
  exitLiquidityUsd?: number;
  /** Actual simulated/live final fill price used for close reporting. */
  finalExitPriceUsd?: number;
}

export interface PriceSnapshot {
  pair: DexScreenerPair;
  priceUsd: number;
  observedAt: number;
}

export type QuoteSource = "0x" | "uniswap-v2";

export interface Quote {
  source: QuoteSource;
  chain: "robinhood";
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount?: string;
  priceImpactPct: number | null;
  priceImpactSource?: "venue" | "approx" | "unknown";
  buyTaxBps?: number | null;
  sellTaxBps?: number | null;
  estimatedGasUnits?: number | null;
  zeroExFeeAmount?: string;
  zeroExFeeToken?: string;
  zeroExFeeType?: string;
  gasPriceWei?: string;
  /** Router-measured quote latency, set by getBestExecutableQuote. */
  quoteLatencyMs?: number;
  to: string;
  calldata: string;
  value: string;
  raw?: unknown;
}

export interface QuoteRequest {
  chain: "robinhood";
  sellToken: string;
  buyToken: string;
  sellAmountBaseUnits: string;
  taker: string;
  slippageBps: number;
  pairAddress?: string;
}

export interface SwapRequest {
  quote: Quote;
  slippageBps: number;
}

export interface ExecutionResult {
  ok: boolean;
  hash: string;
  sellAmount: string;
  buyAmount: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  executionLatencyMs?: number;
}

export interface SimulationResult {
  ok: boolean;
  reason?: string;
}

export interface LiveStrategyState {
  currentPrice: number;
  highestPrice: number;
  lowestPrice: number;
  highestAt: number;
  lowestAt: number;
  trailingActive: boolean;
  breakevenArmed: boolean;
  trailHigh?: number;
  highStreak?: number;
  tpHit: [boolean, boolean, boolean];
  exitProfile: ExitProfile;
  status: PositionStatus;
  updatedAt: number;
  closedAt?: number;
  closedReason?: string;
  exitTriggerPrice?: number;
}

export interface LivePosition {
  positionId: string;
  pairAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  dexId: string;
  pairUrl?: string;
  quoteSymbol: string;
  tokenDecimals: number;
  quoteToken: string;
  quoteDecimals: number;
  originalQtyRaw: string;
  remainingQtyRaw: string;
  entryCostQuoteRaw: string;
  entryCostUsd: number;
  entryPriceUsd: number;
  entryLiquidityUsd: number;
  entryAgeSec: number;
  entryGasUsd?: number;
  realizedPnlUsd: number;
  openedAt: number;
  updatedAt: number;
  strategy: LiveStrategyState;
}

export type LiveOrderStatus = "SIGNAL" | "SUBMITTED" | "CONFIRMED" | "APPLIED" | "FAILED" | "UNKNOWN";
export type LiveOrderSide = "BUY" | "SELL" | "TEST";
export type LiveOrderKind = "ENTRY" | "TP" | "EXIT" | "SMOKE";

export interface LiveOrder {
  id: string;
  positionId?: string;
  side: LiveOrderSide;
  kind: LiveOrderKind;
  /** Fill label distinguishing multiple sells per position (TP1..TP3, EXIT). */
  label?: string;
  status: LiveOrderStatus;
  tokenAddress: string;
  sellToken: string;
  buyToken: string;
  requestedSellRaw: string;
  tokenSymbol?: string;
  tokenName?: string;
  dexId?: string;
  pairAddress?: string;
  pairUrl?: string;
  quoteSymbol?: string;
  quoteDecimals?: number;
  entryPriceUsd?: number;
  entryEthUsd?: number;
  entryLiquidityUsd?: number;
  entryAgeSec?: number;
  preBuyBalanceRaw?: string;
  tokenDecimals?: number;
  exitProfile?: ExitProfile;
  txHash?: string;
  executedSellRaw?: string;
  executedBuyRaw?: string;
  gasUsd?: number;
  exitEthUsd?: number;
  exitPriceUsd?: number;
  realizedPnlUsd?: number;
  reason?: string;
  level?: 1 | 2 | 3;
  exitLiquidityUsd?: number;
  exitQuoteSymbol?: string;
  exitPairAddress?: string;
  exitTokenDecimals?: number;
  createdAt: number;
  updatedAt: number;
  note?: string;
}
