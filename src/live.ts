import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Candidate, DexScreenerPair, ExecutionResult, LiveOrder, LivePosition, LiveStrategyState, Position, Quote } from "./types.ts";
import { config, RH, NATIVE, isEthVenueQuote, robinhoodExitProfile } from "./config.ts";
import { getBestExecutableQuote, makeQuoteRequest } from "./execution/router.ts";
import { executeQuote, extractExecutionAmounts, gasUsdFromExecution, isNative, tokenBalance } from "./execution/evm/live.ts";
import { assertRobinhoodInfrastructure, getEvmPublicClient, traderAccount, traderAddress } from "./execution/evm/viem-client.ts";
import { telegram } from "./telegram.ts";
import { pairLiquidityUsd } from "./dexscreener.ts";
import { buildLiveFillConfirmedMessage, buildLiveSubmittedMessage } from "./report.ts";
import { openPosition, updatePosition } from "./position.ts";
import { applyStrategyState, captureStrategyState, legacyStrategyState } from "./live-state.ts";

type LockedStatus = LiveOrder["status"];

export interface PendingLiveSell {
  positionId: string;
  kind: "TP" | "EXIT";
  level?: number;
  label: string;
  attempts: number;
  nextAttemptAt: number;
}

interface LiveStateFile {
  version: 6;
  savedAt: number;
  dailyRealizedPnlUsd: number;
  dailyPnlDay: string;
  halted: boolean;
  orders: LiveOrder[];
  openPositions: LivePosition[];
  pendingSells: PendingLiveSell[];
  portfolioCashUsd: number;
}

const LOCKED = new Set<LockedStatus>(["SIGNAL", "SUBMITTED", "CONFIRMED", "UNKNOWN"]);
const EXIT_REASONS = new Set(["TRAIL_EXIT", "STOP_EXIT", "EARLY_STOP", "BREAKEVEN_STOP", "DRAIN_EXIT", "TIME_EXIT"]);
const SELL_STEPS = [1, 4 / 3, 5 / 3] as const;
const SELL_SWEEP_MS = 60_000;

let orders: LiveOrder[] = [];
let livePositions = new Map<string, LivePosition>();
let pendingSells: PendingLiveSell[] = [];
let dailyRealizedPnlUsd = 0;
let dailyPnlDay = "";
let halted = false;
let initialized = false;
let portfolioCashUsd = config.portfolio.initialBalanceUsd;
let pumping = false;
let lastSweepAt = 0;
const sweepAlerted = new Set<string>();
const strategyPersistAt = new Map<string, number>();
const liveStopCloses: number[] = [];

function dayKey(now = Date.now()): string { return new Date(now).toISOString().slice(0, 10); }
function ensureDir(path: string): void { mkdirSync(dirname(path), { recursive: true }); }
function atomicJson(path: string, value: unknown): void {
  ensureDir(path);
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}
function compactOrders(input: LiveOrder[]): LiveOrder[] {
  const keepMs = config.live.orderRetentionDays * 86_400_000;
  const cutoff = Date.now() - keepMs;
  return input.filter((o) => LOCKED.has(o.status) || (o.status !== "APPLIED" && o.status !== "FAILED") || o.updatedAt >= cutoff);
}
function persist(): void {
  orders = compactOrders(orders);
  const state: LiveStateFile = {
    version: 6,
    savedAt: Date.now(),
    dailyRealizedPnlUsd,
    dailyPnlDay,
    halted,
    orders: [...orders],
    openPositions: [...livePositions.values()],
    pendingSells: [...pendingSells],
    portfolioCashUsd,
  };
  // One canonical commit keeps recovery coherent. The mirror files are for operators.
  atomicJson(config.liveState.stateFile, state);
  try { atomicJson(config.liveState.ordersFile, orders); } catch {}
  try { atomicJson(config.liveState.positionsFile, [...livePositions.values()]); } catch {}
}
function killSwitchActive(): boolean { return readJson<{ killed?: boolean }>(config.liveState.killFile, {}).killed === true; }
function killEntries(): void { atomicJson(config.liveState.killFile, { killed: true, at: Date.now() }); halted = true; persist(); }
export function clearKillSwitch(): void { atomicJson(config.liveState.killFile, { killed: false, at: Date.now() }); halted = false; persist(); }
export function latchHalt(reason: string, log?: (msg: string) => void): void { halted = true; persist(); log?.(`🛑 RH live entries halted: ${reason}`); }
export function liveCashUsd(): number { return portfolioCashUsd; }

function adjustLiveCashUsd(deltaUsd: number): void {
  if (!Number.isFinite(deltaUsd)) throw new Error(`invalid live cash delta ${deltaUsd}`);
  portfolioCashUsd += deltaUsd;
  if (portfolioCashUsd < -0.01) { halted = true; throw new Error(`live accounting cash went negative: ${portfolioCashUsd}`); }
}

function resetDailyIfNeeded(): void {
  const d = dayKey();
  if (dailyPnlDay !== d) { dailyPnlDay = d; dailyRealizedPnlUsd = 0; persist(); }
}

export function liveEntryAllowed(): boolean {
  if (!initialized || !config.live.enabled || halted || killSwitchActive()) return false;
  resetDailyIfNeeded();
  if (dailyRealizedPnlUsd <= -config.risk.maxDailyLiveLossUsd) return false;
  if (orders.some((o) => LOCKED.has(o.status))) return false;
  if (liveOpenCount() >= config.entry.maxOpenPositions) return false;
  return true;
}

export function liveOpenCount(): number {
  let n = 0;
  for (const p of livePositions.values()) if (BigInt(p.remainingQtyRaw) > 0n && p.strategy.status === "OPEN") n++;
  return n;
}
export function getLivePosition(positionId: string): LivePosition | undefined { return livePositions.get(positionId); }

