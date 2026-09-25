import { totalPnlUsd } from "./position.ts";
import type { Position } from "./types.ts";

export interface ClosedTrade {
  id: string;
  chain: string;
  symbol: string;
  dexId: string;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
  durationMs: number;
  openedAt: number;
  closedAt: number;
}

export interface ChainStat { chain: string; trades: number; wins: number; pnlUsd: number; }
export interface PortfolioSnapshot {
  equityUsd: number;
  cashUsd: number;
  openValueUsd: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnlUsd: number;
}

export class Portfolio {
  readonly initialBalanceUsd: number;
  private cash: number;
  private readonly closed: ClosedTrade[] = [];

  constructor(initialBalanceUsd: number) {
    if (!Number.isFinite(initialBalanceUsd) || initialBalanceUsd <= 0) throw new Error("Portfolio initial balance must be positive");
    this.initialBalanceUsd = initialBalanceUsd;
    this.cash = initialBalanceUsd;
  }

  get cashUsd(): number { return this.cash; }
  get closedTrades(): readonly ClosedTrade[] { return this.closed; }

  restore(cashUsd: number, closedTrades: ClosedTrade[]): void {
    if (Number.isFinite(cashUsd) && cashUsd >= 0) this.cash = cashUsd;
    const seen = new Set(this.closed.map((t) => t.id));
    if (!Array.isArray(closedTrades)) return;
    for (const t of closedTrades) {
      if (seen.has(t.id)) continue;
      if (typeof t.id === "string" && typeof t.chain === "string" && typeof t.symbol === "string" && typeof t.dexId === "string" && Number.isFinite(t.pnlUsd) && Number.isFinite(t.pnlPct) && typeof t.reason === "string" && Number.isFinite(t.durationMs) && Number.isFinite(t.openedAt) && Number.isFinite(t.closedAt)) {
        this.closed.push(t);
        seen.add(t.id);
      }
    }
  }

  hasClosed(id: string): boolean { return this.closed.some((t) => t.id === id); }

  openValueUsd(openPositions: Iterable<Position>): number {
    let value = 0;
    for (const p of openPositions) if (p.status === "OPEN") value += Math.max(0, p.quantity) * Math.max(0, p.currentPrice);
    return value;
  }
  equityUsd(openPositions: Iterable<Position>): number { return this.cash + this.openValueUsd(openPositions); }
  canOpen(costUsd: number): boolean { return Number.isFinite(costUsd) && costUsd > 0 && this.cash >= costUsd; }
  onOpen(costUsd: number): boolean { if (!this.canOpen(costUsd)) return false; this.cash -= costUsd; return true; }
  onProceeds(amountUsd: number): void { if (Number.isFinite(amountUsd) && amountUsd > 0) this.cash += amountUsd; }

  onClose(position: Position): ClosedTrade {
    const existing = this.closed.find((t) => t.id === position.id);
    if (existing) return existing;
    const pnlUsd = totalPnlUsd(position);
    const record: ClosedTrade = {
      id: position.id,
      chain: position.chain,
      symbol: position.symbol,
      dexId: position.dexId,
      pnlUsd,
      pnlPct: position.initialUsdSize > 0 ? (pnlUsd / position.initialUsdSize) * 100 : 0,
      reason: position.closedReason ?? "unknown",
      durationMs: Math.max(0, (position.closedAt ?? Date.now()) - position.openedAt),
      openedAt: position.openedAt,
      closedAt: position.closedAt ?? Date.now(),
    };
    this.closed.push(record);
    return record;
  }

  snapshot(openPositions: Iterable<Position>): PortfolioSnapshot {
    const openValue = this.openValueUsd(openPositions);
    const totalTrades = this.closed.length;
    const wins = this.closed.filter((t) => t.pnlUsd > 0).length;
    return {
      equityUsd: this.cash + openValue,
      cashUsd: this.cash,
      openValueUsd: openValue,
      totalTrades,
      wins,
      losses: totalTrades - wins,
      winRatePct: totalTrades ? (wins / totalTrades) * 100 : 0,
      totalPnlUsd: this.closed.reduce((sum, t) => sum + t.pnlUsd, 0),
    };
  }

  chainStats(): ChainStat[] {
    const map = new Map<string, ChainStat>();
    for (const t of this.closed) {
      const stat = map.get(t.chain) ?? { chain: t.chain, trades: 0, wins: 0, pnlUsd: 0 };
      stat.trades += 1;
      if (t.pnlUsd > 0) stat.wins += 1;
      stat.pnlUsd += t.pnlUsd;
      map.set(t.chain, stat);
    }
    return [...map.values()].sort((a, b) => b.pnlUsd - a.pnlUsd);
  }
  chainStat(chain: string): ChainStat { return this.chainStats().find((s) => s.chain === chain) ?? { chain, trades: 0, wins: 0, pnlUsd: 0 }; }
  tokenPnlUsd(chain: string, symbol: string): { trades: number; pnlUsd: number } {
    const rows = this.closed.filter((t) => t.chain === chain && t.symbol === symbol);
    return { trades: rows.length, pnlUsd: rows.reduce((sum, t) => sum + t.pnlUsd, 0) };
  }
}
