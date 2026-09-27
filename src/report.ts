import { totalPnlPct, totalPnlUsd, remainingPct } from "./position.ts";
import { config } from "./config.ts";
import { RH } from "./config.ts";
import type { Position } from "./types.ts";
import type { Portfolio, PortfolioSnapshot, ChainStat } from "./portfolio.ts";
import { SHADOW_COST_MODEL } from "./position.ts";

export const chainIcon = (_chain: string) => "🏹";
const usd = (v: number) => Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
const signedUsd = (v: number) => !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${Number.isFinite(v) ? v.toFixed(2) : "0.00"}%`;
const price = (v: number) => Number.isFinite(v) && v > 0 ? `$${v.toPrecision(8)}` : "—";
const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2,"0")}m` : m ? `${m}m ${String(sec).padStart(2,"0")}s` : `${sec}s`;
};

function badge(reason?: string): string {
  switch (reason) {
    case "TP_EXIT": return "💰 EXIT";
    case "TRAIL_EXIT": return "📉 TRAILING EXIT";
    case "EARLY_STOP": return "🛑 EARLY STOP";
    case "STOP_EXIT": return "🔴 STOP EXIT";
    case "BREAKEVEN_STOP": return "🛟 BREAKEVEN EXIT";
    case "DRAIN_EXIT": return "🌊 DRAIN EXIT";
    case "TIME_EXIT": return "⏱ TIME EXIT";
    default: return "🔴 EXIT";
  }
}

/** Cash leg for every message: before → after around the event. */
function balanceLine(beforeUsd: number | undefined, afterUsd: number | undefined): string {
  if (beforeUsd === undefined || afterUsd === undefined) return "";
  if (Number.isFinite(beforeUsd) && Number.isFinite(afterUsd)) return `💰 Balance: ${usd(beforeUsd)} → ${usd(afterUsd)}`;
  if (Number.isFinite(afterUsd)) return `💰 Balance: ${usd(afterUsd)}`;
  return "";
}

export function buildBuyMessage(p: Position, maxOpen: number, openCount: number, balanceBeforeUsd?: number, balanceAfterUsd?: number): string {
  const ex = p.exitProfile;
  return [
    `### 🟢 ${p.chain.toUpperCase()} BUY — ${p.symbol || "UNKNOWN"}`,
    `🪙 ${p.tokenName || p.symbol} (${p.symbol}/${p.quoteSymbol})`,
    `🏹 Chain: robinhood  |  🏷️ DEX: ${p.dexId}`,
    `🔗 Pair: \`${p.pairAddress}\``,
    `🆔 CA: \`${p.tokenAddress}\``,
    ...(p.poolAddress ? [`🏊 Pool: \`${p.poolAddress}\``] : []),
    `💲 Entry: ${price(p.entryPrice)}  |  📦 Size: ${usd(p.initialUsdSize)}`,
    `💧 Liquidity: ${Number.isFinite(p.entryLiquidityUsd ?? NaN) ? usd(p.entryLiquidityUsd!) : "—"}  |  ⏱️ Age: ${p.entryAgeSec !== undefined ? `${Math.round(p.entryAgeSec)}s` : "—"}`,
    `🛡️ SL: ${price(p.entryPrice * (1 - (ex?.initialStopPct ?? 15) / 100))}`,
    `🎯 TP: ${(ex?.tp ?? []).map((t) => `+${t.gainPct}%`).join(" / ")}  |  🌀 Trail: +${ex?.trailActivationPct ?? 30}% / ${ex?.trailDistancePct ?? 15}%`,
    `⏳ Max hold: ${ex?.maxPositionAgeMin ?? 60}m  |  📂 Open: ${openCount}/${maxOpen}`,
    balanceLine(balanceBeforeUsd ?? p.balanceBeforeUsd, balanceAfterUsd),
    p.pairUrl ? `[DexScreener](${p.pairUrl})` : "",
  ].filter(Boolean).join("\n");
}

