import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionResult } from "./types.ts";
import { config, RH } from "./config.ts";
import { quote0x } from "./execution/evm/zeroex.ts";
import { executeQuote, tokenBalance } from "./execution/evm/live.ts";
import { getEvmPublicClient, traderAddress } from "./execution/evm/viem-client.ts";

const EEEE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
function doneToday(path: string): boolean {
  if (!existsSync(path)) return false;
  try { return JSON.parse(readFileSync(path, "utf8")).day === new Date().toISOString().slice(0, 10); } catch { return false; }
}

export async function runLiveSmokeTest(log: (msg: string) => void): Promise<void> {
  if (!config.live.enabled || !config.live.testTrade) return;
  const marker = "data/live-smoke.json";
  if (doneToday(marker)) { log("🧪 RH live smoke test: already completed today"); return; }
  if (!config.live.zeroExKey) throw new Error("LIVE_TEST_TRADE requires ZEROEX_API_KEY");

  const amountWei = BigInt(process.env.LIVE_TEST_AMOUNT_WEI ?? "100000000000000"); // 0.0001 ETH
  if (amountWei <= 0n) throw new Error("LIVE_TEST_AMOUNT_WEI must be positive");
  const nativeBefore = await tokenBalance(EEEE);
  getEvmPublicClient();
  const minGasBuffer = BigInt(Math.floor(config.live.minEthReserveEth * 1e18));
  if (nativeBefore <= amountWei + minGasBuffer) throw new Error("RH live smoke test: insufficient ETH for test + gas buffer");

  log(`🧪 RH smoke: ETH → WETH (${Number(amountWei) / 1e18} ETH)`);
  const wrapQuote = await quote0x({ chain: RH.chain, sellToken: EEEE, buyToken: RH.contracts.weth, sellAmountBaseUnits: amountWei.toString(), taker: traderAddress(), slippageBps: 50 });
  let wrap: ExecutionResult;
  try { wrap = await executeQuote(wrapQuote, "RH SMOKE WRAP"); } catch (error) { throw new Error(`RH smoke wrap failed: ${String(error)}`); }
  if (BigInt(wrap.buyAmount) <= 0n) throw new Error("RH smoke produced zero WETH");

  log(`🧪 RH smoke: WETH → ETH (${wrap.buyAmount} wei)`);
  const unwrapQuote = await quote0x({ chain: RH.chain, sellToken: RH.contracts.weth, buyToken: EEEE, sellAmountBaseUnits: wrap.buyAmount, taker: traderAddress(), slippageBps: 50 });
  try { await executeQuote(unwrapQuote, "RH SMOKE UNWRAP"); } catch (error) { throw new Error(`RH smoke unwrap failed: ${String(error)}`); }
  atomicJson(marker, { day: new Date().toISOString().slice(0, 10), at: Date.now(), wrapTx: wrap.hash, amountWei: amountWei.toString() });
  log(`✅ RH live smoke test complete: ${wrap.hash}`);
}
