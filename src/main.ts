import { config, isEntryPausedAt, isEthVenueQuote, isPoolEntryBandValid, NATIVE, RH, robinhoodExitProfile } from "./config.ts";
import { fetchNewestPools } from "./dexpaprika.ts";
import { assessConfirmation, getPair, getPairsByChain, parsePrice, pairLiquidityUsd } from "./dexscreener.ts";
import { openPosition, updatePosition } from "./position.ts";
import { Portfolio } from "./portfolio.ts";
import { loadState, saveState } from "./store.ts";
import {
  analyticsStatus, checkpointAnalytics, closeAnalytics, initAnalytics, recordFill, recordQuoteCheck,
  recordSnapshot, recordTrade, tradeRecordFromPosition,
} from "./analytics.ts";
import { telegram, testTelegram } from "./telegram.ts";
import { buildBuyMessage, buildCloseMessage, buildLiveClosedMessage, buildStartupMessage, buildTpMessage, buildUpdateMessage } from "./report.ts";
import type { Candidate, DexScreenerPair, Position, Quote } from "./types.ts";
import type { PositionEvent } from "./position.ts";
import { recentStopCount, rollingExpectancyNegative, paperLossLimitBreached, isRepeatSymbol } from "./breakers.ts";
import { claimInstanceLockForStateFile } from "./instance-lock.ts";
import {
  liveBuy, liveEntryAllowed, liveOpenCount, initLive, restoredStrategyPositions,
  pumpLiveSells, queueLiveSell, isLiveSellPending, catchUpLiveSells,
  syncLiveStrategyState, flushLiveState, getLivePosition, finalizeLivePosition,
  liveCashUsd, latchHalt, applyConfirmedLiveSell, liveStatus,
} from "./live.ts";
import { getEvmPublicClient, traderAddress } from "./execution/evm/viem-client.ts";
import { getBestExecutableQuote, makeQuoteRequest } from "./execution/router.ts";
import { paperLatency } from "./execution/latency.ts";
import { runLiveSmokeTest } from "./live-test.ts";

const CHAIN = RH.chain;
const positions = new Map<string, Position>();
const portfolio = new Portfolio(config.portfolio.initialBalanceUsd);
const seenPools = new Map<string, number>();
const lastSnapshotAt = new Map<string, number>();
const ledgerCosts = new Map<string, { fee: number; slip: number }>();
const pendingConfirms = new Map<string, { candidate: Candidate; firstPrice: number; firstLiquidity: number | null; fireAt: number }>();
/** Pre-exit live cash per position, for the close message's balance leg. */
const exitCash = new Map<string, { before: number; after: number }>();
let lastPersist = 0;
let lastPausedLog = 0;
let lastGatedLog = 0;
let lastCheckpointAt = 0;
let shuttingDown = false;

function log(msg: string): void { console.log(`${new Date().toISOString()} ${msg}`); }
async function notify(msg: string): Promise<void> { try { await telegram(msg); } catch (e) { log(`⚠️ Telegram failed: ${String(e).slice(0, 180)}`); } }
function ageSec(createdAt: number): number { return Math.max(0, (Date.now() - createdAt) / 1000); }
function sleepMs(ms: number): Promise<void> { return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve(); }
function openCount(): number { return [...positions.values()].filter((p) => p.status === "OPEN").length; }

function isRealizedSellEvent(e: PositionEvent): e is Extract<PositionEvent, { soldQty: number; proceedsUsd: number }> {
  return e.type === "TP" || e.type === "TRAIL_EXIT" || e.type === "STOP_EXIT" || e.type === "EARLY_EXIT" || e.type === "BREAKEVEN_EXIT" || e.type === "DRAIN_EXIT" || e.type === "TIME_EXIT";
}

/**
 * Pessimistic exit haircut: shaves proceeds to model live confirmation lag,
 * retry slippage, and token taxes that paper marks cannot see. Booked as
 * slippage so ledgers and closes carry it.
 */
function applyExitHaircut(p: Position, proceedsUsd: number): number {
  const pct = config.entry.exitHaircutPct;
  if (!(pct > 0) || !(proceedsUsd > 0)) return 0;
  const cut = proceedsUsd * (pct / 100);
  portfolio.spend(cut);
  p.realizedPnlUsd -= cut;
  p.totalSlippageUsd += cut;
  return cut;
}

/**
 * Modeled on-chain gas for a paper fill, paid win or lose like live.
 * Added to realized PnL + fee totals (so ledgers and closes carry it) and
 * spent from paper cash. Zero by default; set PAPER_GAS_PER_FILL_USD for
 * pessimistic paper that cannot ignore gas on small sizes.
 */
function applyPaperGas(p: Position, side: "ENTRY" | "EXIT", amountUsd = config.entry.gasPerFillUsd): void {
  const gas = amountUsd;
  if (!(gas > 0)) return;
  portfolio.spend(gas);
  p.realizedPnlUsd -= gas;
  p.totalGasUsd += gas;
  if (side === "ENTRY") p.totalEntryFeeUsd += gas;
  else p.totalExitFeeUsd += gas;
}

function persist(force = false): void {
  if (!config.recovery.enabled) return;
  if (!force && Date.now() - lastPersist < 10_000) return;
  lastPersist = Date.now();
  try {
    saveState(config.recovery.stateFile, {
      version: 1,
      savedAt: Date.now(),
      cashUsd: portfolio.cashUsd,
      closedTrades: [...portfolio.closedTrades],
      openPositions: config.mode === "live" ? [] : [...positions.values()].filter((p) => p.status === "OPEN"),
    });
  } catch (e) { log(`⚠️ state persist failed: ${String(e)}`); }
}

function syncLivePortfolioCash(): void {
  const cash = liveCashUsd();
  if (Number.isFinite(cash) && cash >= 0) portfolio.restore(cash, [...portfolio.closedTrades]);
}

function restore(): void {
  if (!config.recovery.enabled) return;
  const s = loadState(config.recovery.stateFile);
  portfolio.restore(s.cashUsd, s.closedTrades.filter((t) => t.chain === CHAIN));
  if (config.mode === "live") {
    // Live positions are rebuilt from the transaction journal, never from the
    // secondary strategy state. The store only supplies closed-trade reporting.
    log(`♻️ restored ${portfolio.closedTrades.length} closed RH trades from reporting state`);
    return;
  }
  for (const p of s.openPositions) {
    if (p.chain !== CHAIN || p.status !== "OPEN") continue;
    p.lowestPrice ??= p.currentPrice;
    p.highestAt ??= p.updatedAt;
    p.lowestAt ??= p.openedAt;
    p.trailHigh ??= p.highestPrice;
    p.highStreak ??= 0;
    p.shadowFeeUsd ??= 0;
    p.shadowSlipUsd ??= 0;
    p.exitProfile ??= robinhoodExitProfile();
    positions.set(p.id, p);
    ledgerCosts.set(p.id, { fee: p.totalExitFeeUsd, slip: p.totalSlippageUsd });
    log(`♻️ restored ${p.id} ${p.symbol} entry=${p.entryPrice} qty=${p.quantity}`);
  }
  log(`♻️ restored ${positions.size} RH paper positions | ${portfolio.closedTrades.length} closed trades`);
}

