import { RH, robinhoodExitProfile } from "./config.ts";
import type { ExitProfile, LivePosition, LiveStrategyState, Position } from "./types.ts";

function cloneProfile(profile: ExitProfile): ExitProfile {
  return { ...profile, tp: profile.tp.map((x) => ({ ...x })) };
}

export function captureStrategyState(position: Position): LiveStrategyState {
  return {
    currentPrice: position.currentPrice,
    highestPrice: position.highestPrice,
    lowestPrice: position.lowestPrice,
    highestAt: position.highestAt,
    lowestAt: position.lowestAt,
    trailingActive: position.trailingActive,
    breakevenArmed: position.breakevenArmed,
    ...(position.trailHigh !== undefined ? { trailHigh: position.trailHigh } : {}),
    ...(position.highStreak !== undefined ? { highStreak: position.highStreak } : {}),
    tpHit: [...position.tpHit] as [boolean, boolean, boolean],
    exitProfile: cloneProfile(position.exitProfile ?? robinhoodExitProfile()),
    status: position.status,
    updatedAt: position.updatedAt,
    ...(position.closedAt !== undefined ? { closedAt: position.closedAt } : {}),
    ...(position.closedReason !== undefined ? { closedReason: position.closedReason } : {}),
    ...(position.exitTriggerPrice !== undefined ? { exitTriggerPrice: position.exitTriggerPrice } : {}),
  };
}

export function applyStrategyState(position: Position, state: LiveStrategyState): void {
  position.currentPrice = state.currentPrice;
  position.highestPrice = state.highestPrice;
  position.lowestPrice = state.lowestPrice;
  position.highestAt = state.highestAt;
  position.lowestAt = state.lowestAt;
  position.trailingActive = state.trailingActive;
  position.breakevenArmed = state.breakevenArmed;
  if (state.trailHigh === undefined) delete position.trailHigh; else position.trailHigh = state.trailHigh;
  if (state.highStreak === undefined) delete position.highStreak; else position.highStreak = state.highStreak;
  position.tpHit = [...state.tpHit] as [boolean, boolean, boolean];
  position.exitProfile = cloneProfile(state.exitProfile);
  position.status = state.status;
  position.updatedAt = state.updatedAt;
  if (state.closedAt === undefined) delete position.closedAt; else position.closedAt = state.closedAt;
  if (state.closedReason === undefined) delete position.closedReason; else position.closedReason = state.closedReason;
  if (state.exitTriggerPrice === undefined) delete position.exitTriggerPrice; else position.exitTriggerPrice = state.exitTriggerPrice;
}

export function legacyStrategyState(position: LivePosition, profile: ExitProfile): LiveStrategyState {
  const current = Number.isFinite(position.entryPriceUsd) && position.entryPriceUsd > 0 ? position.entryPriceUsd : 1;
  return {
    currentPrice: current,
    highestPrice: current,
    lowestPrice: current,
    highestAt: position.openedAt,
    lowestAt: position.openedAt,
    trailingActive: false,
    breakevenArmed: false,
    trailHigh: current,
    highStreak: 0,
    tpHit: [false, false, false],
    exitProfile: cloneProfile(profile),
    status: BigInt(position.remainingQtyRaw) > 0n ? "OPEN" : "CLOSED",
    updatedAt: position.updatedAt,
  };
}
