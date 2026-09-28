import { encodeFunctionData, keccak256, parseAbi, toBytes, type Address } from "viem";
import type { ExecutionResult, LiveOrder, Quote } from "../../types.ts";
import { RH, config } from "../../config.ts";
import { getEvmPublicClient, getEvmWalletClient, traderAddress, withTxLock, waitReceipt } from "./viem-client.ts";
import { simulateEvmCall } from "./simulator.ts";
import { assessQuoteRisk, LIVE_BUY_POLICY, LIVE_SELL_POLICY } from "../risk.ts";
import { recordLiveLatency } from "../latency.ts";

const ERC20 = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WITHDRAWAL_TOPIC = keccak256(toBytes("Withdrawal(address,uint256)"));
const EEEE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = /^0x0{40}$/i;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isNative(token: string): boolean {
  return ZERO.test(token) || token.toLowerCase() === EEEE.toLowerCase();
}

function spenderOf(quote: Quote): Address {
  const raw = quote.raw as Record<string, unknown> | undefined;
  const issues = raw?.issues as Record<string, unknown> | undefined;
  const allowance = issues?.allowance as Record<string, unknown> | undefined;
  const spender = allowance?.spender ?? raw?.allowanceTarget;
  const value = typeof spender === "string" ? spender : "";
  if (!ADDR_RE.test(value)) throw new Error("quote has no valid allowance spender");
  return value as Address;
}

async function ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<`0x${string}` | null> {
  const client = getEvmPublicClient();
  const owner = traderAddress();
  const current = await client.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [owner, spender] });
  if (current >= amount) return null;
  const wallet = getEvmWalletClient();
  if (current > 0n) {
    const zeroHash = await wallet.writeContract({ address: token, abi: ERC20, functionName: "approve", args: [spender, 0n], account: owner, chain: wallet.chain });
    const zeroReceipt = await waitReceipt(zeroHash);
    if (zeroReceipt.status !== "success") throw new Error(`allowance reset reverted ${zeroHash}`);
  }
  const hash = await wallet.writeContract({ address: token, abi: ERC20, functionName: "approve", args: [spender, amount], account: owner, chain: wallet.chain });
  const receipt = await waitReceipt(hash);
  if (receipt.status !== "success") throw new Error(`approval reverted ${hash}`);
  return hash;
}

function topicAddress(topic: string | undefined): string { return `0x${(topic ?? "").slice(-40)}`.toLowerCase(); }