function sameSymbolOpen(symbol: string): boolean {
  const s = symbol.trim().toLowerCase();
  return [...positions.values()].some((p) => p.status === "OPEN" && p.symbol.trim().toLowerCase() === s);
}

function alreadyTradedPool(key: string): boolean { return portfolio.closedTrades.some((t) => t.id === key); }

/** Expectancy looks back one day: stale losses expire instead of locking entries forever. */
const EXPECTANCY_WINDOW_MIN = 24 * 60;

function entryGates(): boolean {
  if (isEntryPausedAt(new Date(), config.entry.pausedHoursUtc)) {
    if (Date.now() - lastPausedLog > 3_600_000) { lastPausedLog = Date.now(); log("⏸️ entry hour paused (20–23 UTC)"); }
    return false;
  }
  if (config.mode === "live") return liveEntryAllowed();
  if (paperLossLimitBreached(portfolio.closedTrades, config.risk.paperDailyLossLimitUsd, Date.now())) return false;
  const stops = recentStopCount(portfolio.closedTrades, CHAIN, Date.now(), config.risk.breakerWindowMin);
  if (stops >= config.risk.breakerStops) return false;
  if (rollingExpectancyNegative(portfolio.closedTrades, CHAIN, config.risk.expectancyTrades, Date.now(), EXPECTANCY_WINDOW_MIN)) return false;
  return openCount() < config.entry.maxOpenPositions;
}

function isAddress(value: string): boolean { return /^0x[0-9a-fA-F]{40}$/.test(value); }
function quoteAllowed(pair: DexScreenerPair): boolean {
  return isEthVenueQuote(pair.quoteToken.address)
    && config.dexPaprika.quoteSymbols.includes(pair.quoteToken.symbol.trim().toLowerCase());
}
function dexAllowed(pair: DexScreenerPair): boolean { return config.dexPaprika.dexIds.includes(pair.dexId.toLowerCase()); }

function makeCandidate(pool: Awaited<ReturnType<typeof fetchNewestPools>>[number], pair: DexScreenerPair): Candidate | null {
  const price = parsePrice(pair);
  if (price === null || !quoteAllowed(pair) || !dexAllowed(pair)) return null;
  const liq = pairLiquidityUsd(pair);
  if (liq === null || liq < config.dexPaprika.minLiquidityUsd || liq > config.dexPaprika.maxLiquidityUsd) return null;
  if (!isAddress(pair.baseToken.address) || pair.baseToken.address.toLowerCase() === RH.contracts.weth.toLowerCase()) return null;
  const key = `${CHAIN}:${pool.poolAddress.toLowerCase()}`;
  return {
    key, chain: CHAIN, poolAddress: pool.poolAddress, pairAddress: pair.pairAddress,
    tokenAddress: pair.baseToken.address, tokenSymbol: pair.baseToken.symbol,
    tokenName: pair.baseToken.name, quoteSymbol: pair.quoteToken.symbol, dexId: pair.dexId,
    pair, discoveredAt: Date.now(), poolCreatedAt: pool.createdAtMs,
  };
}

async function queueCandidate(candidate: Candidate): Promise<void> {
  if (!entryGates()) {
    // Throttled: gates can stay shut for hours (full book, breaker,
    // expectancy) while discovery keeps finding pools — log the blockage
    // instead of dropping candidates silently every 40s.
    if (Date.now() - lastGatedLog > 600_000) {
      lastGatedLog = Date.now();
      log(`⏸️ entries gated (book ${openCount()}/${config.entry.maxOpenPositions}, breaker/expectancy guards?) — candidates waiting`);
    }
    return;
  }
  if (seenPools.has(candidate.key) || (config.entry.oneEntryPerPool && alreadyTradedPool(candidate.key))) return;
  if (sameSymbolOpen(candidate.tokenSymbol)) return;
  if (config.safety.blockRepeatSymbols && isRepeatSymbol(
    [...positions.values()].filter((p) => p.status === "OPEN" && p.chain === CHAIN).map((p) => p.symbol),
    portfolio.closedTrades, CHAIN, candidate.tokenSymbol,
  )) {
    log(`⏭️ skip entry ${candidate.key}: repeat symbol ${candidate.tokenSymbol} on ${CHAIN}`);
    return;
  }
  seenPools.set(candidate.key, Date.now());
  const price = parsePrice(candidate.pair);
  if (price === null) return;
  pendingConfirms.set(candidate.key, {
    candidate,
    firstPrice: price,
    firstLiquidity: pairLiquidityUsd(candidate.pair),
    fireAt: Date.now() + config.entry.confirmDelayMs,
  });
}

async function discover(): Promise<void> {
  const started = Date.now();
  const pools = await fetchNewestPools(CHAIN);
  if (!pools.length) {
    log(`🔎 discovery cycle complete in ${Date.now() - started}ms; pools=0 pendingConfirm=${pendingConfirms.size}`);
    return;
  }
  if (pools.length >= config.dexPaprika.limit) log(`⚠️ discovery saturated at limit=${config.dexPaprika.limit}; increase DISCOVERY_LIMIT if candidates appear truncated`);
  const pairs = await getPairsByChain(CHAIN, pools.map((p) => p.poolAddress));
  const byAddress = new Map(pairs.map((p) => [p.pairAddress.toLowerCase(), p]));
  let queued = 0;
  for (const pool of pools) {
    const pair = byAddress.get(pool.poolAddress.toLowerCase()) ?? await getPair(CHAIN, pool.poolAddress).catch(() => null);
    if (!pair) continue;
    const candidate = makeCandidate(pool, pair);
    if (candidate) {
      const before = pendingConfirms.size;
      await queueCandidate(candidate);
      if (pendingConfirms.size > before) {
        queued++;
        log(`🆕 ${CHAIN} ${candidate.tokenSymbol} ${candidate.poolAddress.slice(0, 6)}…${candidate.poolAddress.slice(-4)} price=$${parsePrice(pair)} liq=$${pairLiquidityUsd(pair) ?? "unknown"}`);
      }
    }
  }
  log(`🔎 discovery cycle complete in ${Date.now() - started}ms; pools=${pools.length} pairs=${pairs.length} queued=${queued} pendingConfirm=${pendingConfirms.size}`);
}