function makeStrategyFromLive(p: LivePosition): Position {
  const strategy = p.strategy ?? legacyStrategyState(p, robinhoodExitProfile());
  const position = openPosition({
    id: p.positionId, chain: RH.chain, pairAddress: p.pairAddress, tokenAddress: p.tokenAddress,
    symbol: p.tokenSymbol, tokenName: p.tokenName, quoteSymbol: p.quoteSymbol, dexId: p.dexId,
    ...(p.pairUrl ? { pairUrl: p.pairUrl } : {}), marketPrice: strategy.currentPrice > 0 ? strategy.currentPrice : p.entryPriceUsd,
    usdSize: p.entryCostUsd, entryLiquidityUsd: p.entryLiquidityUsd, entryAgeSec: p.entryAgeSec,
    exitProfile: strategy.exitProfile, now: p.openedAt,
  });
  position.quantity = Number(BigInt(p.remainingQtyRaw)) / 10 ** p.tokenDecimals;
  position.originalQuantity = Number(BigInt(p.originalQtyRaw)) / 10 ** p.tokenDecimals;
  position.initialUsdSize = p.entryCostUsd;
  position.entryPrice = p.entryPriceUsd;
  position.realizedPnlUsd = p.realizedPnlUsd - (p.entryGasUsd ?? 0);
  position.totalEntryFeeUsd = p.entryGasUsd ?? 0;
  position.totalExitFeeUsd = 0;
  position.totalSlippageUsd = 0;
  position.totalGasUsd = p.entryGasUsd ?? 0;
  applyStrategyState(position, strategy);
  return position;
}

export function restoredStrategyPositions(): Position[] {
  const out: Position[] = [];
  for (const p of livePositions.values()) {
    if (!p.strategy) p.strategy = legacyStrategyState(p, robinhoodExitProfile());
    try { out.push(makeStrategyFromLive(p)); } catch { halted = true; }
  }
  return out;
}

export function syncLiveStrategyState(position: Position, force = false): void {
  const lp = livePositions.get(position.id);
  if (!lp) return;
  const now = Date.now();
  lp.strategy = captureStrategyState(position);
  lp.updatedAt = now;
  const last = strategyPersistAt.get(position.id) ?? 0;
  if (force || now - last >= 2_000) {
    strategyPersistAt.set(position.id, now);
    persist();
  }
}
export function flushLiveState(): void { persist(); }

export function finalizeLivePosition(positionId: string): void {
  const lp = livePositions.get(positionId);
  if (!lp) return;
  if (BigInt(lp.remainingQtyRaw) !== 0n || lp.strategy.status !== "CLOSED") throw new Error(`cannot finalize RH position ${positionId}`);
  livePositions.delete(positionId);
  pendingSells = pendingSells.filter((q) => q.positionId !== positionId);
  persist();
}

function createOrder(args: Omit<LiveOrder, "id" | "status" | "createdAt" | "updatedAt">): LiveOrder {
  const now = Date.now();
  return { ...args, id: `${now}-${crypto.randomUUID().slice(0, 10)}`, status: "SIGNAL", createdAt: now, updatedAt: now };
}
function findOrder(id: string): LiveOrder | undefined { return orders.find((o) => o.id === id); }
function updateOrder(id: string, patch: Partial<LiveOrder>): LiveOrder {
  const order = findOrder(id);
  if (!order) throw new Error(`RH live order ${id} missing`);
  Object.assign(order, patch, { updatedAt: Date.now() });
  persist();
  return order;
}
function orderForSell(positionId: string, label: string): LiveOrder | undefined {
  return orders.find((o) => o.positionId === positionId && o.side === "SELL" && (o.label ?? "") === label && LOCKED.has(o.status));
}
function orderByTx(hash: string): LiveOrder | undefined { return orders.find((o) => o.txHash?.toLowerCase() === hash.toLowerCase()); }
function looksUnknown(error: unknown): boolean { return /(timeout|timed out|network|socket|503|502|429|broadcast)/i.test(String(error)); }
/** Deterministic on-chain revert (receipt received, status reverted). */
export function isRevertError(error: unknown): boolean { return /revert/i.test(String(error)); }
/**
 * Classify a post-submit failure: a KNOWN revert marks the order FAILED so
 * retries build a fresh order instead of bouncing off "already pending".
 * Unknown/network failures keep the fail-closed UNKNOWN path.
 */
function classifySubmitFailure(orderId: string, error: unknown): void {
  const current = findOrder(orderId);
  if (current?.status === "SIGNAL") {
    if (looksUnknown(error)) { current.status = "UNKNOWN"; current.note = String(error).slice(0, 500); halted = true; persist(); }
    else updateOrder(orderId, { status: "FAILED", note: String(error).slice(0, 500) });
  } else if (current && (current.status === "SUBMITTED" || current.status === "CONFIRMED") && isRevertError(error)) {
    updateOrder(orderId, { status: "FAILED", note: `transaction reverted: ${String(error).slice(0, 400)}` });
  } else if (looksUnknown(error)) { halted = true; persist(); }
}
function ethUsdFromPair(pair: DexScreenerPair): number | null {
  const usd = Number(pair.priceUsd), native = Number(pair.priceNative);
  if (!(usd > 0) || !(native > 0)) return null;
  const value = usd / native;
  return Number.isFinite(value) && value > 0 ? value : null;
}
function usdToEthRaw(sizeUsd: number, ethUsd: number): string {
  if (!(sizeUsd > 0) || !(ethUsd > 0)) throw new Error("invalid ETH conversion");
  const raw = BigInt(Math.floor(sizeUsd / ethUsd * 1e18));
  if (raw <= 0n) throw new Error("position size converts to zero ETH");
  return raw.toString();
}
function reasonForEvent(type: string): string {
  if (type === "TRAIL_EXIT") return "TRAIL_EXIT";
  if (type === "TIME_EXIT") return "TIME_EXIT";
  if (type === "DRAIN_EXIT") return "DRAIN_EXIT";
  if (type === "EARLY_EXIT") return "EARLY_STOP";
  if (type === "BREAKEVEN_EXIT") return "BREAKEVEN_STOP";
  return "STOP_EXIT";
}

