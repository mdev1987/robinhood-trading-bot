# Robinhood Chain New-Pool Trading Bot

Bun + TypeScript, Robinhood Chain only (chain ID 4663). The bot is intentionally single-chain so discovery, execution, accounting, and recovery all share one exact market definition.

## Strategy

The production configuration preserves the observed Robinhood paper regime:

- DexPaprika discovery using cursor pagination, sorted by pool creation time.
- Eligible pool age: 60–120 seconds.
- Liquidity: $15,000–$100,000.
- Quote token: WETH plus native-ETH-quoted pools (zero address on DexScreener), treated as the same venue quote because execution sells into native ETH.
- DEX: Uniswap.
- DexScreener is the market-data/exit mark at 1 second.
- 3-second confirmation; material price/liquidity deterioration rejects the entry.
- Final band gate: age + liquidity are rechecked on the confirmation print, so entries that aged out during confirmation are skipped in paper and live alike.
- One entry per pool, one open position per symbol, maximum 3 open positions.
- TP1 +30% / 25%, TP2 +60% / 25%, TP3 +100% / 25%, remaining 25% is the runner.
- Early stop -10% for 180 seconds, initial stop -15%.
- Breakeven arms at +20% with a +3% buffer.
- Trail activates at +30% with a 15% distance.
- Maximum hold 60 minutes.
- New entries pause during 20:00–23:59 UTC.

These values preserve the research regime; they do not guarantee future profitability.

## Execution model

Every live transaction is fail-closed and receipt-driven:

1. Direct Robinhood Uniswap V2 is attempted first when the discovered pair is the canonical V2 pair. The adapter verifies the factory mapping before building calldata.
2. 0x Swap API v2 AllowanceHolder is the fallback/general EVM router. 0x returns executable calldata and the exact allowance spender; the bot never approves the Settler contract.
3. Fresh V3/V4 pools are traded only when 0x has an executable route. The bot skips an unindexed pool rather than manufacturing direct calldata.
4. `eth_call` simulation runs immediately before submission.
5. All wallet writes are serialized with a transaction lock.
6. Native ETH input is checked against transaction `value` before signing.
7. Buy/sell fills are derived from receipt logs: ERC-20 `Transfer` events and WETH `Withdrawal` for native ETH output.
8. The live order state machine is `SIGNAL → SUBMITTED → CONFIRMED → APPLIED`, with `UNKNOWN` as a deliberate fail-closed state.
9. A confirmed order is never resubmitted; restart reconciliation applies it idempotently.
10. Pending exit intents are durable, retried, and revalidated against a fresh market print including liquidity for drain exits.
11. Exit state (TP flags, trailing, breakeven, highs/lows) is persisted with the live position and restored exactly.
12. A persistent daily-loss kill switch stops new entries but does not disable exit management.

### 0x price-impact limitation

0x v2 does not provide a venue `priceImpactPct` field in the response used by this bot. The bot therefore labels 0x impact as `unknown` rather than pretending it is measured. The independent quote-to-DexScreener deviation gate remains active and is applied before simulation/submission. Direct V2 quotes compute an approximate reserve-based impact and are checked by the normal risk policy.

## Discovery completeness

DexPaprika's `listByNetwork()` is cursor-paginated. The bot pages until either there is no next page or the oldest fetched pool is outside the 60–120 second research window. A safety cap of 10 pages prevents an unexpected API condition from looping forever. If the configured page limit is reached, the bot logs a saturation warning.

## Robinhood infrastructure

The bot verifies RPC chain ID 4663 and the configured WETH, Uniswap V2/V3, and Uniswap V4 infrastructure before live trading. For live mode, `ROBINHOOD_RPC_URL` is mandatory; use a production RPC provider and keep `ROBINHOOD_RPC_FALLBACK_URL` as a second provider where available. Do not use the public RPC for a latency-sensitive live deployment.

## Install

```bash
bun install
cp .env.example .env
```

Paper is the default. Live mode requires:

```dotenv
MODE=live
AUTO_ENTRY=true
LIVE_TRADING_ENABLED=true
TRADER_PRIVATE_KEY=0x...
ROBINHOOD_RPC_URL=https://...
ZEROEX_API_KEY=...
```

Keep `LIVE_TEST_TRADE=false` until the wallet is ready. The smoke test performs only a tiny ETH↔WETH round trip through 0x and records the transaction hash in `data/live-smoke.json`.

## Paper mode

```bash
bun run start
```

Set `AUTO_ENTRY=true` for the actual paper strategy.

Paper is deliberately harsher than live:

- Paper entries clear the same live-router quote + 3% deviation gate as live buys (read-only, never broadcast). Unroutable entries are skipped, not filled at fantasy marks. With an unfunded wallet, 0x reports `insufficient taker balance`; the probe records `0x-balance-limited` and passes (route exists, deviation unknown) with a warning instead of skipping.
- Paper BUYs fill at the **quoted output** (`buyAmount`, `minBuyAmount`-checked) with live-style estimated gas floored at the fixed model — no mark fill, no fixed-slippage assumption. Without a quote, entries fall back to the mark fill with the pessimism stack.
- Every paper sell quotes the live router first (with one slippage-escalated retry) and fills at the **quoted output**; only unquotable exits fall back to mark + haircut. Quote rows land in `quote_checks`.
- Costs: configurable bps fees/slippage per side plus a fixed `PAPER_GAS_PER_FILL_USD` per fill and a `PAPER_EXIT_HAIRCUT_PCT` haircut on fallback (mark) sells, all booked into cash, realized PnL, and fee/slippage totals.
- Every Telegram message carries a `💰 Balance: before → after` leg.

A 5-minute WAL checkpoint keeps external DuckDB copies fresh. Unit tests pin the research regime (`bun run test` sets the band + zero friction); raw `bun test` follows the operator `.env` instead.

## Live rollout

Use a fresh pilot wallet. Start with the configured $10 position size and maximum 3 positions. First verify the tiny ETH↔WETH smoke test, then run the strategy with small capital while comparing:

- DexScreener mark vs 0x/direct-V2 quote
- quote vs actual fill
- gas per entry/exit
- receipt output vs journaled quantity
- restart recovery after open positions and partial TPs

The runtime is designed to fail closed when any of those checks cannot be established.

## Persistence

- `data/live-state.json` — canonical live state, orders, positions, pending exits, daily PnL, accounting cash.
- `data/live-orders.json` — operator mirror of the order journal.
- `data/live-positions.json` — operator mirror of live positions.
- `data/live-kill-switch.json` — persistent manual entry kill switch.
- `data/state.json` — paper/closed-trade reporting state.
- `data/paper.duckdb` — optional analytics store.

All JSON writes use temporary files followed by rename. The bot lock also uses atomic `wx` creation and records PID, hostname, and process start time to avoid common container PID-reuse failures.

## Checks

```bash
bun run check
bun run test
bun run smoke
```

The repository intentionally contains no wallet keys and no `.env`.