async function paperOpen(
  c: Candidate,
  pair: DexScreenerPair,
  price: number,
  exec: { quote: Quote; decimals: number; ethUsd: number; deviationPct: number } | null,
): Promise<void> {
  // Live-shadow fill: when an executable quote is available, the fill uses
  // the QUOTED output (buyAmount/minBuyAmount) and estimated gas exactly as
  // liveBuy would execute it — no mark fill, no fixed slippage assumption.
  // Without a quote (balance-limited probe), falls back to the legacy mark
  // fill with the fixed pessimism stack.
  const sizeUsd = config.entry.positionSizeUsd;
  const quoteGas = exec ? await paperExecGasUsd(exec.quote, exec.ethUsd) : config.entry.gasPerFillUsd;
  if (!portfolio.canOpen(sizeUsd + quoteGas)) return;
  if (!portfolio.onOpen(sizeUsd)) return;
  try {
    const entryLiq = pairLiquidityUsd(pair);
    if (exec) {
      const buyRaw = BigInt(exec.quote.buyAmount);
      const tokenQty = Number(buyRaw) / 10 ** exec.decimals;
      const minRaw = exec.quote.minBuyAmount !== undefined ? BigInt(exec.quote.minBuyAmount) : 0n;
      if (!(tokenQty > 0) || buyRaw < minRaw) {
        portfolio.onProceeds(sizeUsd);
        log(`⏭️ skip entry ${c.tokenSymbol}: simulated min-output revert`);
        return;
      }
      const sellEth = Number(BigInt(exec.quote.sellAmount)) / 1e18;
      const costUsd = sellEth * exec.ethUsd;
      if (!(costUsd > 0)) {
        portfolio.onProceeds(sizeUsd);
        log(`⏭️ skip entry ${c.tokenSymbol}: simulated fill cannot be valued`);
        return;
      }
      const bpsFee = costUsd * (config.entry.feeEntryBps / 10_000);
      const p = openPosition({
        id: c.key, chain: CHAIN, pairAddress: c.pairAddress, tokenAddress: c.tokenAddress,
        symbol: c.tokenSymbol, tokenName: c.tokenName, quoteSymbol: pair.quoteToken.symbol,
        dexId: pair.dexId, ...(pair.url ? { pairUrl: pair.url } : {}), marketPrice: costUsd / tokenQty,
        usdSize: costUsd, balanceBeforeUsd: portfolio.cashUsd + sizeUsd + quoteGas,
        poolAddress: c.poolAddress, ...(entryLiq !== null ? { entryLiquidityUsd: entryLiq } : {}),
        entryAgeSec: ageSec(c.poolCreatedAt), exitProfile: robinhoodExitProfile(),
      });
      // Lock the quoted fill over the mark fill, mirroring liveBuy's receipt
      // rebuild: quantity, price, and costs come from the executable quote.
      p.quantity = tokenQty;
      p.originalQuantity = tokenQty;
      p.initialUsdSize = costUsd;
      p.entryPrice = costUsd / tokenQty;
      p.currentPrice = p.entryPrice;
      p.highestPrice = p.entryPrice;
      p.lowestPrice = p.entryPrice;
      p.realizedPnlUsd = -(bpsFee + quoteGas);
      p.totalEntryFeeUsd = bpsFee + quoteGas;
      p.totalGasUsd = quoteGas;
      p.totalSlippageUsd = 0;
      positions.set(p.id, p);
      ledgerCosts.set(p.id, { fee: p.totalExitFeeUsd, slip: p.totalSlippageUsd });
      portfolio.spend(quoteGas);
      // onOpen took sizeUsd but the quoted spend is costUsd: settle the difference.
      if (costUsd > sizeUsd) portfolio.spend(costUsd - sizeUsd);
      else portfolio.onProceeds(sizeUsd - costUsd);
      persist(true);
      await recordFill({
        time: Date.now(), side: "BUY", positionId: p.id, chain: CHAIN, dex: p.dexId, symbol: p.symbol,
        tokenName: p.tokenName, pair: p.pairAddress, pool: p.poolAddress ?? "", ca: p.tokenAddress,
        quote: p.quoteSymbol, price: p.entryPrice, qty: p.quantity, notionalUsd: p.initialUsdSize,
        feeUsd: p.totalEntryFeeUsd, slipUsd: p.totalSlippageUsd, gasUsd: quoteGas, detail: `paper:${exec.quote.source}:dev${exec.deviationPct.toFixed(2)}`,
        balanceAfterUsd: portfolio.cashUsd, equityAfterUsd: portfolio.equityUsd(positions.values()),
      });
      await notify(buildBuyMessage(p, config.entry.maxOpenPositions, openCount(), p.balanceBeforeUsd, portfolio.cashUsd));
      log(`💰 paper BUY ${p.symbol} entry=${p.entryPrice} qty=${p.quantity} open=${openCount()}/${config.entry.maxOpenPositions}`);
      return;
    }
    const p = openPosition({
      id: c.key, chain: CHAIN, pairAddress: c.pairAddress, tokenAddress: c.tokenAddress,
      symbol: c.tokenSymbol, tokenName: c.tokenName, quoteSymbol: pair.quoteToken.symbol,
      dexId: pair.dexId, ...(pair.url ? { pairUrl: pair.url } : {}), marketPrice: price,
      usdSize: sizeUsd, balanceBeforeUsd: portfolio.cashUsd + sizeUsd,
      poolAddress: c.poolAddress, ...(entryLiq !== null ? { entryLiquidityUsd: entryLiq } : {}),
      entryAgeSec: ageSec(c.poolCreatedAt), exitProfile: robinhoodExitProfile(),
    });
    positions.set(p.id, p);
    ledgerCosts.set(p.id, { fee: p.totalExitFeeUsd, slip: p.totalSlippageUsd });
    applyPaperGas(p, "ENTRY");
    persist(true);
    await recordFill({
      time: Date.now(), side: "BUY", positionId: p.id, chain: CHAIN, dex: p.dexId, symbol: p.symbol,
      tokenName: p.tokenName, pair: p.pairAddress, pool: p.poolAddress ?? "", ca: p.tokenAddress,
      quote: p.quoteSymbol, price: p.entryPrice, qty: p.quantity, notionalUsd: p.initialUsdSize,
      feeUsd: p.totalEntryFeeUsd, slipUsd: p.totalSlippageUsd, gasUsd: config.entry.gasPerFillUsd, detail: "paper",
      balanceAfterUsd: portfolio.cashUsd, equityAfterUsd: portfolio.equityUsd(positions.values()),
    });
    await notify(buildBuyMessage(p, config.entry.maxOpenPositions, openCount(), p.balanceBeforeUsd, portfolio.cashUsd));
    log(`💰 paper BUY ${p.symbol} entry=${p.entryPrice} qty=${p.quantity} open=${openCount()}/${config.entry.maxOpenPositions}`);
  } catch (error) {
    portfolio.onProceeds(config.entry.positionSizeUsd);
    throw error;
  }
}

async function probeBuyQuote(c: Candidate, pair: DexScreenerPair, price: number, sizeUsd: number): Promise<
  | { ok: true; quoted: true; quote: Quote; decimals: number; ethUsd: number; deviationPct: number; quoteLatencyMs: number; simulatedLatencyMs: number }
  | { ok: true; quoted: false; balanceLimited: true }
  | { ok: false; reason: string }
