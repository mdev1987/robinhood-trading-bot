import { createPublicClient, createWalletClient, fallback, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { defineChain } from "viem";
import { RH, config } from "../../config.ts";

export const robinhoodChain = defineChain({
  id: RH.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.live.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: RH.explorer } },
});

let publicClient: PublicClient | null = null;
let walletClient: WalletClient | null = null;
let account: PrivateKeyAccount | null = null;
let txQueue: Promise<void> = Promise.resolve();

function publicTransport() {
  const primary = http(config.live.rpcUrl, { timeout: 15_000, retryCount: 2, retryDelay: 150 });
  if (!config.live.rpcFallbackUrl) return primary;
  return fallback([
    primary,
    http(config.live.rpcFallbackUrl, { timeout: 15_000, retryCount: 2, retryDelay: 150 }),
  ]);
}

export function getEvmPublicClient(): PublicClient {
  if (!publicClient) publicClient = createPublicClient({ chain: robinhoodChain, transport: publicTransport() });
  return publicClient;
}

export function traderAccount(): PrivateKeyAccount {
  if (account) return account;
  const raw = process.env.TRADER_PRIVATE_KEY ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error("TRADER_PRIVATE_KEY must be a 32-byte 0x-prefixed private key");
  account = privateKeyToAccount(raw as `0x${string}`);
  return account;
}

export function traderAddress(): `0x${string}` { return traderAccount().address; }

export function getEvmWalletClient(): WalletClient {
  if (!config.live.enabled) throw new Error("Live wallet requested while LIVE_TRADING_ENABLED=false");
  if (!walletClient) walletClient = createWalletClient({ account: traderAccount(), chain: robinhoodChain, transport: publicTransport() });
  return walletClient;
}

export async function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const previous = txQueue;
  txQueue = next;
  await previous;
  try { return await fn(); } finally { release(); }
}

export async function assertRobinhoodInfrastructure(): Promise<void> {
  const client = getEvmPublicClient();
  const chainId = await client.getChainId();
  if (chainId !== RH.chainId) throw new Error(`Wrong RPC chainId ${chainId}; expected ${RH.chainId}`);
  const checks = [
    ["WETH", RH.contracts.weth], ["V2Factory", RH.contracts.v2Factory], ["V2Router02", RH.contracts.v2Router],
    ["V3Factory", RH.contracts.v3Factory], ["V3SwapRouter02", RH.contracts.v3Router],
    ["V4PoolManager", RH.contracts.v4PoolManager], ["V4StateView", RH.contracts.v4StateView],
    ["V4UniversalRouter", RH.contracts.v4UniversalRouter], ["V4Quoter", RH.contracts.v4Quoter], ["Permit2", RH.contracts.permit2],
  ] as const;
  for (const [name, address] of checks) {
    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new Error(`${name} has no bytecode at ${address}`);
  }
}

export async function waitReceipt(hash: `0x${string}`) {
  return getEvmPublicClient().waitForTransactionReceipt({ hash, confirmations: 1, timeout: config.live.orderTimeoutMs });
}