async function receiptAmounts(order: LiveOrder): Promise<{ sellAmount: string; buyAmount: string; gasUsd?: number }> {
  if (!order.txHash) throw new Error(`order ${order.id} has no tx hash`);
  const receipt = await getEvmPublicClient().getTransactionReceipt({ hash: order.txHash as `0x${string}` });
  if (receipt.status !== "success") throw new Error(`transaction ${order.txHash} reverted`);
  const amount = extractExecutionAmounts(receipt.logs as never, traderAddress(), order.sellToken, order.buyToken, order.requestedSellRaw);
  const ethUsd = order.exitEthUsd ?? order.entryEthUsd;
  const gasUsd = ethUsd && receipt.gasUsed && receipt.effectiveGasPrice ? gasUsdFromExecution({ ok: true, hash: order.txHash, sellAmount: amount.sellAmount, buyAmount: amount.buyAmount, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString() }, ethUsd) : 0;
  return { ...amount, gasUsd };
}

function migrationLoad(): void {
  const state = readJson<Partial<Omit<LiveStateFile, "version">> & { version?: number }>(config.liveState.stateFile, {});
  if ((state.version === 5 || state.version === 6) && Array.isArray(state.orders) && Array.isArray(state.openPositions)) {
    orders = state.orders.filter(Boolean) as LiveOrder[];
    livePositions = new Map((state.openPositions as LivePosition[]).filter((p) => p?.positionId).map((p) => [p.positionId, p]));
    pendingSells = Array.isArray(state.pendingSells) ? state.pendingSells.filter((q) => q?.positionId && q?.label) : [];
  } else {
    orders = readJson<LiveOrder[]>(config.liveState.ordersFile, []).filter(Boolean);
    const saved = readJson<LivePosition[]>(config.liveState.positionsFile, []);
    livePositions = new Map(saved.filter((p) => p?.positionId).map((p) => {
      if (!p.strategy) p.strategy = legacyStrategyState(p, robinhoodExitProfile());
      return [p.positionId, p] as const;
    }));
    pendingSells = [];
  }
  dailyRealizedPnlUsd = Number.isFinite(state.dailyRealizedPnlUsd) ? Number(state.dailyRealizedPnlUsd) : 0;
  dailyPnlDay = typeof state.dailyPnlDay === "string" && state.dailyPnlDay ? state.dailyPnlDay : dayKey();
  portfolioCashUsd = Number.isFinite(state.portfolioCashUsd) && Number(state.portfolioCashUsd) >= 0 ? Number(state.portfolioCashUsd) : config.portfolio.initialBalanceUsd;
  halted = state.halted === true;
}

async function reconcileConfirmedBuy(order: LiveOrder, log: (msg: string) => void): Promise<void> {
  if (order.status !== "CONFIRMED" || order.side !== "BUY" || order.kind !== "ENTRY" || !order.positionId) return;
  if (livePositions.has(order.positionId)) { order.status = "APPLIED"; order.updatedAt = Date.now(); return; }
  try {
    if (!order.tokenAddress || !order.tokenDecimals || !order.entryEthUsd || !order.pairAddress || !order.tokenSymbol || !order.tokenName || !order.dexId || !order.entryPriceUsd || !order.requestedSellRaw) throw new Error("confirmed BUY lacks recovery metadata");
    const fill = await receiptAmounts(order);
    const decimals = order.tokenDecimals;
    const qty = Number(BigInt(fill.buyAmount)) / 10 ** decimals;
    const ethSold = Number(BigInt(fill.sellAmount)) / 1e18;
    const costUsd = ethSold * order.entryEthUsd;
    const gasUsd = fill.gasUsd ?? 0;
    if (!(qty > 0) || !(costUsd > 0)) throw new Error("invalid recovered BUY economics");
    const p = openPosition({ id: order.positionId, chain: RH.chain, pairAddress: order.pairAddress, tokenAddress: order.tokenAddress, symbol: order.tokenSymbol, tokenName: order.tokenName, quoteSymbol: order.quoteSymbol ?? "ETH", dexId: order.dexId, ...(order.pairUrl ? { pairUrl: order.pairUrl } : {}), marketPrice: costUsd / qty, usdSize: costUsd, entryLiquidityUsd: order.entryLiquidityUsd ?? 0, entryAgeSec: order.entryAgeSec ?? 0, exitProfile: order.exitProfile ?? robinhoodExitProfile(), now: order.createdAt });
    p.quantity = qty; p.originalQuantity = qty; p.initialUsdSize = costUsd; p.entryPrice = costUsd / qty; p.currentPrice = p.entryPrice; p.realizedPnlUsd = -gasUsd; p.totalEntryFeeUsd = gasUsd; p.totalSlippageUsd = 0; p.totalExitFeeUsd = 0; p.totalGasUsd = gasUsd;
    const strategy = captureStrategyState(p);
    livePositions.set(order.positionId, {
      positionId: order.positionId, pairAddress: order.pairAddress, tokenAddress: order.tokenAddress, tokenSymbol: order.tokenSymbol, tokenName: order.tokenName, dexId: order.dexId, ...(order.pairUrl ? { pairUrl: order.pairUrl } : {}), quoteSymbol: "ETH", tokenDecimals: decimals, quoteToken: NATIVE, quoteDecimals: 18,
      originalQtyRaw: fill.buyAmount, remainingQtyRaw: fill.buyAmount, entryCostQuoteRaw: fill.sellAmount, entryCostUsd: costUsd, entryPriceUsd: costUsd / qty, entryLiquidityUsd: order.entryLiquidityUsd ?? 0, entryAgeSec: order.entryAgeSec ?? 0, entryGasUsd: gasUsd, realizedPnlUsd: 0, openedAt: order.createdAt, updatedAt: Date.now(), strategy,
    });
    adjustLiveCashUsd(-(costUsd + gasUsd));
    order.executedSellRaw = fill.sellAmount; order.executedBuyRaw = fill.buyAmount; order.gasUsd = gasUsd; order.status = "APPLIED"; order.updatedAt = Date.now();
    persist();
    log(`♻️ RH recovered BUY ${order.positionId} from receipt`);
  } catch (error) { halted = true; order.note = `BUY recovery failed: ${String(error).slice(0, 220)}`; persist(); log(`🛑 RH BUY recovery failed ${order.id}: ${String(error).slice(0, 220)}`); }
}