> {
  // BUY-side dry run through the exact live router (direct-V2 + 0x),
  // read-only: proves the entry could be quoted without broadcasting.
  // Returns the mark deviation using liveBuy's own math so the paper gate
  // matches the live 3% rejection exactly.
  // Empty-wallet caveat: 0x checks the taker's balance, so with an unfunded
  // wallet it reports "insufficient taker balance" for routes that DO exist.
  // That is a wallet problem, not a market problem: treat it as a
  // balance-limited pass (route exists, deviation unknown) rather than a
  // skip. Funding the wallet makes probes exact automatically.
  const started = Date.now();
  const base = {
    time: started, positionId: c.key, chain: CHAIN, side: "BUY" as const,
    paperPriceUsd: price, quotedSellAmount: "", quotedBuyAmount: "",
    sellDecimals: 18 as number | null, buyDecimals: null as number | null,
    riskPass: null as boolean | null, simOk: null as boolean | null,
  };
  try {
    const ethUsd = Number(pair.priceUsd) / Number(pair.priceNative);
    if (!(ethUsd > 0)) { await recordQuoteCheck({ ...base, source: "skipped", note: "no-eth-mark" }); return { ok: false, reason: "no-eth-mark" }; }
    const sellRaw = BigInt(Math.floor(sizeUsd / ethUsd * 1e18));
    if (sellRaw <= 0n) { await recordQuoteCheck({ ...base, source: "skipped", note: "dust-size" }); return { ok: false, reason: "dust-size" }; }
    let taker: string;
    try { taker = traderAddress(); } catch { await recordQuoteCheck({ ...base, source: "skipped", note: "no-trader-key" }); return { ok: false, reason: "no-trader-key" }; }
    const quoteTimeout = config.paperExecution.quoteTimeoutMs;
    const quoteStarted = Date.now();
    const quote = await Promise.race([
      getBestExecutableQuote(makeQuoteRequest({ sellToken: NATIVE, buyToken: c.tokenAddress, sellAmountBaseUnits: sellRaw.toString(), slippageBps: config.live.buySlippageBps, pairAddress: pair.pairAddress, taker }), "BUY"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), quoteTimeout)),
    ]);
    const quoteLatencyMs = quote.quoteLatencyMs ?? (Date.now() - quoteStarted);
    const decimals = await probeTokenDecimals(c.tokenAddress);
    // Simulated submit+confirm delay (learned live latencies once sampled,
    // fixed fallbacks until then), then a fresh re-quote: the fill uses the
    // post-delay executable quote, and a fresh output below the initial
    // minBuyAmount is a simulated live revert, not a fill.
    const submitDelay = paperLatency("submit", config.paperExecution.submitDelayMs);
    const confirmDelay = paperLatency("confirm", config.paperExecution.confirmDelayMs);
    await sleepMs(submitDelay + confirmDelay);
    const requoteStarted = Date.now();
    const fresh = await Promise.race([
      getBestExecutableQuote(makeQuoteRequest({ sellToken: NATIVE, buyToken: c.tokenAddress, sellAmountBaseUnits: sellRaw.toString(), slippageBps: config.live.buySlippageBps, pairAddress: pair.pairAddress, taker }), "BUY"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe requote timeout")), quoteTimeout)),
    ]);
    const requoteLatencyMs = fresh.quoteLatencyMs ?? (Date.now() - requoteStarted);
    const simulatedLatencyMs = quoteLatencyMs + submitDelay + confirmDelay + requoteLatencyMs;
    const minBuy = BigInt(quote.minBuyAmount ?? quote.buyAmount);
    if (BigInt(fresh.buyAmount) < minBuy) {
      await recordQuoteCheck({ ...base, source: fresh.source, quotedSellAmount: fresh.sellAmount, quotedBuyAmount: fresh.buyAmount, buyDecimals: decimals, executionOk: false, executionReason: "min-output-failed", note: `requoted below initial minBuyAmount after ${simulatedLatencyMs}ms simulated latency` });
      return { ok: false, reason: "simulated min-output revert" };
    }
    const tokenQty = Number(BigInt(fresh.buyAmount)) / 10 ** decimals;
    const quotedValueUsd = tokenQty * Number(pair.priceUsd);
    const deviation = Math.abs(quotedValueUsd / sizeUsd - 1) * 100;
    await recordQuoteCheck({ ...base, source: fresh.source, quotedSellAmount: fresh.sellAmount, quotedBuyAmount: fresh.buyAmount, buyDecimals: decimals, quoteLatencyMs, simulatedLatencyMs, executionOk: true, executionReason: "live-shadow", note: `quotable quoteLatencyMs=${quoteLatencyMs} simulatedLatencyMs=${simulatedLatencyMs}; impact=${fresh.priceImpactPct ?? "unknown"}; deviation=${Number.isFinite(deviation) ? deviation.toFixed(2) : "?"}%` });
    if (!Number.isFinite(deviation) || deviation > config.safety.quoteDeviationPct) return { ok: false, reason: `deviates ${Number.isFinite(deviation) ? deviation.toFixed(2) : "?"}%` };
    return { ok: true, quoted: true, quote: fresh, decimals, ethUsd, deviationPct: deviation, quoteLatencyMs, simulatedLatencyMs };
  } catch (error) {
    const msg = String(error);
    if (/insufficient taker balance/i.test(msg)) {
      const note = `balance-limited: route exists but taker wallet is empty; deviation unknown`;
      await recordQuoteCheck({ ...base, source: "0x-balance-limited", note });
      return { ok: true, quoted: false, balanceLimited: true };
    }
    const note = `unindexed: ${msg.slice(0, 160)}`;
    await recordQuoteCheck({ ...base, source: "none", note });
    return { ok: false, reason: msg.slice(0, 120) };
  }
}