export function extractExecutionAmounts(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  trader: string,
  sellToken: string,
  buyToken: string,
  fallbackSellRaw: string,
): { sellAmount: string; buyAmount: string } {
  let sold = 0n;
  let bought = 0n;
  const traderLower = trader.toLowerCase();
  for (const log of logs) {
    if ((log.topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    let amount: bigint;
    try { amount = BigInt(log.data); } catch { continue; }
    const token = log.address.toLowerCase();
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    if (!isNative(sellToken) && token === sellToken.toLowerCase() && from === traderLower) sold += amount;
    if (!isNative(buyToken) && token === buyToken.toLowerCase() && to === traderLower) bought += amount;
  }
  if (isNative(sellToken)) sold = BigInt(fallbackSellRaw);
  if (!isNative(sellToken) && sold <= 0n) throw new Error("receipt has no provable ERC20 sell transfer");
  if (!isNative(buyToken) && bought <= 0n) throw new Error("receipt has no provable ERC20 buy transfer");

  if (isNative(buyToken)) {
    let nativeOut = 0n;
    for (const log of logs) {
      if (log.address.toLowerCase() !== RH.contracts.weth.toLowerCase()) continue;
      if ((log.topics[0] ?? "").toLowerCase() !== WITHDRAWAL_TOPIC.toLowerCase()) continue;
      if (topicAddress(log.topics[1]) !== traderLower) continue;
      try { nativeOut += BigInt(log.data); } catch {}
    }
    if (nativeOut <= 0n) throw new Error("receipt has no provable native ETH output");
    bought = nativeOut;
  }
  return { sellAmount: sold.toString(), buyAmount: bought.toString() };
}

function receiptGasUsd(gasUsed: bigint, gasPrice: bigint, ethUsd: number): number {
  const usd = Number(gasUsed * gasPrice) / 1e18 * ethUsd;
  if (!Number.isFinite(usd) || usd < 0) throw new Error("invalid receipt gas valuation");
  return usd;
}

async function reserveCheck(quote: Quote): Promise<void> {
  if (!isNative(quote.sellToken)) return;
  const value = BigInt(quote.value || quote.sellAmount);
  const client = getEvmPublicClient();
  const estimatedRaw = quote.estimatedGasUnits && quote.estimatedGasUnits > 0
    ? BigInt(Math.ceil(quote.estimatedGasUnits))
    : await client.estimateGas({ account: traderAddress(), to: quote.to as Address, data: quote.calldata as `0x${string}`, value });
  const estimated = BigInt(estimatedRaw);
  const gasPrice = BigInt(await client.getGasPrice());
  const reserve = BigInt(Math.floor(config.live.minEthReserveEth * 1e18));
  const balance = BigInt(await client.getBalance({ address: traderAddress() }));
  const needed = value + estimated * gasPrice + reserve;
  if (balance < needed) throw new Error(`insufficient ETH reserve: balance=${balance} required>=${needed}`);
}

export async function executeQuote(quote: Quote, label: string, onSubmitted?: (hash: `0x${string}`) => Promise<void> | void): Promise<ExecutionResult> {
  const trader = traderAddress();
  if (!ADDR_RE.test(quote.to) || !/^0x[0-9a-fA-F]*$/.test(quote.calldata)) throw new Error(`${label}: quote has no executable calldata`);
  const risk = assessQuoteRisk(quote, /sell/i.test(label) ? LIVE_SELL_POLICY : LIVE_BUY_POLICY);
  if (!risk.pass) throw new Error(`${label}: risk rejected: ${risk.reasons.join(", ")}`);

  return withTxLock(async () => {
    const client = getEvmPublicClient();
    if (isNative(quote.sellToken)) {
      if (BigInt(quote.value || "0") !== BigInt(quote.sellAmount)) throw new Error(`${label}: native input value does not match requested sell amount`);
      await reserveCheck(quote);
    } else await ensureAllowance(quote.sellToken as Address, spenderOf(quote), BigInt(quote.sellAmount));

    const value = BigInt(quote.value || "0");
    const sim = await simulateEvmCall({ from: trader, to: quote.to as Address, data: quote.calldata as `0x${string}`, value });
    if (!sim.ok) throw new Error(`${label}: eth_call simulation failed: ${sim.reason}`);

    const wallet = getEvmWalletClient();
    const submitStarted = Date.now();
    const hash = await wallet.sendTransaction({ to: quote.to as Address, data: quote.calldata as `0x${string}`, value, account: trader, chain: wallet.chain });
    const submitMs = Date.now() - submitStarted;
    recordLiveLatency("submit", submitMs);
    try {
      await onSubmitted?.(hash);
    } catch (error) {
      throw new Error(`broadcast ${hash} but submission journal failed: ${String(error).slice(0, 200)}`);
    }
    const confirmStarted = Date.now();
    const receipt = await waitReceipt(hash);
    const confirmMs = Date.now() - confirmStarted;
    recordLiveLatency("confirm", confirmMs);
    if (receipt.status !== "success") throw new Error(`${label}: transaction reverted ${hash}`);

    const amounts = extractExecutionAmounts(receipt.logs as never, trader, quote.sellToken, quote.buyToken, quote.sellAmount);
    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.effectiveGasPrice;
    return {
      ok: true,
      hash,
      sellAmount: amounts.sellAmount,
      buyAmount: amounts.buyAmount,
      gasUsed: gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      executionLatencyMs: submitMs + confirmMs,
    };
  });
}

export async function tokenBalance(token: string): Promise<bigint> {
  if (isNative(token)) return getEvmPublicClient().getBalance({ address: traderAddress() });
  return getEvmPublicClient().readContract({ address: token as Address, abi: ERC20, functionName: "balanceOf", args: [traderAddress()] });
}

export function gasUsdFromExecution(result: ExecutionResult, ethUsd: number): number {
  if (!result.gasUsed || !result.effectiveGasPrice) return 0;
  return receiptGasUsd(BigInt(result.gasUsed), BigInt(result.effectiveGasPrice), ethUsd);
}

export function liveOrderGasUsd(order: LiveOrder): number { return Number.isFinite(order.gasUsd) && (order.gasUsd ?? 0) >= 0 ? order.gasUsd ?? 0 : 0; }