function strategyAfterSell(lp: LivePosition, order: LiveOrder, soldRaw: string, realizedPnlUsd: number): LiveStrategyState {
  const p = makeStrategyFromLive(lp);
  const sold = BigInt(soldRaw);
  const remaining = BigInt(lp.remainingQtyRaw) - sold;
  if (remaining < 0n) throw new Error("sell exceeds remaining quantity");
  const exitPrice = order.exitPriceUsd ?? p.currentPrice;
  p.currentPrice = exitPrice;
  p.highestPrice = Math.max(p.highestPrice, exitPrice);
  p.lowestPrice = Math.min(p.lowestPrice, exitPrice);
  p.quantity = Number(remaining) / 10 ** lp.tokenDecimals;
  p.realizedPnlUsd += realizedPnlUsd;
  if (order.kind === "TP" && order.level && order.level >= 1 && order.level <= 3) p.tpHit[order.level - 1] = true;
  if (order.kind === "EXIT" || p.quantity <= 0) {
    p.status = "CLOSED";
    p.closedAt = Date.now();
    p.closedReason = order.reason ?? "EXIT";
    p.exitTriggerPrice = exitPrice;
  }
  p.updatedAt = Date.now();
  return captureStrategyState(p);
}

export async function applyConfirmedLiveSell(args: {
  orderId: string;
  realizedPnlUsd: number;
}): Promise<LiveOrder> {
  const order = findOrder(args.orderId);
  if (!order) throw new Error(`RH sell order ${args.orderId} missing`);
  if (order.status === "APPLIED") return order;
  if (order.status !== "CONFIRMED" || order.side !== "SELL" || !order.positionId || !order.executedSellRaw || !order.executedBuyRaw) throw new Error(`RH sell order ${args.orderId} is not a confirmed executable fill`);
  const lp = livePositions.get(order.positionId);
  if (!lp) throw new Error(`RH live position ${order.positionId} missing for confirmed SELL`);
  const sold = BigInt(order.executedSellRaw);
  const remaining = BigInt(lp.remainingQtyRaw);
  if (sold <= 0n || sold > remaining) throw new Error(`SELL quantity ${sold} exceeds remaining ${remaining}`);
  const nextRemaining = remaining - sold;
  const strategy = strategyAfterSell(lp, order, order.executedSellRaw, args.realizedPnlUsd);
  lp.remainingQtyRaw = nextRemaining.toString();
  lp.realizedPnlUsd += args.realizedPnlUsd;
  lp.strategy = strategy;
  lp.updatedAt = Date.now();
  const exitEthUsd = order.exitEthUsd ?? order.entryEthUsd;
  const proceedsUsd = exitEthUsd && exitEthUsd > 0 ? Number(BigInt(order.executedBuyRaw)) / 1e18 * exitEthUsd : NaN;
  if (!(proceedsUsd > 0) || !Number.isFinite(proceedsUsd)) throw new Error(`SELL ${order.id} missing valid proceeds valuation`);
  adjustLiveCashUsd(proceedsUsd - (order.gasUsd ?? 0));
  dailyRealizedPnlUsd += args.realizedPnlUsd;
  if (strategy.status === "CLOSED" && ["STOP_EXIT", "EARLY_STOP", "DRAIN_EXIT"].includes(strategy.closedReason ?? "")) killEntriesIfBreakerTrip(strategy.closedReason!);
  order.status = "APPLIED";
  order.updatedAt = Date.now();
  persist();
  return order;
}

async function reconcileConfirmedSell(order: LiveOrder, log: (msg: string) => void): Promise<void> {
  if (order.status !== "CONFIRMED" || order.side !== "SELL" || !order.positionId) return;
  const lp = livePositions.get(order.positionId);
  if (!lp) { halted = true; order.note = "confirmed SELL has no live position"; persist(); log(`🛑 RH SELL ${order.id} has no live position`); return; }
  try {
    if (!order.executedSellRaw || !order.executedBuyRaw) {
      const fill = await receiptAmounts(order);
      order.executedSellRaw = fill.sellAmount; order.executedBuyRaw = fill.buyAmount; order.gasUsd = fill.gasUsd ?? order.gasUsd ?? 0;
    }
    const soldUnits = Number(BigInt(order.executedSellRaw)) / 10 ** lp.tokenDecimals;
    const outEth = Number(BigInt(order.executedBuyRaw)) / 1e18;
    const ethUsd = order.exitEthUsd ?? order.entryEthUsd;
    if (!(soldUnits > 0) || !(outEth > 0) || !(ethUsd && ethUsd > 0)) throw new Error("confirmed SELL missing valuation metadata");
    order.exitPriceUsd ??= outEth * ethUsd / soldUnits;
    order.realizedPnlUsd ??= soldUnits * (order.exitPriceUsd - lp.entryPriceUsd) - (order.gasUsd ?? 0);
    await applyConfirmedLiveSell({ orderId: order.id, realizedPnlUsd: order.realizedPnlUsd });
    log(`♻️ RH applied confirmed SELL ${order.id}`);
  } catch (error) { halted = true; order.note = `SELL recovery failed: ${String(error).slice(0, 220)}`; persist(); log(`🛑 RH SELL recovery failed ${order.id}: ${String(error).slice(0, 220)}`); }
}