/** Live-style gas estimate for a quote (read-only). Null when unestimable. */
async function estimateExecGasUsd(quote: Quote, ethUsd: number): Promise<number | null> {
  try {
    if (!(ethUsd > 0)) return null;
    const client = getEvmPublicClient();
    const units = await client.estimateGas({
      account: traderAddress(),
      to: quote.to as `0x${string}`,
      data: quote.calldata as `0x${string}`,
      value: BigInt(quote.value || "0"),
    });
    const gasPrice = BigInt(await client.getGasPrice());
    const usd = Number(BigInt(units) * gasPrice) / 1e18 * ethUsd;
    return Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch { return null; }
}

/** Pessimistic gas: live estimate floored at the fixed paper model. */
async function paperExecGasUsd(quote: Quote, ethUsd: number): Promise<number> {
  const est = await estimateExecGasUsd(quote, ethUsd);
  return est === null ? config.entry.gasPerFillUsd : Math.max(est, config.entry.gasPerFillUsd);
}

const probeDecimalsCache = new Map<string, number>();

async function probeTokenDecimals(tokenAddress: string): Promise<number> {
  const key = tokenAddress.toLowerCase();
  const cached = probeDecimalsCache.get(key);
  if (cached !== undefined) return cached;
  const decimals = Number(await getEvmPublicClient().readContract({
    address: tokenAddress as `0x${string}`,
    abi: [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const,
    functionName: "decimals",
  }));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("invalid token decimals");
  probeDecimalsCache.set(key, decimals);
  return decimals;
}

/**
 * Paper SELL execution through the live router (read-only): returns quoted
 * output + estimated gas so paper exits fill exactly what live would
 * execute, mirroring the live 300→400bps retry escalation (two attempts).
 * Never broadcasts. Falls back to mark fills only when unquotable.
 */
type SellExec =
  | { status: "quoted"; quote: Quote; proceedsUsd: number; gasUsd: number; deviationPct: number; attempts: number; quoteLatencyMs: number; simulatedLatencyMs: number }
  | { status: "balance-limited" }
  | { status: "unavailable"; reason: string };

async function quoteSellExec(p: Position, pair: DexScreenerPair, soldQtyUnits: number, label: string, markPrice: number): Promise<SellExec> {
  const started = Date.now();
  const base = {
    time: started, positionId: p.id, chain: CHAIN, side: "SELL" as const,
    paperPriceUsd: markPrice, quotedSellAmount: "", quotedBuyAmount: "",
    sellDecimals: null as number | null, buyDecimals: 18 as number | null,
    riskPass: null as boolean | null, simOk: null as boolean | null,
  };
  const fail = async (reason: string): Promise<SellExec> => {
    await recordQuoteCheck({ ...base, source: "none", note: `${label} unindexed: ${reason.slice(0, 140)}` });
    return { status: "unavailable", reason };
  };
  try {
    const ethUsd = Number(pair.priceUsd) / Number(pair.priceNative);
    if (!(ethUsd > 0)) { await recordQuoteCheck({ ...base, source: "skipped", note: `${label}:no-eth-mark` }); return fail("no-eth-mark"); }
    const decimals = await probeTokenDecimals(p.tokenAddress);
    const sellRaw = BigInt(Math.floor(soldQtyUnits * 10 ** decimals));
    if (sellRaw <= 0n) { await recordQuoteCheck({ ...base, source: "skipped", note: `${label}:dust-size` }); return fail("dust-size"); }
    let taker: string;
    try { taker = traderAddress(); } catch { await recordQuoteCheck({ ...base, source: "skipped", note: `${label}:no-trader-key` }); return fail("no-trader-key"); }
    const baseBps = config.live.sellSlippageBps;
    const escalated = Math.min(Math.ceil(baseBps * 4 / 3), config.live.sellMaxSlippageBps);
    const steps = escalated > baseBps ? [baseBps, escalated] : [baseBps];
    let lastError = "no route";
    for (let i = 0; i < steps.length; i++) {
      const slip = steps[i]!;
      try {
        const quoteStarted = Date.now();
        const quote = await Promise.race([
          getBestExecutableQuote(makeQuoteRequest({ sellToken: p.tokenAddress, buyToken: NATIVE, sellAmountBaseUnits: sellRaw.toString(), slippageBps: slip, pairAddress: pair.pairAddress, taker }), "SELL"),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), config.paperExecution.quoteTimeoutMs)),
        ]);
        const quoteLatencyMs = quote.quoteLatencyMs ?? (Date.now() - quoteStarted);
        // Simulated submit+confirm delay, then a fresh re-quote: the fill
        // uses the post-delay executable output, and fresh output below the
        // initial minBuyAmount is a simulated live revert, not a fill.
        const submitDelay = paperLatency("submit", config.paperExecution.submitDelayMs);
        const confirmDelay = paperLatency("confirm", config.paperExecution.confirmDelayMs);
        await sleepMs(submitDelay + confirmDelay);
        const requoteStarted = Date.now();
        const fresh = await Promise.race([
          getBestExecutableQuote(makeQuoteRequest({ sellToken: p.tokenAddress, buyToken: NATIVE, sellAmountBaseUnits: sellRaw.toString(), slippageBps: slip, pairAddress: pair.pairAddress, taker }), "SELL"),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe requote timeout")), config.paperExecution.quoteTimeoutMs)),
        ]);
        const requoteLatencyMs = fresh.quoteLatencyMs ?? (Date.now() - requoteStarted);
        const simulatedLatencyMs = quoteLatencyMs + submitDelay + confirmDelay + requoteLatencyMs;
        const minBuy = BigInt(quote.minBuyAmount ?? quote.buyAmount);
        if (BigInt(fresh.buyAmount) < minBuy) {
          lastError = "simulated min-output revert";
          await recordQuoteCheck({ ...base, source: fresh.source, quotedSellAmount: fresh.sellAmount, quotedBuyAmount: fresh.buyAmount, sellDecimals: decimals, quoteLatencyMs, simulatedLatencyMs, executionOk: false, executionReason: "min-output-failed", note: `${label}@${slip} requoted below initial minBuyAmount after ${simulatedLatencyMs}ms simulated latency` });
          continue;
        }
        const outEth = Number(BigInt(fresh.buyAmount)) / 1e18;
        const quotedUsd = outEth * ethUsd;
        const expectedUsd = soldQtyUnits * markPrice;
        const deviation = expectedUsd > 0 ? Math.abs(quotedUsd / expectedUsd - 1) * 100 : NaN;
        await recordQuoteCheck({
          ...base, source: fresh.source, quotedSellAmount: fresh.sellAmount, quotedBuyAmount: fresh.buyAmount,
          sellDecimals: decimals, quoteLatencyMs, simulatedLatencyMs, executionOk: true, executionReason: "live-shadow",
          note: `${label}@${slip} quotable attempt=${i + 1} quoteLatencyMs=${quoteLatencyMs} simulatedLatencyMs=${simulatedLatencyMs}; impact=${fresh.priceImpactPct ?? "unknown"}; deviation=${Number.isFinite(deviation) ? deviation.toFixed(2) : "?"}%`,
        });
        if (!Number.isFinite(deviation) || deviation > config.safety.quoteDeviationPct) {
          lastError = `deviates ${Number.isFinite(deviation) ? deviation.toFixed(2) : "?"}%`;
          log(`⚠️ SELL quote deviates ${p.symbol} ${label}@${slip}: ${lastError}`);
          continue;
        }
        const gas = await paperExecGasUsd(fresh, ethUsd);
        return { status: "quoted", quote: fresh, proceedsUsd: quotedUsd, gasUsd: gas, deviationPct: deviation, attempts: i + 1, quoteLatencyMs, simulatedLatencyMs };
      } catch (error) {
        const msg = String(error);
        if (/insufficient taker balance/i.test(msg)) {
          await recordQuoteCheck({ ...base, source: "0x-balance-limited", note: `${label} balance-limited: route exists but taker wallet is empty` });
          log(`⚠️ SELL probe balance-limited ${p.symbol} ${label}: route exists, wallet empty`);
          return { status: "balance-limited" };
        }
        lastError = msg.slice(0, 120);
        await recordQuoteCheck({ ...base, source: "none", note: `${label}@${slip} unindexed: ${msg.slice(0, 120)}` });
      }
    }
    log(`⚠️ SELL unroutable ${p.symbol} ${label}: ${lastError}`);
    return fail(lastError);
  } catch (error) {
    return fail(String(error).slice(0, 120));
  }
}

