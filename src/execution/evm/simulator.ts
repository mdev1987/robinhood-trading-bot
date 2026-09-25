import type { Address, Hex } from "viem";
import type { SimulationResult } from "../../types.ts";
import { getEvmPublicClient } from "./viem-client.ts";

export async function simulateEvmCall(args: {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}): Promise<SimulationResult> {
  try {
    await getEvmPublicClient().call({
      account: args.from,
      to: args.to,
      data: args.data,
      ...(args.value !== undefined ? { value: args.value } : {}),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 500) };
  }
}
