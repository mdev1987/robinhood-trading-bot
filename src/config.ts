import type { ExitProfile } from "./types.ts";

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number: ${name}=${raw}`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function parseHourSet(raw: string | undefined): Set<number> {
  const set = new Set<number>();
  if (!raw?.trim()) return set;
  for (const part of raw.split(",")) {
    const hour = Number(part.trim());
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error(`Invalid ENTRY_PAUSED_HOURS_UTC hour: ${part}`);
    }
    set.add(hour);
  }
  return set;
}

export function isEntryPausedAt(now: Date, pausedHoursUtc: Set<number>): boolean {
  return pausedHoursUtc.has(now.getUTCHours());
}

export function isPoolEntryBandValid(
  poolCreatedAtMs: number,
  liquidityUsd: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!Number.isFinite(poolCreatedAtMs) || !Number.isFinite(nowMs)) return false;
  if (liquidityUsd === null || liquidityUsd === undefined || !Number.isFinite(liquidityUsd)) return false;

  const ageSec = (nowMs - poolCreatedAtMs) / 1000;
  return ageSec >= config.dexPaprika.minAgeSec
    && ageSec <= config.dexPaprika.maxAgeSec
    && liquidityUsd >= config.dexPaprika.minLiquidityUsd
    && liquidityUsd <= config.dexPaprika.maxLiquidityUsd;
}

const RH_EXIT: ExitProfile = {
  tp: [
    { gainPct: num("TP1_PCT", 30), sellPct: num("TP1_SELL_PCT", 25) },
    { gainPct: num("TP2_PCT", 60), sellPct: num("TP2_SELL_PCT", 25) },
    { gainPct: num("TP3_PCT", 100), sellPct: num("TP3_SELL_PCT", 25) },
  ],
  initialStopPct: num("INITIAL_STOP_PCT", 15),
  trailActivationPct: num("TRAIL_ACTIVATION_PCT", 30),
  trailDistancePct: num("TRAIL_DISTANCE_PCT", 15),
  trailConfirmTicks: num("TRAIL_CONFIRM_TICKS", 1),
  breakevenArmPct: num("BREAKEVEN_ARM_PCT", 20),
  breakevenBufferPct: num("BREAKEVEN_BUFFER_PCT", 3),
  breakevenAfterTp1: bool("BREAKEVEN_AFTER_TP1", true),
  earlyStopPct: num("EARLY_STOP_PCT", 10),
  earlyStopWindowSec: num("EARLY_STOP_WINDOW_S", 180),
  maxPositionAgeMin: num("MAX_POSITION_AGE_MIN", 60),
  drainLiquidityPct: num("DRAIN_LIQUIDITY_PCT", 25),
  deadLiquidityUsd: num("DEAD_LIQUIDITY_USD", 25),
};

export const RH = {
  chain: "robinhood" as const,
  chainId: 4663,
  nativeSymbol: "ETH",
  explorer: "https://robinhoodchain.blockscout.com",
  publicRpc: "https://rpc.mainnet.chain.robinhood.com",
  contracts: {
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as `0x${string}`,
    v2Factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f" as `0x${string}`,
    v2Router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba" as `0x${string}`,
    v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as `0x${string}`,
    v3Router: "0xCaf681a66D020601342297493863E78C959E5cb2" as `0x${string}`,
    v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as `0x${string}`,
    v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as `0x${string}`,
    v4UniversalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904" as `0x${string}`,
    v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as `0x${string}`,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as `0x${string}`,
  },
};

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;

const modeRaw = env("MODE", "paper").toLowerCase();
if (!["paper", "live"].includes(modeRaw)) throw new Error(`MODE must be paper or live, got ${modeRaw}`);

export const config = {
  mode: modeRaw as "paper" | "live",
  dexPaprika: {
    baseUrl: env("DEXPAPRIKA_BASE_URL", "https://api.dexpaprika.com"),
    apiKey: process.env.DEXPAPRIKA_API_KEY ?? "",
    intervalMs: num("DISCOVERY_INTERVAL_MS", 40_000),
    limit: num("DISCOVERY_LIMIT", 100),
    maxRpm: num("DEXPAPRIKA_MAX_RPM", 14),
    minAgeSec: num("NEW_POOL_MIN_AGE_SEC", 60),
    maxAgeSec: num("NEW_POOL_MAX_AGE_SEC", 120),
    minLiquidityUsd: num("MIN_LIQUIDITY_USD", 15_000),
    maxLiquidityUsd: num("MAX_LIQUIDITY_USD", 100_000),
    minVolume24hUsd: num("MIN_VOLUME_24H_USD", 1_000),
    minTxns24h: num("MIN_TXNS_24H", 5),
    quoteSymbols: (process.env.QUOTE_SYMBOLS ?? "WETH").split(",").map((v: string) => v.trim().toLowerCase()).filter(Boolean),
    dexIds: (process.env.DEX_IDS ?? "uniswap").split(",").map((v: string) => v.trim().toLowerCase()).filter(Boolean),
  },
  dexScreener: {
    baseUrl: env("DEXSCREENER_BASE_URL", "https://api.dexscreener.com"),
    intervalMs: num("PRICE_POLL_MS", 1_000),
    maxRpm: num("DEXSCREENER_MAX_RPM", 290),
    batchSize: num("DEXSCREENER_PAIR_BATCH_SIZE", 20),
  },
  entry: {
    auto: bool("AUTO_ENTRY", false),
    positionSizeUsd: num("POSITION_SIZE_USD", 10),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
    maxSameSymbolOpen: num("MAX_SAME_SYMBOL_OPEN", 1),
    maxPositionAgeMin: RH_EXIT.maxPositionAgeMin,
    maxImpactPct: num("MAX_ENTRY_IMPACT_PCT", 5),
    feeEntryBps: num("PAPER_ENTRY_FEE_BPS", 0),
    feeExitBps: num("PAPER_EXIT_FEE_BPS", 0),
    slippageBps: num("PAPER_SLIPPAGE_BPS", 0),
    oneEntryPerPool: bool("ONE_ENTRY_PER_POOL", true),
    confirmEnabled: bool("ENTRY_CONFIRM_ENABLED", true),
    confirmDelayMs: num("ENTRY_CONFIRM_DELAY_MS", 3_000),
    confirmMaxPriceDropPct: num("ENTRY_CONFIRM_MAX_PRICE_DROP_PCT", 5),
    confirmMaxLiqDropPct: num("ENTRY_CONFIRM_MAX_LIQ_DROP_PCT", 30),
    pausedHoursUtc: parseHourSet(process.env.ENTRY_PAUSED_HOURS_UTC ?? "20,21,22,23"),
  },
  portfolio: { initialBalanceUsd: num("INITIAL_BALANCE_USD", 10_000) },
  recovery: {
    enabled: bool("RECOVERY_ENABLED", true),
    stateFile: env("STATE_FILE", "data/state.json"),
  },
  analytics: {
    enabled: bool("ANALYTICS_ENABLED", true),
    duckdbPath: env("DUCKDB_PATH", "data/paper.duckdb"),
  },
  snapshots: { intervalS: num("SNAPSHOT_INTERVAL_S", 60) },
  dynamic: {
    breakevenAfterTp1: RH_EXIT.breakevenAfterTp1,
    breakevenBufferPct: RH_EXIT.breakevenBufferPct,
    breakevenArmPct: RH_EXIT.breakevenArmPct,
  },
  earlyStop: {
    enabled: bool("EARLY_STOP_ENABLED", true),
    stopPct: RH_EXIT.earlyStopPct,
    windowSec: RH_EXIT.earlyStopWindowSec,
  },
  tp: RH_EXIT.tp,
  stops: {
    initialPct: RH_EXIT.initialStopPct,
    trailActivationPct: RH_EXIT.trailActivationPct,
    trailDistancePct: RH_EXIT.trailDistancePct,
  },
  risk: {
    breakerStops: num("BREAKER_STOPS", 3),
    breakerWindowMin: num("BREAKER_WINDOW_MIN", 30),
    breakerPauseMin: num("BREAKER_PAUSE_MIN", 30),
    expectancyTrades: num("EXPECTANCY_TRADES", 20),
    paperDailyLossLimitUsd: num("PAPER_DAILY_LOSS_LIMIT_USD", 0),
    maxDailyLiveLossUsd: num("MAX_DAILY_LIVE_LOSS_USD", 25),
  },
  safety: {
    enabled: bool("TOKEN_SAFETY_ENABLED", true),
    blockRepeatSymbols: bool("TOKEN_SAFETY_BLOCK_REPEAT_SYMBOLS", true),
    quoteDeviationPct: num("ENTRY_QUOTE_MAX_DEVIATION_PCT", 3),
  },
  live: {
    enabled: bool("LIVE_TRADING_ENABLED", false),
    testTrade: bool("LIVE_TEST_TRADE", false),
    buySlippageBps: num("LIVE_BUY_SLIPPAGE_BPS", 100),
    sellSlippageBps: num("LIVE_SELL_SLIPPAGE_BPS", 300),
    sellMaxSlippageBps: num("LIVE_SELL_MAX_SLIPPAGE_BPS", 500),
    sellMaxRetries: num("LIVE_SELL_MAX_RETRIES", 3),
    orderTimeoutMs: num("LIVE_ORDER_TIMEOUT_MS", 120_000),
    minEthReserveEth: num("LIVE_MIN_ETH_RESERVE", 0.003),
    rpcUrl: env("ROBINHOOD_RPC_URL", RH.publicRpc),
    rpcFallbackUrl: process.env.ROBINHOOD_RPC_FALLBACK_URL ?? "",
    zeroExKey: process.env.ZEROEX_API_KEY ?? "",
    orderRetentionDays: num("LIVE_ORDER_RETENTION_DAYS", 30),
  },
  telegram: {
    enabled: bool("TELEGRAM_ENABLED", false),
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
    startupMessage: bool("TELEGRAM_STARTUP_MESSAGE", true),
    announceCandidates: bool("TELEGRAM_ANNOUNCE_CANDIDATES", false),
    announceUpdates: bool("TELEGRAM_TRADE_UPDATES", false),
  },
  liveState: {
    ordersFile: env("LIVE_ORDERS_FILE", "data/live-orders.json"),
    positionsFile: env("LIVE_POSITIONS_FILE", "data/live-positions.json"),
    stateFile: env("LIVE_STATE_FILE", "data/live-state.json"),
    killFile: env("LIVE_KILL_FILE", "data/live-kill-switch.json"),
  },
};

if (config.dexPaprika.limit < 1 || config.dexPaprika.limit > 100 || !Number.isInteger(config.dexPaprika.limit)) throw new Error("DISCOVERY_LIMIT must be integer 1..100");
if (config.dexPaprika.dexIds.length === 0) throw new Error("DEX_IDS must list at least one venue (e.g. uniswap) — empty list rejects every candidate");
if (config.dexPaprika.quoteSymbols.length === 0) throw new Error("QUOTE_SYMBOLS must list at least one symbol (e.g. WETH) — empty list rejects every candidate");
if (config.dexPaprika.minAgeSec < 0 || config.dexPaprika.minAgeSec >= config.dexPaprika.maxAgeSec) throw new Error("Invalid pool age band");
if (config.dexPaprika.minLiquidityUsd <= 0 || config.dexPaprika.minLiquidityUsd >= config.dexPaprika.maxLiquidityUsd) throw new Error("Invalid liquidity band");
if (config.dexScreener.maxRpm < 1 || config.dexScreener.maxRpm > 300) throw new Error("DEXSCREENER_MAX_RPM must be 1..300");
if (config.dexPaprika.maxRpm < 1 || config.dexPaprika.maxRpm > 500) throw new Error("DEXPAPRIKA_MAX_RPM must be 1..500");
if (!Number.isInteger(config.dexScreener.batchSize) || config.dexScreener.batchSize < 1 || config.dexScreener.batchSize > 30) throw new Error("Invalid DEXSCREENER_PAIR_BATCH_SIZE");
if (!Number.isInteger(config.entry.maxOpenPositions) || config.entry.maxOpenPositions < 1 || config.entry.maxOpenPositions > 3) throw new Error("MAX_OPEN_POSITIONS must be integer 1..3");
if (!Number.isInteger(config.entry.maxSameSymbolOpen) || config.entry.maxSameSymbolOpen !== 1) throw new Error("MAX_SAME_SYMBOL_OPEN must be exactly 1 for the Robinhood strategy");
if (config.entry.positionSizeUsd <= 0 || config.entry.positionSizeUsd > config.portfolio.initialBalanceUsd) throw new Error("POSITION_SIZE_USD invalid");
if (config.entry.confirmDelayMs <= 0 || config.entry.confirmMaxPriceDropPct <= 0 || config.entry.confirmMaxLiqDropPct <= 0) throw new Error("Invalid confirmation config");
if (config.stops.initialPct <= config.earlyStop.stopPct || config.earlyStop.stopPct <= 0) throw new Error("Early stop must be positive and tighter than initial stop");
if (config.stops.trailActivationPct <= 0 || config.stops.trailDistancePct <= 0) throw new Error("Invalid trailing stop config");
if (config.risk.maxDailyLiveLossUsd <= 0) throw new Error("MAX_DAILY_LIVE_LOSS_USD must be positive");
if (config.safety.quoteDeviationPct <= 0 || config.safety.quoteDeviationPct > 25) throw new Error("ENTRY_QUOTE_MAX_DEVIATION_PCT must be 0..25");
if (config.live.buySlippageBps <= 0 || config.live.buySlippageBps > 500) throw new Error("LIVE_BUY_SLIPPAGE_BPS must be 1..500");
if (config.live.sellSlippageBps <= 0 || config.live.sellSlippageBps > config.live.sellMaxSlippageBps) throw new Error("LIVE_SELL_SLIPPAGE_BPS exceeds sell ceiling");
if (config.live.sellMaxSlippageBps > 500) throw new Error("LIVE_SELL_MAX_SLIPPAGE_BPS must be <= 500");
if (config.live.sellMaxRetries < 0 || config.live.sellMaxRetries > 5 || !Number.isInteger(config.live.sellMaxRetries)) throw new Error("LIVE_SELL_MAX_RETRIES must be integer 0..5");
if (config.live.minEthReserveEth <= 0) throw new Error("LIVE_MIN_ETH_RESERVE must be positive");
{
  const tp = config.tp;
  if (tp.length < 1 || tp.length > 3) throw new Error("TP ladder must have 1..3 levels");
  let prev = -Infinity;
  let total = 0;
  for (const level of tp) {
    if (!(level.gainPct > 0) || !(level.sellPct > 0)) throw new Error("TP percentages must be positive");
    if (level.gainPct <= prev) throw new Error("TP gain percentages must be strictly ascending");
    prev = level.gainPct;
    total += level.sellPct;
  }
  if (total > 100) throw new Error("TP sell percentages cannot exceed 100% of the original position");
}
if (config.dynamic.breakevenBufferPct < 0 || config.dynamic.breakevenArmPct <= 0) throw new Error("Invalid breakeven config");
if (!config.safety.enabled && config.live.enabled) throw new Error("TOKEN_SAFETY_ENABLED must stay true in live mode");
if (config.live.enabled && config.mode !== "live") throw new Error("LIVE_TRADING_ENABLED=true requires MODE=live");
if (config.live.enabled && !config.live.zeroExKey) throw new Error("LIVE_TRADING_ENABLED=true requires ZEROEX_API_KEY");
if (config.live.enabled && !process.env.ROBINHOOD_RPC_URL) throw new Error("LIVE_TRADING_ENABLED=true requires ROBINHOOD_RPC_URL (do not use public RPC for live)");
if (config.telegram.enabled && (!config.telegram.token || !config.telegram.chatId)) throw new Error("TELEGRAM_ENABLED requires token and chat id");

export function robinhoodExitProfile(): ExitProfile {
  return {
    ...RH_EXIT,
    tp: RH_EXIT.tp.map((t) => ({ ...t })),
  };
}