async function liveOpen(c: Candidate, pair: DexScreenerPair): Promise<void> {
  const cashBefore = liveCashUsd();
  const result = await liveBuy(c, pair, config.entry.positionSizeUsd);
  positions.set(result.position.id, result.position);
  syncLivePortfolioCash();
  persist(true);
  await recordFill({
    time: Date.now(), side: "BUY", positionId: result.position.id, chain: CHAIN,
    dex: result.position.dexId, symbol: result.position.symbol, tokenName: result.position.tokenName,
    pair: result.position.pairAddress, pool: result.position.poolAddress ?? "", ca: result.position.tokenAddress,
    quote: result.position.quoteSymbol, price: result.position.entryPrice, qty: result.position.quantity,
    notionalUsd: result.position.initialUsdSize, feeUsd: result.position.totalEntryFeeUsd,
    slipUsd: result.position.totalSlippageUsd, gasUsd: result.position.totalGasUsd, detail: `live:${result.quote.source}:${result.executionHash}`,
    balanceAfterUsd: portfolio.cashUsd, equityAfterUsd: null,
  });
  await notify(buildBuyMessage(result.position, config.entry.maxOpenPositions, liveOpenCount(), cashBefore, liveCashUsd()));
  log(`💰 RH LIVE BUY ${result.position.symbol} entry=${result.position.entryPrice} qty=${result.position.quantity} hash=${result.executionHash}`);
}

async function fireConfirms(): Promise<void> {
  const now = Date.now();
  for (const [key, item] of [...pendingConfirms]) {
    if (item.fireAt > now) continue;
    pendingConfirms.delete(key);
    const pair = await getPair(CHAIN, item.candidate.pairAddress).catch(() => null);
    if (!pair) continue;
    const secondPrice = parsePrice(pair);
    if (secondPrice === null) continue;
    const secondLiquidity = pairLiquidityUsd(pair);
    const verdict = assessConfirmation(
      { price: item.firstPrice, liquidityUsd: item.firstLiquidity },
      { price: secondPrice, liquidityUsd: secondLiquidity },
      config.entry.confirmMaxPriceDropPct, config.entry.confirmMaxLiqDropPct,
    );
    if (!verdict.ok) continue;

    // Discovery applies the age/liquidity band, but the 3s confirmation
    // delay can move a candidate outside that band before BUY. Treat this as
    // a hard final-entry gate so paper and live executions obey the strategy
    // that the startup/reporting config advertises.
    if (!isPoolEntryBandValid(item.candidate.poolCreatedAt, secondLiquidity)) {
      log(`⏭️ skip entry ${item.candidate.tokenSymbol}: final band check failed (age=${ageSec(item.candidate.poolCreatedAt).toFixed(1)}s liq=$${secondLiquidity ?? "unknown"})`);
      continue;
    }

    if (!entryGates() || sameSymbolOpen(item.candidate.tokenSymbol)) continue;
    if (config.mode === "paper") {
      if (config.entry.auto) {
        // Paper entries clear the same live-router quote + 3% deviation gate
        // as liveBuy: unroutable entries are skipped, not filled at fantasy marks.
        const probe = await probeBuyQuote(item.candidate, pair, secondPrice, config.entry.positionSizeUsd);
        if (!probe.ok) { log(`⏭️ skip entry ${item.candidate.tokenSymbol}: buy probe failed (${probe.reason})`); continue; }
        if (!probe.quoted) log(`⚠️ entry ${item.candidate.tokenSymbol}: probe balance-limited, deviation gate skipped until wallet funded`);
        await paperOpen(item.candidate, pair, secondPrice, probe.quoted ? probe : null);
      }
    } else {
      try { await liveOpen(item.candidate, pair); }
      catch (e) { log(`🛑 RH live BUY refused/failed ${item.candidate.tokenSymbol}: ${String(e).slice(0, 260)}`); }
    }
  }
}

async function paperTick(p: Position, pair: DexScreenerPair): Promise<void> {
  const price = parsePrice(pair);
  if (price === null) return;
  const now = Date.now();
  const tickLiq = pairLiquidityUsd(pair);
  const events = updatePosition(p, price, now, tickLiq === null ? {} : { liquidityUsd: tickLiq });
  for (const e of events) {
    if (e.type === "TP") {
      const cashBefore = portfolio.cashUsd;
      // Live-shadow exit: fill at the quoted output when routable (same
      // router + deviation gate as liveSell); otherwise fall back to the
      // mark fill with the pessimism stack.
      const exec = await quoteSellExec(p, pair, e.soldQty, `TP${e.level}`, e.price).catch((err): SellExec => ({ status: "unavailable", reason: String(err).slice(0, 120) }));
      const proceeds = exec.status === "quoted" ? exec.proceedsUsd : e.proceedsUsd;
      const gas = exec.status === "quoted" ? exec.gasUsd : config.entry.gasPerFillUsd;
      const exitPrice = e.soldQty > 0 ? proceeds / e.soldQty : e.price;
      portfolio.onProceeds(proceeds);
      applyPaperGas(p, "EXIT", gas);
      if (exec.status !== "quoted") applyExitHaircut(p, proceeds);
      // Quoted fills replace the mark proceeds with the executable output.
      p.realizedPnlUsd += proceeds - e.proceedsUsd;
      const prev = ledgerCosts.get(p.id) ?? { fee: 0, slip: 0 };
      const feeDelta = p.totalExitFeeUsd - prev.fee;
      const slipDelta = p.totalSlippageUsd - prev.slip;
      ledgerCosts.set(p.id, { fee: p.totalExitFeeUsd, slip: p.totalSlippageUsd });
      await recordFill({ time: now, side: "SELL", positionId: p.id, chain: CHAIN, dex: p.dexId, symbol: p.symbol, tokenName: p.tokenName, pair: p.pairAddress, pool: p.poolAddress ?? "", ca: p.tokenAddress, quote: p.quoteSymbol, price: exitPrice, qty: e.soldQty, notionalUsd: proceeds, feeUsd: feeDelta, slipUsd: slipDelta, gasUsd: gas, detail: `TP${e.level}${exec.status === "quoted" ? ":quoted" : ""}`, balanceAfterUsd: portfolio.cashUsd, equityAfterUsd: portfolio.equityUsd(positions.values()) });
      await notify(buildTpMessage(p, e.level, e.gainPct, e.soldQty, proceeds, e.realizedPnlUsd + (proceeds - e.proceedsUsd) - gas, e.remainingPct, cashBefore, portfolio.cashUsd));
    }
    if (e.type === "TRAIL_ACTIVATED") await notify(buildUpdateMessage("TRAIL", p, e.trailStop, portfolio.cashUsd));
    if (e.type === "STOP_MOVED") await notify(buildUpdateMessage("BREAKEVEN", p, e.stopPrice, portfolio.cashUsd));
    if (isRealizedSellEvent(e) && e.type !== "TP") {
      const cashBefore = portfolio.cashUsd;
      let proceeds = e.proceedsUsd;
      let exitPrice = e.price;
      let gas = config.entry.gasPerFillUsd;
      let quoted = false;
      if (e.soldQty > 0) {
        const exec = await quoteSellExec(p, pair, e.soldQty, e.type, e.price).catch((err): SellExec => ({ status: "unavailable", reason: String(err).slice(0, 120) }));
        if (exec.status === "quoted") {
          quoted = true;
          proceeds = exec.proceedsUsd;
          gas = exec.gasUsd;
          exitPrice = proceeds / e.soldQty;
        }
      }
      portfolio.onProceeds(proceeds);
      applyPaperGas(p, "EXIT", gas);
      if (!quoted) applyExitHaircut(p, proceeds);
      // Quoted fills replace the mark proceeds with the executable output.
      p.realizedPnlUsd += proceeds - e.proceedsUsd;
      const exitLiq = pairLiquidityUsd(pair); if (exitLiq !== null) p.exitLiquidityUsd = exitLiq;
      p.balanceAfterUsd = portfolio.equityUsd([...positions.values()].filter((x) => x.id !== p.id));
      portfolio.onClose(p);
      positions.delete(p.id); lastSnapshotAt.delete(p.id);
      const prev = ledgerCosts.get(p.id) ?? { fee: p.totalEntryFeeUsd, slip: 0 };
      ledgerCosts.delete(p.id);
      await recordFill({ time: now, side: "SELL", positionId: p.id, chain: CHAIN, dex: p.dexId, symbol: p.symbol, tokenName: p.tokenName, pair: p.pairAddress, pool: p.poolAddress ?? "", ca: p.tokenAddress, quote: p.quoteSymbol, price: exitPrice, qty: e.soldQty, notionalUsd: proceeds, feeUsd: p.totalExitFeeUsd - prev.fee, slipUsd: p.totalSlippageUsd - prev.slip, gasUsd: gas, detail: `${e.type}${quoted ? ":quoted" : ""}`, balanceAfterUsd: portfolio.cashUsd, equityAfterUsd: p.balanceAfterUsd ?? portfolio.cashUsd });
      await recordTrade(tradeRecordFromPosition(p, { pnlUsd: p.realizedPnlUsd, pnlPct: p.initialUsdSize > 0 ? p.realizedPnlUsd / p.initialUsdSize * 100 : 0, balanceBeforeUsd: p.balanceBeforeUsd ?? NaN, balanceAfterUsd: p.balanceAfterUsd ?? NaN }));
      await notify(buildCloseMessage(p, portfolio.snapshot(positions.values()), portfolio.chainStat(CHAIN), portfolio.tokenPnlUsd(CHAIN, p.symbol)));
      persist(true); break;
    }
  }
  if (positions.has(p.id) && p.status === "OPEN" && now - (lastSnapshotAt.get(p.id) ?? 0) >= config.snapshots.intervalS * 1000) {
    lastSnapshotAt.set(p.id, now);
    await recordSnapshot({ time: now, positionId: p.id, chain: CHAIN, symbol: p.symbol, price, liquidityUsd: pairLiquidityUsd(pair), txnsJson: JSON.stringify(pair.txns ?? null) });
  }
}