export function buildTpMessage(p: Position, level: number, gainPct: number, soldQty: number, proceedsUsd: number, realizedPnlUsd: number, remainingPctAfter: number, balanceBeforeUsd?: number, balanceAfterUsd?: number): string {
  return [
    `### 💰 TP${level} — ${p.symbol} (${pct(gainPct)})`,
    `🏹 robinhood | ${p.dexId} | \`${p.pairAddress}\``,
    `💲 Price: ${price(p.currentPrice)}  |  Sold: ${soldQty.toPrecision(8)} units`,
    `💵 Proceeds: ${usd(proceedsUsd)}`,
    `📈 Realized: ${signedUsd(realizedPnlUsd)}  |  Remaining: ${remainingPctAfter.toFixed(1)}%`,
    balanceLine(balanceBeforeUsd, balanceAfterUsd),
  ].filter(Boolean).join("\n");
}

export function buildUpdateMessage(kind: "TRAIL" | "BREAKEVEN", p: Position, stop: number, balanceUsd?: number): string {
  return [
    `### ${kind === "TRAIL" ? "📈 TRAILING ACTIVATED" : "🛟 STOP → BREAKEVEN"} — ${p.symbol}`,
    `🏹 robinhood | Price: ${price(p.currentPrice)} | Stop: ${price(stop)}`,
    `📦 Remaining: ${remainingPct(p).toFixed(1)}%`,
    balanceUsd !== undefined ? `💰 Balance: ${usd(balanceUsd)} (no change)` : "",
  ].filter(Boolean).join("\n");
}

export function buildCloseMessage(p: Position, snap: PortfolioSnapshot, chainStat: ChainStat, tokenStat: { trades: number; pnlUsd: number }): string {
  const pnl = totalPnlUsd(p);
  return [
    `### ${badge(p.closedReason)} — ${p.symbol} ${pnl > 0 ? "✅ WIN" : pnl < 0 ? "❌ LOSS" : "➖ FLAT"}`,
    `🪙 ${p.tokenName || p.symbol} (${p.symbol}/${p.quoteSymbol})`,
    `🏹 robinhood | ${p.dexId}`,
    `🔗 Pair: \`${p.pairAddress}\`  |  CA: \`${p.tokenAddress}\``,
    `💲 Entry: ${price(p.entryPrice)} → Exit: ${price(p.currentPrice)}`,
    `💧 Liquidity: ${usd(p.entryLiquidityUsd ?? NaN)} → ${usd(p.exitLiquidityUsd ?? NaN)}`,
    `🔝 High: ${price(p.highestPrice)}  |  🎯 ${p.tpHit.map((h,i)=>h?`TP${i+1}✅`:`TP${i+1}❌`).join(" ")}`,
    `📈 PnL: ${signedUsd(pnl)} (${pct(totalPnlPct(p))})`,
    `🧾 ${SHADOW_COST_MODEL}: ${signedUsd(pnl - p.shadowFeeUsd - p.shadowSlipUsd)}`,
    `📦 Size: ${usd(p.initialUsdSize)} | ⏳ ${duration((p.closedAt ?? Date.now()) - p.openedAt)}`,
    balanceLine(p.balanceBeforeUsd, snap.cashUsd),
    `📊 Portfolio: #${snap.totalTrades} | ${snap.winRatePct.toFixed(1)}% WR | Total ${signedUsd(snap.totalPnlUsd)} | Equity ${usd(snap.equityUsd)}`,
    `🏹 robinhood: ${chainStat.trades} trades | ${chainStat.trades ? ((chainStat.wins / chainStat.trades) * 100).toFixed(1) : "0.0"}% WR | ${signedUsd(chainStat.pnlUsd)}`,
    `🪙 ${p.symbol}: ${tokenStat.trades} trades | ${signedUsd(tokenStat.pnlUsd)}`,
    p.pairUrl ? `[DexScreener](${p.pairUrl})` : "",
  ].filter(Boolean).join("\n");
}

