import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

interface LockRecord { pid: number; hostname: string; startedAt: number; instanceId: string; }
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const INSTANCE_ID = crypto.randomUUID();

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockPathFor(stateFile: string): string { return join(dirname(stateFile), "bot.lock"); }

function readLock(path: string): Partial<LockRecord> {
  try { return JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>; } catch { return {}; }
}

export function claimInstanceLockForStateFile(stateFile: string): void {
  const lockPath = lockPathFor(stateFile);
  mkdirSync(dirname(lockPath), { recursive: true });
  const record: LockRecord = { pid: process.pid, hostname: hostname(), startedAt: Date.now(), instanceId: INSTANCE_ID };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      process.once("exit", () => {
        try {
          const current = readLock(lockPath);
          if (current.instanceId === record.instanceId) rmSync(lockPath, { force: true });
        } catch {}
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      const sameProcess = existing.instanceId === INSTANCE_ID
        || (existing.pid === process.pid && existing.hostname === hostname()
          && typeof existing.startedAt === "number" && Math.abs(existing.startedAt - PROCESS_STARTED_AT) < 10_000);
      if (sameProcess) return;
      const alive = typeof existing.pid === "number" && pidAlive(existing.pid);
      const sameHost = existing.hostname === hostname();
      if (alive && sameHost) {
        throw new Error(`Another bot instance is running (pid ${existing.pid}, lock ${lockPath}) — refusing to start`);
      }
      // Dead PID, different container/host, or a reused PID with a different
      // process start time: stale lock. Remove it and retry atomically.
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Unable to claim instance lock ${lockPath}`);
}
