import { test, expect } from "bun:test";
import { mapZeroExQuote } from "../src/execution/evm/zeroex.ts";

test("0x v2 uses the allowance spender reported by the API", () => {
  const q = mapZeroExQuote({ chain:"robinhood", sellToken:"0x0000000000000000000000000000000000000001", buyToken:"0x0000000000000000000000000000000000000002", sellAmountBaseUnits:"100", taker:"0x0000000000000000000000000000000000000003", slippageBps:100 }, {
    liquidityAvailable:true, sellToken:"0x1", buyToken:"0x2", sellAmount:"100", buyAmount:"90",
    issues:{ allowance:{ spender:"0x0000000000000000000000000000000000000004" } },
    transaction:{ to:"0x0000000000000000000000000000000000000005", data:"0x1234", value:"0" },
  });
  expect((q.raw as any).allowanceTarget).toBe("0x0000000000000000000000000000000000000004");
});


test("receipt extraction proves ERC20 sell and buy transfers", async () => {
  const { extractExecutionAmounts } = await import("../src/execution/evm/live.ts");
  const trader = "0x0000000000000000000000000000000000000003";
  const sellToken = "0x0000000000000000000000000000000000000002";
  const buyToken = "0x0000000000000000000000000000000000000006";
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (x:string) => "0x" + x.slice(2).padStart(64, "0");
  const logs = [
    { address: sellToken, topics:[transferTopic, pad(trader), pad("0x0000000000000000000000000000000000000004")], data:"0x64" },
    { address: buyToken, topics:[transferTopic, pad("0x0000000000000000000000000000000000000004"), pad(trader)], data:"0x5a" },
  ];
  const result = extractExecutionAmounts(logs, trader, sellToken, buyToken, "100");
  expect(result.sellAmount).toBe("100");
  expect(result.buyAmount).toBe("90");
});