export async function initLive(log: (msg: string) => void): Promise<void> {
  if (!config.live.enabled) return;
  traderAccount();
  await assertRobinhoodInfrastructure();
  const client = getEvmPublicClient();
  const balance = await client.getBalance({ address: traderAddress() });
  const reserve = BigInt(Math.floor(config.live.minEthReserveEth * 1e18));
  migrationLoad();
  resetDailyIfNeeded();
  if (balance < reserve) {
    halted = true;
    log(`🛑 RH ETH reserve below minimum: ${(Number(balance) / 1e18).toFixed(6)} ETH < ${config.live.minEthReserveEth} ETH; entries halted, exits remain recoverable`);
  }
  for (const o of orders.filter((x) => LOCKED.has(x.status))) {
    if (!o.txHash) {
      o.status = "UNKNOWN"; o.note = `no tx hash at boot (${o.kind})`; halted = true; continue;
    }
    try {
      const receipt = await client.getTransactionReceipt({ hash: o.txHash as `0x${string}` });
      if (receipt.status === "success") { o.status = "CONFIRMED"; o.updatedAt = Date.now(); }
      else { o.status = "FAILED"; o.note = "boot receipt reverted"; }
    } catch (error) { halted = true; o.note = `boot reconciliation unavailable: ${String(error).slice(0, 180)}`; }
  }
  for (const o of [...orders]) if (o.status === "CONFIRMED" && o.side === "BUY") await reconcileConfirmedBuy(o, log);
  for (const o of [...orders]) if (o.status === "CONFIRMED" && o.side === "SELL") await reconcileConfirmedSell(o, log);
  for (const lp of livePositions.values()) {
    if (BigInt(lp.remainingQtyRaw) === 0n && lp.strategy.status === "CLOSED") continue;
    try {
      const chainBalance = await tokenBalance(lp.tokenAddress);
      if (chainBalance < BigInt(lp.remainingQtyRaw)) { halted = true; log(`🛑 RH ${lp.tokenSymbol} balance ${chainBalance} < journal ${lp.remainingQtyRaw}`); }
    } catch (error) { halted = true; log(`🛑 RH balance reconciliation failed ${lp.tokenSymbol}: ${String(error).slice(0, 180)}`); }
  }
  if (killSwitchActive()) halted = true;
  initialized = true;
  persist();
  log(`🔐 RH wallet ${traderAddress()} | ETH ${(Number(balance) / 1e18).toFixed(6)} | reserve ${config.live.minEthReserveEth} ETH`);
  log(`🧾 RH live positions ${liveOpenCount()} | entries ${halted ? "HALTED" : "ARMED"}`);
}