async function applyLiveSellFill(
  p: Position,
  pair: DexScreenerPair,
  _kind: "TP" | "EXIT",
  _level: number | undefined,
  _reason: string,
  sell: { orderId: string; result: { hash: string; sellAmount: string; buyAmount: string; gasUsd: number }; exitPriceUsd: number; realizedPnlUsd: number; gasUsd: number },
): Promise<void> {
  const before = p.quantity;
  const orderId = sell.orderId;
  const live = getLivePosition(p.id);
  if (!live) throw new Error(`RH live position ${p.id} missing while applying SELL ${orderId}`);
  // The live journal is the canonical state transition. Then rebuild the
  // strategy position from that exact state so quantity/TP/exit-state cannot
  // diverge from the confirmed chain fill.
  await applyConfirmedLiveSell({ orderId, realizedPnlUsd: sell.realizedPnlUsd });
  const rebuilt = restoredStrategyPositions().find((x) => x.id === p.id);
  if (!rebuilt) throw new Error(`RH strategy position ${p.id} unavailable after confirmed SELL`);
  Object.assign(p, rebuilt);
  const outEth = Number(BigInt(sell.result.buyAmount)) / 1e18;
  const ethUsd = Number(pair.priceUsd) / Number(pair.priceNative);
  const proceedsUsd = outEth > 0 && Number.isFinite(ethUsd) && ethUsd > 0 ? outEth * ethUsd : NaN;
  syncLivePortfolioCash();
  exitCash.set(p.id, {
    before: portfolio.cashUsd - (Number.isFinite(proceedsUsd) ? proceedsUsd : 0) + (sell.gasUsd ?? 0),
    after: portfolio.cashUsd,
  });
  await recordFill({
    time: Date.now(), side: "SELL", positionId: p.id, chain: CHAIN, dex: p.dexId, symbol: p.symbol,
    tokenName: p.tokenName, pair: p.pairAddress, pool: p.poolAddress ?? "", ca: p.tokenAddress,
    quote: p.quoteSymbol, price: sell.exitPriceUsd,
    qty: before - p.quantity, notionalUsd: Number.isFinite(proceedsUsd) ? proceedsUsd : Math.max(0, sell.exitPriceUsd * (before - p.quantity)),
    feeUsd: sell.gasUsd, slipUsd: 0, gasUsd: sell.gasUsd, detail: `live:${_kind}${_level ? `:TP${_level}` : ""}:${sell.result.hash}`,
    balanceAfterUsd: portfolio.cashUsd, equityAfterUsd: null,
  });
  persist(true);
}

async function onLivePositionClosed(p: Position): Promise<void> {
  const existing = portfolio.hasClosed(p.id);
  if (!existing) {
    portfolio.onClose(p);
    await recordTrade(tradeRecordFromPosition(p, {
      pnlUsd: p.realizedPnlUsd,
      pnlPct: p.initialUsdSize > 0 ? p.realizedPnlUsd / p.initialUsdSize * 100 : 0,
      balanceBeforeUsd: p.balanceBeforeUsd ?? NaN,
      balanceAfterUsd: p.balanceAfterUsd ?? portfolio.cashUsd,
    }));
  }
  syncLivePortfolioCash();
  const exitLeg = exitCash.get(p.id);
  exitCash.delete(p.id);
  await notify(buildLiveClosedMessage(p.symbol, p.closedReason ?? "EXIT", p.realizedPnlUsd, liveStatus().dailyRealizedPnlUsd, exitLeg?.before, liveCashUsd()));
  finalizeLivePosition(p.id);
  positions.delete(p.id);
  lastSnapshotAt.delete(p.id);
  ledgerCosts.delete(p.id);
  persist(true);
}

