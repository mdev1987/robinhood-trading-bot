#!/bin/sh
# oxmgr health probe for chain-pair-paper-bot.
# The worker's health loop rewrites data/state.json roughly every 10s
# (see persist() in src/main.ts), while stdout is silent when no
# candidates/positions exist — so log mtime is NOT a liveness signal.
# Stale state.json (>3 min) means the loop is stuck or wedged on I/O.
# Missing file = fresh boot, pass so the first check does not kill startup.
STATE_FILE="/home/mdev/Programming/robinhood-chain-trading-bot/data/state.json"
test ! -f "$STATE_FILE" && exit 0
test -n "$(/usr/bin/find "$STATE_FILE" -mmin -3 2>/dev/null)"