export async function liveBuy(candidate: Candidate, pair: DexScreenerPair, sizeUsd: number): Promise<{ position: Position; live: LivePosition; quote: Quote; executionHash: string }> {
  if (!liveEntryAllowed()) throw new Error("RH live entry gate is closed");
  if (!isEthVenueQuote(pair.quoteToken.address)) throw new Error("RH live BUY requires a WETH/native-ETH venue quote");
  const ethUsd = ethUsdFromPair(pair); if (ethUsd === null) throw new Error("cannot derive ETH/USD");
  const sellAmount = usdToEthRaw(sizeUsd, ethUsd);
  const quote = await getBestExecutableQuote(makeQuoteRequest({ sellToken: NATIVE, buyToken: candidate.tokenAddress, sellAmountBaseUnits: sellAmount, slippageBps: config.live.buySlippageBps, pairAddress: pair.pairAddress }), "BUY");
  const decimals = Number(await getEvmPublicClient().readContract({ address: candidate.tokenAddress as `0x${string}`, abi: [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const, functionName: "decimals" }));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("invalid token decimals");
  const tokenQty = Number(BigInt(quote.buyAmount)) / 10 ** decimals;
  const quotedValueUsd = tokenQty * Number(pair.priceUsd);
  const deviation = Math.abs(quotedValueUsd / sizeUsd - 1) * 100;
  if (!Number.isFinite(deviation) || deviation > config.safety.quoteDeviationPct) throw new Error(`RH BUY quote deviates ${deviation.toFixed(2)}% from DexScreener`);
  const order = createOrder({ side: "BUY", kind: "ENTRY", positionId: candidate.key, tokenAddress: candidate.tokenAddress, sellToken: quote.sellToken, buyToken: quote.buyToken, requestedSellRaw: quote.sellAmount, tokenSymbol: candidate.tokenSymbol, tokenName: candidate.tokenName, dexId: pair.dexId, pairAddress: candidate.pairAddress, ...(pair.url ? { pairUrl: pair.url } : {}), quoteSymbol: "ETH", quoteDecimals: 18, tokenDecimals: decimals, exitProfile: robinhoodExitProfile(), entryPriceUsd: Number(pair.priceUsd), entryEthUsd: ethUsd, entryLiquidityUsd: Number(pair.liquidity?.usd ?? 0), entryAgeSec: Math.max(0, (Date.now() - candidate.poolCreatedAt) / 1000) });
  orders.push(order); persist();
  let result: ExecutionResult;
  try {
    result = await executeQuote(quote, "RH BUY", (hash) => { updateOrder(order.id, { status: "SUBMITTED", txHash: hash }); });
  } catch (error) {
    classifySubmitFailure(order.id, error);
    throw error;
  }
  const qty = Number(BigInt(result.buyAmount)) / 10 ** decimals;
  const actualEth = Number(BigInt(result.sellAmount)) / 1e18;
  const costUsd = actualEth * ethUsd;
  if (!(qty > 0) || !(costUsd > 0)) throw new Error("RH BUY fill cannot be valued");
  const gasUsd = gasUsdFromExecution(result, ethUsd);
  const p = openPosition({ id: candidate.key, chain: RH.chain, pairAddress: candidate.pairAddress, tokenAddress: candidate.tokenAddress, symbol: candidate.tokenSymbol, tokenName: candidate.tokenName, quoteSymbol: "ETH", dexId: pair.dexId, ...(pair.url ? { pairUrl: pair.url } : {}), marketPrice: costUsd / qty, usdSize: costUsd, poolAddress: candidate.poolAddress, entryLiquidityUsd: Number(pair.liquidity?.usd ?? 0), entryAgeSec: Math.max(0, (Date.now() - candidate.poolCreatedAt) / 1000), exitProfile: robinhoodExitProfile() });
  p.entryPrice = costUsd / qty; p.currentPrice = p.entryPrice; p.highestPrice = p.entryPrice; p.lowestPrice = p.entryPrice; p.totalEntryFeeUsd = gasUsd; p.totalExitFeeUsd = 0; p.totalSlippageUsd = 0; p.totalGasUsd = gasUsd; p.realizedPnlUsd = -gasUsd;
  const lp: LivePosition = { positionId: p.id, pairAddress: p.pairAddress, tokenAddress: p.tokenAddress, tokenSymbol: p.symbol, tokenName: p.tokenName, dexId: p.dexId, ...(p.pairUrl ? { pairUrl: p.pairUrl } : {}), quoteSymbol: "ETH", tokenDecimals: decimals, quoteToken: NATIVE, quoteDecimals: 18, originalQtyRaw: result.buyAmount, remainingQtyRaw: result.buyAmount, entryCostQuoteRaw: result.sellAmount, entryCostUsd: costUsd, entryPriceUsd: p.entryPrice, entryLiquidityUsd: p.entryLiquidityUsd ?? 0, entryAgeSec: p.entryAgeSec ?? 0, entryGasUsd: gasUsd, realizedPnlUsd: 0, openedAt: p.openedAt, updatedAt: Date.now(), strategy: captureStrategyState(p) };
  livePositions.set(p.id, lp);
  const buyCashBefore = portfolioCashUsd;
  adjustLiveCashUsd(-(costUsd + gasUsd));
  Object.assign(order, { status: "APPLIED", txHash: result.hash, executedSellRaw: result.sellAmount, executedBuyRaw: result.buyAmount, gasUsd });
  persist();
  await telegramSafe(buildLiveSubmittedMessage(p.symbol, "BUY", result.hash, costUsd, buyCashBefore, portfolioCashUsd));
  await telegramSafe(buildLiveFillConfirmedMessage(p.symbol, "BUY", result.hash, result.sellAmount, result.buyAmount, buyCashBefore, portfolioCashUsd));
  return { position: p, live: lp, quote, executionHash: result.hash };
}

export async function liveSell(position: Position, pair: DexScreenerPair, sellRaw: string, kind: "TP" | "EXIT", level?: number, slippageBps = config.live.sellSlippageBps, label = kind === "TP" ? `TP${level}` : "EXIT", reasonOverride?: string): Promise<{ orderId: string; result: { hash: string; sellAmount: string; buyAmount: string; gasUsd: number }; exitPriceUsd: number; realizedPnlUsd: number; gasUsd: number }> {
  const lp = livePositions.get(position.id); if (!lp) throw new Error(`no RH live position ${position.id}`);
  const prior = orderForSell(position.id, label);
  if (prior) { if (prior.status === "CONFIRMED") throw new Error(`confirmed RH SELL ${prior.id} requires reconciliation`); throw new Error(`RH SELL already pending ${prior.id}`); }
  const sold = BigInt(sellRaw), remain = BigInt(lp.remainingQtyRaw);
  if (sold <= 0n || sold > remain) throw new Error("RH sell quantity invalid");
  if (await tokenBalance(lp.tokenAddress) < sold) throw new Error("RH token balance below journaled quantity");
  if (!Number.isInteger(slippageBps) || slippageBps <= 0 || slippageBps > config.live.sellMaxSlippageBps) throw new Error(`sell slippage ${slippageBps} exceeds configured ceiling`);
  const ethUsd = ethUsdFromPair(pair); if (ethUsd === null) throw new Error("cannot value RH sell");
  const quote = await getBestExecutableQuote(makeQuoteRequest({ sellToken: lp.tokenAddress, buyToken: NATIVE, sellAmountBaseUnits: sold.toString(), slippageBps, pairAddress: pair.pairAddress }), "SELL");
  const tokenUnits = Number(BigInt(quote.sellAmount)) / 10 ** lp.tokenDecimals;
  const outEthQuote = Number(BigInt(quote.buyAmount)) / 1e18;
  const expectedUsd = tokenUnits * Number(pair.priceUsd); const quotedUsd = outEthQuote * ethUsd;
  const deviation = Math.abs(quotedUsd / expectedUsd - 1) * 100;
  if (!Number.isFinite(deviation) || deviation > config.safety.quoteDeviationPct) throw new Error(`RH SELL quote deviates ${deviation.toFixed(2)}% from DexScreener`);
  const order = createOrder({ side: "SELL", kind, ...(label ? { label } : {}), ...(level ? { level: level as 1 | 2 | 3 } : {}), positionId: position.id, tokenAddress: lp.tokenAddress, sellToken: quote.sellToken, buyToken: quote.buyToken, requestedSellRaw: quote.sellAmount, tokenSymbol: lp.tokenSymbol, tokenName: lp.tokenName, dexId: lp.dexId, pairAddress: lp.pairAddress, ...(lp.pairUrl ? { pairUrl: lp.pairUrl } : {}), quoteSymbol: "ETH", quoteDecimals: 18, tokenDecimals: lp.tokenDecimals, exitProfile: lp.strategy.exitProfile, exitEthUsd: ethUsd });
  orders.push(order); persist();
  let result: ExecutionResult;
  try {
    result = await executeQuote(quote, `RH SELL${level ? ` TP${level}` : ""}`, (hash) => { updateOrder(order.id, { status: "SUBMITTED", txHash: hash }); });
  } catch (error) {
    classifySubmitFailure(order.id, error);
    throw error;
  }
  const soldUnits = Number(BigInt(result.sellAmount)) / 10 ** lp.tokenDecimals;
  const outEth = Number(BigInt(result.buyAmount)) / 1e18;
  if (!(soldUnits > 0) || !(outEth > 0)) throw new Error("RH SELL receipt fill cannot be valued");
  const exitPriceUsd = outEth * ethUsd / soldUnits;
  const gasUsd = gasUsdFromExecution(result, ethUsd);
  const realizedPnlUsd = soldUnits * (exitPriceUsd - position.entryPrice) - gasUsd;
  Object.assign(order, { status: "CONFIRMED", txHash: result.hash, executedSellRaw: result.sellAmount, executedBuyRaw: result.buyAmount, gasUsd, exitEthUsd: ethUsd, exitPriceUsd, realizedPnlUsd, ...(pair.liquidity?.usd !== undefined ? { exitLiquidityUsd: pair.liquidity.usd } : {}), reason: reasonOverride ?? (kind === "TP" ? `TP${level ?? ""}` : (position.closedReason ?? label)) });
  persist();
  await telegramSafe(buildLiveSubmittedMessage(position.symbol, "SELL", result.hash, undefined, portfolioCashUsd, portfolioCashUsd));
  await telegramSafe(buildLiveFillConfirmedMessage(position.symbol, "SELL", result.hash, result.sellAmount, result.buyAmount, portfolioCashUsd, portfolioCashUsd));
  return { orderId: order.id, result: { hash: result.hash, sellAmount: result.sellAmount, buyAmount: result.buyAmount, gasUsd }, exitPriceUsd, realizedPnlUsd, gasUsd };
}

async function telegramSafe(message: string): Promise<void> { try { await telegram(message); } catch {} }

export interface SellPumpDeps {
  log: (msg: string) => void;
  notify: (msg: string) => Promise<void>;
  getPosition: (id: string) => Position | undefined;
  fetchPair: (pairAddress: string) => Promise<DexScreenerPair | null>;
  applyFill: (p: Position, pair: DexScreenerPair, kind: "TP" | "EXIT", level: number | undefined, reason: string, sell: { orderId: string; result: { hash: string; sellAmount: string; buyAmount: string; gasUsd: number }; exitPriceUsd: number; realizedPnlUsd: number; gasUsd: number }) => Promise<void>;
  onClosed?: (p: Position) => Promise<void>;
  openPaperIds: () => Set<string>;
}

export function nextSellSlippageBps(baseBps: number, attempt: number): number {
  const step = SELL_STEPS[Math.min(Math.max(0, attempt), SELL_STEPS.length - 1)]!;
  return Math.min(config.live.sellMaxSlippageBps, Math.floor(baseBps * step));
}
export function sellRetryDelayMs(attempt: number): number { return 5_000 * (Math.max(0, attempt) + 1); }
export function enqueueLiveSell(queue: PendingLiveSell[], item: Omit<PendingLiveSell, "attempts" | "nextAttemptAt">, now = Date.now()): { queue: PendingLiveSell[]; enqueued: boolean } {
  if (queue.some((q) => q.positionId === item.positionId && q.label === item.label)) return { queue, enqueued: false };
  const rest = item.kind === "EXIT" ? queue.filter((q) => q.positionId !== item.positionId) : queue;
  return { queue: [...rest, { ...item, attempts: 0, nextAttemptAt: now }], enqueued: true };
}
export function queueLiveSell(item: Omit<PendingLiveSell, "attempts" | "nextAttemptAt">): boolean {
  const res = enqueueLiveSell(pendingSells, item); pendingSells = res.queue; if (res.enqueued) persist(); return res.enqueued;
}
export function isLiveSellPending(positionId: string, label: string): boolean {
  return pendingSells.some((q) => q.positionId === positionId && q.label === label) || orders.some((o) => o.positionId === positionId && o.side === "SELL" && (o.label ?? "") === label && LOCKED.has(o.status));
}
function dequeueSell(positionId: string, label: string): void { const next = pendingSells.filter((q) => !(q.positionId === positionId && q.label === label)); if (next.length !== pendingSells.length) { pendingSells = next; persist(); } }
function confirmedSellResult(o: LiveOrder): { orderId: string; result: { hash: string; sellAmount: string; buyAmount: string; gasUsd: number }; exitPriceUsd: number; realizedPnlUsd: number; gasUsd: number } {
  if (o.status !== "CONFIRMED" || !o.txHash || !o.executedSellRaw || !o.executedBuyRaw || !o.exitPriceUsd || o.realizedPnlUsd === undefined) throw new Error(`confirmed SELL ${o.id} incomplete`);
  const gasUsd = o.gasUsd ?? 0;
  return { orderId: o.id, result: { hash: o.txHash, sellAmount: o.executedSellRaw, buyAmount: o.executedBuyRaw, gasUsd }, exitPriceUsd: o.exitPriceUsd, realizedPnlUsd: o.realizedPnlUsd, gasUsd };
}

async function executePendingSell(deps: SellPumpDeps, item: PendingLiveSell): Promise<void> {
  const p = deps.getPosition(item.positionId);
  if (!p || p.status !== "OPEN") { dequeueSell(item.positionId, item.label); return; }
  const pair = await deps.fetchPair(p.pairAddress).catch(() => null);
  if (!pair) { item.nextAttemptAt = Date.now() + 30_000; return; }
  const price = Number(pair.priceUsd); if (!(price > 0)) { item.nextAttemptAt = Date.now() + 30_000; return; }
  const existing = orderForSell(item.positionId, item.label);
  const finish = async (result: ReturnType<typeof confirmedSellResult>, reason: string) => {
    await deps.applyFill(p, pair, item.kind, item.level, reason, result);
    if (p.status === "CLOSED") await deps.onClosed?.(p);
    dequeueSell(item.positionId, item.label);
  };
  try {
    if (existing?.status === "CONFIRMED") { await finish(confirmedSellResult(existing), existing.reason ?? (item.kind === "TP" ? `TP${item.level}` : "EXIT")); return; }
    if (existing?.status === "UNKNOWN") { deps.log(`🛑 RH ${item.label} is UNKNOWN ${existing.id}; refusing resubmit`); halted = true; persist(); return; }
    const candidate = structuredClone(p);
    const liq = pairLiquidityUsd(pair);
    const events = updatePosition(candidate, price, Date.now(), liq === null ? {} : { liquidityUsd: liq });
    const match = item.kind === "TP" ? events.find((e) => e.type === "TP" && e.level === item.level) : events.find((e) => EXIT_REASONS.has(e.type));
    if (!match) { deps.log(`⏭️ RH ${item.label} ${item.positionId}: trigger gone`); dequeueSell(item.positionId, item.label); return; }
    const lp = livePositions.get(item.positionId); if (!lp) { dequeueSell(item.positionId, item.label); return; }
    let sellRaw: string;
    if (match.type === "TP") {
      const pct = BigInt(Math.round(match.sellPct * 100));
      const qty = BigInt(lp.originalQtyRaw) * pct / 10_000n;
      const rem = BigInt(lp.remainingQtyRaw);
      sellRaw = (qty > rem ? rem : qty).toString();
    } else sellRaw = lp.remainingQtyRaw;
    if (BigInt(sellRaw) <= 0n) { dequeueSell(item.positionId, item.label); return; }
    const slippage = nextSellSlippageBps(config.live.sellSlippageBps, item.attempts);
    const reason = match.type === "TP" ? `TP${item.level}` : reasonForEvent(match.type);
    const res = await liveSell(p, pair, sellRaw, item.kind, item.level, slippage, item.label, reason);
    await finish(res, reason);
  } catch (error) {
    if (existing?.status === "CONFIRMED") { return; }
    if (item.attempts < config.live.sellMaxRetries && !halted) {
      item.attempts += 1; item.nextAttemptAt = Date.now() + sellRetryDelayMs(item.attempts);
      deps.log(`⚠️ RH ${item.label} attempt ${item.attempts} failed: ${String(error).slice(0, 160)}; retry @ ${nextSellSlippageBps(config.live.sellSlippageBps, item.attempts)}bps`);
      return;
    }
    dequeueSell(item.positionId, item.label);
    latchHalt(`terminal RH SELL failure ${item.label}: ${String(error).slice(0, 180)}`, deps.log);
    await deps.notify(`🔴 LIVE SELL FAILED — ${p.symbol} ${item.label}: ${String(error).slice(0, 180)}. New entries halted.`);
  }
}

function killEntriesIfBreakerTrip(reason: string): void {
  const now = Date.now();
  liveStopCloses.push(now);
  const cutoff = now - config.risk.breakerWindowMin * 60_000;
  while (liveStopCloses[0] !== undefined && liveStopCloses[0] < cutoff) liveStopCloses.shift();
  if (liveStopCloses.length >= config.risk.breakerStops) { liveStopCloses.length = 0; killEntries(); }
}

export function killLiveEntries(): void { killEntries(); }
export function noteLiveClose(reason: string): boolean {
  if (!["STOP_EXIT", "EARLY_STOP", "DRAIN_EXIT"].includes(reason)) return false;
  const before = readJson<{ killed?: boolean }>(config.liveState.killFile, {}).killed === true;
  killEntriesIfBreakerTrip(reason);
  const after = readJson<{ killed?: boolean }>(config.liveState.killFile, {}).killed === true;
  return !before && after;
}


export async function sweepStuckOrders(log: (msg: string) => void): Promise<void> {
  if (!initialized) return;
  const now = Date.now(), threshold = Math.max(60_000, config.live.orderTimeoutMs);
  for (const o of orders.filter((x) => LOCKED.has(x.status))) {
    if (now - o.updatedAt < threshold && o.status !== "CONFIRMED") continue;
    if (!o.txHash) {
      if (o.status !== "UNKNOWN") { o.status = "UNKNOWN"; o.note = "no tx hash after timeout"; halted = true; persist(); }
      continue;
    }
    try {
      const receipt = await getEvmPublicClient().getTransactionReceipt({ hash: o.txHash as `0x${string}` });
      if (receipt.status !== "success") { updateOrder(o.id, { status: "FAILED", note: "sweeper receipt reverted" }); continue; }
      if (o.status !== "APPLIED") updateOrder(o.id, { status: "CONFIRMED", note: "sweeper confirmed" });
      if (o.side === "BUY") await reconcileConfirmedBuy(o, log);
    } catch (error) { latchHalt(`cannot resolve RH order ${o.id}: ${String(error).slice(0, 160)}`, log); }
  }
}

function sweepOrphans(deps: SellPumpDeps): void {
  const openIds = deps.openPaperIds();
  for (const lp of livePositions.values()) {
    if (BigInt(lp.remainingQtyRaw) <= 0n || lp.strategy.status !== "OPEN") continue;
    if (openIds.has(lp.positionId)) continue;
    if (pendingSells.some((q) => q.positionId === lp.positionId)) continue;
    if (orders.some((o) => o.positionId === lp.positionId && o.side === "SELL" && (o.status === "FAILED" || o.status === "UNKNOWN"))) continue;
    const res = enqueueLiveSell(pendingSells, { positionId: lp.positionId, kind: "EXIT", label: "EXIT" });
    pendingSells = res.queue;
    if (res.enqueued) deps.log(`🧹 RH orphan EXIT queued ${lp.positionId}`);
  }
}

export function catchUpLiveSells(paperIds: Set<string>, log: (msg: string) => void): void {
  for (const o of orders.filter((x) => x.side === "SELL" && (x.status === "SIGNAL" || x.status === "CONFIRMED") && x.positionId && x.label)) {
    if (!paperIds.has(o.positionId!)) continue;
    if (o.status === "CONFIRMED" && !o.executedSellRaw) { void reconcileConfirmedSell(o, log); continue; }
    const kind = o.kind === "TP" ? "TP" as const : "EXIT" as const;
    let level: 1 | 2 | 3 | undefined;
    if (kind === "TP") { const n = Number(o.label!.slice(2)); if (![1, 2, 3].includes(n)) { log(`⚠️ RH invalid TP label ${o.label}`); continue; } level = n as 1 | 2 | 3; }
    const res = enqueueLiveSell(pendingSells, { positionId: o.positionId!, kind, ...(level ? { level } : {}), label: o.label! });
    pendingSells = res.queue;
  }
}

export async function pumpLiveSells(deps: SellPumpDeps): Promise<void> {
  if (!config.live.enabled || !initialized || pumping) return;
  pumping = true;
  try {
    if (Date.now() - lastSweepAt >= SELL_SWEEP_MS) {
      lastSweepAt = Date.now();
      await sweepStuckOrders(deps.log);
      catchUpLiveSells(deps.openPaperIds(), deps.log);
      sweepOrphans(deps);
    }
    for (const item of [...pendingSells].filter((x) => x.nextAttemptAt <= Date.now())) await executePendingSell(deps, item);
  } catch (error) { deps.log(`⚠️ RH sell pump: ${String(error).slice(0, 160)}`); }
  finally { pumping = false; }
}

export function liveStatus(): { initialized: boolean; halted: boolean; openPositions: number; dailyRealizedPnlUsd: number } {
  resetDailyIfNeeded();
  return { initialized, halted, openPositions: liveOpenCount(), dailyRealizedPnlUsd };
}