export function buildStartupMessage(args: {
  mode: string; autoEntry: boolean; size: number; maxOpen: number; analytics: string; live: boolean; wallet?: string; cashUsd?: number;
}): string {
  return [
    "### 🤖 ROBINHOOD BOT STARTED",
    `📝 Mode: ${args.mode} | Auto entry: ${args.autoEntry}`,
    `🏹 Chain: Robinhood (4663) | DEX: Uniswap-focused discovery`,
    `📦 Size: ${usd(args.size)} | Max open: ${args.maxOpen}`,
    args.cashUsd !== undefined ? `💰 Balance: ${usd(args.cashUsd)}` : "",
    `🔎 Discovery: DexPaprika | 💲 Price: DexScreener @ 1s`,
    `📈 Strategy: 60–120s pools | $15k–$100k liquidity | confirm 3s`,
    `🎯 TP: +30/+60/+100 | Trail: +30 / 15% | Max hold: 60m`,
    `🛡️ Safety: strict | Repeat symbol: blocked | Daily live loss: -$${Math.abs(configuredDailyLoss())}`,
    `🔐 Live trading: ${args.live ? "ENABLED" : "off"}${args.wallet ? ` | Wallet: \`${args.wallet}\`` : ""}`,
    `📊 Analytics: ${args.analytics}`,
  ].join("\n");
}

function configuredDailyLoss(): number {
  const v = Number(process.env.MAX_DAILY_LIVE_LOSS_USD ?? 25);
  return Number.isFinite(v) ? v : 25;
}

export function buildLiveSubmittedMessage(symbol: string, side: "BUY" | "SELL", hash: string, sizeUsd?: number, balanceBeforeUsd?: number, balanceAfterUsd?: number): string {
  return [
    `### ${side === "BUY" ? "🟢 LIVE BUY" : "🔴 LIVE SELL"} SUBMITTED — ${symbol}`,
    `🏹 robinhood${sizeUsd !== undefined ? ` | ${usd(sizeUsd)}` : ""}`,
    `🔗 \`${hash}\``,
    `[Blockscout](${RH_TX(hash)})`,
    balanceLine(balanceBeforeUsd, balanceAfterUsd),
  ].filter(Boolean).join("\n");
}

export function buildLiveFillConfirmedMessage(symbol: string, side: "BUY" | "SELL", hash: string, sellRaw: string, buyRaw: string, balanceBeforeUsd?: number, balanceAfterUsd?: number): string {
  return [
    `### ${side === "BUY" ? "✅ LIVE BUY FILLED" : "✅ LIVE SELL FILLED"} — ${symbol}`,
    `📦 In: \`${sellRaw}\` → Out: \`${buyRaw}\``,
    `🔗 \`${hash}\``,
    `[Blockscout](${RH_TX(hash)})`,
    balanceLine(balanceBeforeUsd, balanceAfterUsd),
  ].filter(Boolean).join("\n");
}
function RH_TX(hash: string): string { return `https://robinhoodchain.blockscout.com/tx/${hash}`; }

export function buildLiveClosedMessage(symbol: string, reason: string, realizedPnlUsd: number, dailyPnlUsd: number, balanceBeforeUsd?: number, balanceAfterUsd?: number): string {
  const signed = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  return [
    `### ${realizedPnlUsd > 0 ? "✅" : realizedPnlUsd < 0 ? "❌" : "➖"} LIVE CLOSED — ${symbol}`,
    `🏹 robinhood | Reason: ${reason}`,
    `📈 Realized PnL: ${signed(realizedPnlUsd)}`,
    `📅 Daily live PnL: ${signed(dailyPnlUsd)}`,
    balanceLine(balanceBeforeUsd, balanceAfterUsd),
  ].filter(Boolean).join("\n");
}
