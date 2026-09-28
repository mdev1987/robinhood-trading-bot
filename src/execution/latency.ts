import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";

export type LatencyKind = "submit" | "confirm";
type LatencyHistory = Record<LatencyKind, number[]>;
const MAX_SAMPLES = 500;

function empty(): LatencyHistory { return { submit: [], confirm: [] }; }

function load(): LatencyHistory {
  try {
    if (!existsSync(config.live.latencyFile)) return empty();
    const raw = JSON.parse(readFileSync(config.live.latencyFile, "utf8")) as Partial<LatencyHistory>;
    const clean = empty();
    for (const kind of ["submit", "confirm"] as const) {
      const values = Array.isArray(raw[kind]) ? raw[kind] : [];
      clean[kind] = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0).slice(-MAX_SAMPLES);
    }
    return clean;
  } catch { return empty(); }
}

function save(history: LatencyHistory): void {
  try {
    mkdirSync(dirname(config.live.latencyFile), { recursive: true });
    const tmp = `${config.live.latencyFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(history));
    renameSync(tmp, config.live.latencyFile);
  } catch {
    // Latency learning is best effort; it must never affect execution.
  }
}

export function recordLiveLatency(kind: LatencyKind, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const history = load();
  history[kind].push(ms);
  if (history[kind].length > MAX_SAMPLES) history[kind] = history[kind].slice(-MAX_SAMPLES);
  save(history);
}

function percentile(values: number[], pct: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * Math.min(100, Math.max(0, pct)) / 100;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const weight = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * weight;
}

/** Learned submit/confirm latency, falling back to configured paper delays. */
export function paperLatency(kind: LatencyKind, fallbackMs: number): number {
  const history = load();
  return percentile(history[kind], config.paperExecution.latencyPercentile) ?? fallbackMs;
}
