import { encodeFunctionData, parseAbi, type Address } from "viem";
import type { Quote, QuoteRequest } from "../../types.ts";
import { RH, NATIVE } from "../../config.ts";
import { getEvmPublicClient, traderAddress } from "./viem-client.ts";

const FACTORY = parseAbi(["function getPair(address,address) view returns (address)"]);
const PAIR = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)"]);
const ROUTER = parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])", "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable", "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)"]);
const MAX = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const zero = /^0x0{40}$/i;
const native = (x: string) => zero.test(x) || x.toLowerCase() === MAX.toLowerCase();
const addr = (x: string) => x.toLowerCase() as Address;

export async function quoteUniswapV2(request: QuoteRequest): Promise<Quote> {
  if (!request.pairAddress || !/^0x[0-9a-fA-F]{40}$/.test(request.pairAddress)) throw new Error("uniswap-v2: missing pair address");
  const sellNative = native(request.sellToken);
  const buyNative = native(request.buyToken);
  if (sellNative === buyNative) throw new Error("uniswap-v2: one leg must be ERC20 and the other native ETH");
  const token = sellNative ? request.buyToken : request.sellToken;
  if (token.toLowerCase() === RH.contracts.weth.toLowerCase()) throw new Error("uniswap-v2: WETH cannot be the traded token");
  const client = getEvmPublicClient();
  const canonical = await client.readContract({ address: RH.contracts.v2Factory, abi: FACTORY, functionName: "getPair", args: [addr(sellNative ? RH.contracts.weth : token), addr(buyNative ? RH.contracts.weth : token)] });
  if (canonical.toLowerCase() !== request.pairAddress.toLowerCase()) throw new Error(`uniswap-v2: pair mismatch factory=${canonical} requested=${request.pairAddress}`);
  const [token0, token1, reserves] = await Promise.all([
    client.readContract({ address: request.pairAddress as Address, abi: PAIR, functionName: "token0" }),
    client.readContract({ address: request.pairAddress as Address, abi: PAIR, functionName: "token1" }),
    client.readContract({ address: request.pairAddress as Address, abi: PAIR, functionName: "getReserves" }),
  ]);
  const t0 = String(token0).toLowerCase();
  const amountIn = BigInt(request.sellAmountBaseUnits);
  const weth = RH.contracts.weth.toLowerCase();
  const outToken = buyNative ? weth : request.buyToken.toLowerCase();
  const inToken = sellNative ? weth : request.sellToken.toLowerCase();
  let reserveIn: bigint;
  let reserveOut: bigint;
  if (t0 === inToken) { reserveIn = BigInt(reserves[0]); reserveOut = BigInt(reserves[1]); }
  else if (t0 === outToken) { reserveIn = BigInt(reserves[1]); reserveOut = BigInt(reserves[0]); }
  else throw new Error("uniswap-v2: pair tokens do not match request");
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("uniswap-v2: empty reserves");
  const amounts = await client.readContract({ address: RH.contracts.v2Router, abi: ROUTER, functionName: "getAmountsOut", args: [amountIn, [inToken as Address, outToken as Address]] });
  const buyAmount = BigInt(amounts[amounts.length - 1]!);
  if (buyAmount <= 0n) throw new Error("uniswap-v2: zero output");
  const spot = amountIn * reserveOut / reserveIn;
  const impact = spot > 0n && spot >= buyAmount ? Number((spot - buyAmount) * 10_000n / spot) / 100 : 0;
  const minBuy = buyAmount * BigInt(10_000 - request.slippageBps) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 90);
  const path = [inToken as Address, outToken as Address];
  const calldata = buyNative
    ? encodeFunctionData({ abi: ROUTER, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [amountIn, minBuy, path, traderAddress(), deadline] })
    : encodeFunctionData({ abi: ROUTER, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [minBuy, path, traderAddress(), deadline] });
  return {
    source: "uniswap-v2",
    chain: RH.chain,
    sellToken: sellNative ? NATIVE : token,
    buyToken: buyNative ? NATIVE : token,
    sellAmount: amountIn.toString(),
    buyAmount: buyAmount.toString(),
    minBuyAmount: minBuy.toString(),
    priceImpactPct: impact,
    priceImpactSource: "approx",
    estimatedGasUnits: buyNative ? 220_000 : 250_000,
    to: RH.contracts.v2Router,
    calldata,
    value: sellNative ? amountIn.toString() : "0",
    raw: { allowanceTarget: RH.contracts.v2Router, factory: RH.contracts.v2Factory, router: RH.contracts.v2Router, pair: request.pairAddress },
  };
}