async function liveTick(p: Position, pair: DexScreenerPair): Promise<void> {
  const price = parsePrice(pair);
  if (price === null || p.status !== "OPEN") return;
  const now = Date.now();
  const candidate = structuredClone(p);
  const liveLiq = pairLiquidityUsd(pair);
  const events = updatePosition(candidate, price, now, liveLiq === null ? {} : { liquidityUsd: liveLiq });

  // Copy only mark/stop state. Quantity, realized PnL, TP flags, and CLOSED
  // status are changed only by confirmed chain receipts.
  p.currentPrice = candidate.currentPrice;
  p.updatedAt = candidate.updatedAt;
  p.highestPrice = candidate.highestPrice;
  p.lowestPrice = candidate.lowestPrice;
  p.highestAt = candidate.highestAt;
  p.lowestAt = candidate.lowestAt;
  p.trailingActive = candidate.trailingActive;
  p.breakevenArmed = candidate.breakevenArmed;
  if (candidate.trailHigh === undefined) delete p.trailHigh; else p.trailHigh = candidate.trailHigh;
  if (candidate.highStreak === undefined) delete p.highStreak; else p.highStreak = candidate.highStreak;

  for (const e of events) {
    if (e.type === "TRAIL_ACTIVATED") await notify(buildUpdateMessage("TRAIL", p, e.trailStop, liveCashUsd()));
    if (e.type === "STOP_MOVED") await notify(buildUpdateMessage("BREAKEVEN", p, e.stopPrice, liveCashUsd()));
    if (["TP", "TRAIL_EXIT", "STOP_EXIT", "EARLY_EXIT", "BREAKEVEN_EXIT", "DRAIN_EXIT", "TIME_EXIT"].includes(e.type)) {
      const kind = e.type === "TP" ? "TP" as const : "EXIT" as const;
      const level = e.type === "TP" ? e.level : undefined;
      const label = e.type === "TP" ? `TP${e.level}` : "EXIT";
      if (!isLiveSellPending(p.id, label)) {
        if (queueLiveSell({ positionId: p.id, kind, ...(level !== undefined ? { level } : {}), label })) log(`⏳ RH ${label} ${p.symbol} queued`);
      }
    }
  }
  syncLiveStrategyState(p, events.length > 0);
  if (p.status === "OPEN" && now - (lastSnapshotAt.get(p.id) ?? 0) >= config.snapshots.intervalS * 1000) {
    lastSnapshotAt.set(p.id, now);
    await recordSnapshot({ time: now, positionId: p.id, chain: CHAIN, symbol: p.symbol, price, liquidityUsd: pairLiquidityUsd(pair), txnsJson: JSON.stringify(pair.txns ?? null) });
  }
}

async function trackPositions(): Promise<void> {
  const open = [...positions.values()].filter((p) => p.status === "OPEN");
  if (!open.length) return;
  const pairs = await getPairsByChain(CHAIN, open.map((p) => p.pairAddress));
  const map = new Map(pairs.map((p) => [p.pairAddress.toLowerCase(), p]));
  for (const p of open) {
    const pair = map.get(p.pairAddress.toLowerCase()) ?? await getPair(CHAIN, p.pairAddress).catch(() => null);
    if (!pair) continue;
    if (config.mode === "paper") await paperTick(p, pair); else await liveTick(p, pair);
  }
}

async function reconcileRecoveredPositions(): Promise<void> {
  if (config.mode !== "live") return;
  syncLivePortfolioCash();
  for (const recovered of restoredStrategyPositions()) {
    if (recovered.status === "CLOSED") await onLivePositionClosed(recovered);
    else positions.set(recovered.id, recovered);
  }
  syncLivePortfolioCash();
}

async function health(): Promise<void> {
  for (const [k, t] of [...seenPools]) if (Date.now() - t > 30 * 60_000) seenPools.delete(k);
  if (config.mode === "live") { flushLiveState(); syncLivePortfolioCash(); }
  else persist(false);
  // Bound the DuckDB WAL and keep external copies fresh: checkpoint at most
  // every 5 minutes. Failures are best-effort inside checkpointAnalytics.
  if (Date.now() - lastCheckpointAt >= 5 * 60_000) {
    lastCheckpointAt = Date.now();
    await checkpointAnalytics().catch(() => {});
  }
}

async function loop(name: string, interval: number, fn: () => Promise<void>): Promise<never> {
  while (!shuttingDown) {
    try { await fn(); } catch (e) { log(`⚠️ ${name}: ${String(e).slice(0, 400)}`); }
    await new Promise((r) => setTimeout(r, interval));
  }
  return await new Promise<never>(() => {});
}

function traderSummary(): string { try { return traderAddress(); } catch { return "not configured"; } }

async function main(): Promise<void> {
  claimInstanceLockForStateFile(config.mode === "live" ? config.liveState.stateFile : config.recovery.stateFile);
  console.log("============================================");
  console.log(" Robinhood Chain New-Pool Trading Bot");
  console.log("============================================");
  console.log(`Mode                : ${config.mode}`);
  console.log(`Chain               : Robinhood (4663)`);
  console.log(`Discovery           : DexPaprika ${config.dexPaprika.minAgeSec}-${config.dexPaprika.maxAgeSec}s | $${config.dexPaprika.minLiquidityUsd}-${config.dexPaprika.maxLiquidityUsd}`);
  console.log(`Confirmation        : ${config.entry.confirmDelayMs}ms`);
  console.log(`Position            : $${config.entry.positionSizeUsd} | max ${config.entry.maxOpenPositions} | same symbol ${config.entry.maxSameSymbolOpen}`);
  console.log(`Exit                : TP ${config.tp.map((x) => x.gainPct).join("/")} | trail +${config.stops.trailActivationPct}/${config.stops.trailDistancePct}% | hold ${config.entry.maxPositionAgeMin}m`);
  console.log(`Price               : DexScreener @ ${config.dexScreener.intervalMs}ms`);
  console.log(`0x                  : ${config.live.zeroExKey ? "key present" : "key absent"}`);
  console.log(`Wallet              : ${config.live.enabled ? traderSummary() : "paper"}`);

  await initAnalytics();
  log(`Analytics           : ${analyticsStatus()}`);
  restore();

  if (config.live.enabled) {
    await initLive(log);
    syncLivePortfolioCash();
    if (config.live.testTrade) {
      try { await runLiveSmokeTest(log); }
      catch (e) { latchHalt(`smoke test failed: ${String(e).slice(0, 200)}`, log); await notify(`🛑 RH smoke test FAILED: ${String(e).slice(0, 200)}. Live entries halted.`); }
    }
    await reconcileRecoveredPositions();
    catchUpLiveSells(new Set([...positions.values()].filter((p) => p.status === "OPEN").map((p) => p.id)), log);
    flushLiveState();
  }

  if (config.telegram.enabled) {
    await testTelegram();
    await notify(buildStartupMessage({ mode: config.mode, autoEntry: config.entry.auto, size: config.entry.positionSizeUsd, maxOpen: config.entry.maxOpenPositions, analytics: analyticsStatus(), live: config.live.enabled, ...(config.live.enabled ? { wallet: traderSummary() } : {}), cashUsd: config.mode === "live" ? liveCashUsd() : portfolio.cashUsd }));
  }

  await Promise.all([
    loop("discovery", config.dexPaprika.intervalMs, discover),
    loop("confirms", 1_000, fireConfirms),
    loop("price", config.dexScreener.intervalMs, trackPositions),
    loop("health", 10_000, health),
    loop("live-sells", 2_000, () => pumpLiveSells({
      log,
      notify,
      getPosition: (id) => positions.get(id),
      fetchPair: (pairAddress) => getPair(CHAIN, pairAddress).catch(() => null),
      applyFill: applyLiveSellFill,
      onClosed: onLivePositionClosed,
      openPaperIds: () => new Set([...positions.values()].filter((p) => p.status === "OPEN").map((p) => p.id)),
    })),
  ]);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (config.mode === "live") flushLiveState(); else persist(true);
  try { await closeAnalytics(); } catch {}
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await main();
