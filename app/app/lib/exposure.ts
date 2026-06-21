// LP net exposure utilities.
//
// The vault tracks (yes_qty, no_qty) for every (oracle, expiry, strike/range) key.
// LP is perfectly hedged at a key when yes_qty == no_qty: one side always wins,
// so the vault pays exactly $1 per hedged pair regardless of outcome.
//
// Unhedged imbalance = |yes_qty - no_qty| drives inventory-adjusted pricing:
//   quoted_ask_YES = fair_prob + spread + k * imbalance / pool_capacity
//   quoted_ask_NO  = fair_prob + spread - k * imbalance / pool_capacity
// This makes the expensive (surplus) side costlier and the scarce side cheaper,
// organically attracting offsetting flow.

export interface BinaryExposure {
  yesQty: number;
  noQty: number;
}

export interface SkewParams {
  /** Inventory sensitivity coefficient (0–1). Higher = more aggressive skew. */
  k: number;
  /** Total pool capacity in contracts (normalises imbalance to [0, 1]). */
  poolCapacity: number;
}

/**
 * Compute the inventory skew adjustment for a binary market.
 * Returns a signed delta to ADD to the YES ask and SUBTRACT from the NO ask.
 *
 * Positive delta  → LP is net long YES (sold more YES than NO) → make YES dearer,
 *                   NO cheaper to attract NO buyers.
 * Negative delta  → LP is net long NO → make NO dearer, YES cheaper.
 */
export function binarySkewDelta(
  { yesQty, noQty }: BinaryExposure,
  { k, poolCapacity }: SkewParams,
): number {
  if (poolCapacity <= 0) return 0;
  const imbalance = yesQty - noQty; // signed: positive = more YES outstanding
  return k * (imbalance / poolCapacity);
}

/**
 * Adjust a fair-value probability into a quoted ask for the YES side.
 * The NO ask is `fairProb + spread - skewDelta`.
 */
export function quotedYesAsk(
  fairProb: number,
  spread: number,
  skewDelta: number,
): number {
  return Math.max(0.01, Math.min(0.99, fairProb + spread + skewDelta));
}

export function quotedNoAsk(
  fairProb: number,
  spread: number,
  skewDelta: number,
): number {
  return Math.max(0.01, Math.min(0.99, fairProb + spread - skewDelta));
}

/**
 * For a range market, only the in-range (YES) side is tracked.
 * Positive inventory means LP has sold a lot of in-range contracts: make it
 * more expensive so traders shift to out-of-range combos or other strikes.
 */
export function rangeSkewDelta(
  inRangeQty: number,
  { k, poolCapacity }: SkewParams,
): number {
  if (poolCapacity <= 0) return 0;
  return k * (inRangeQty / poolCapacity);
}

/**
 * Net unhedged exposure in contracts.
 * For binary: min(yes_qty, no_qty) contracts are perfectly hedged; the residual
 * is the LP's directional risk.
 */
export function netUnhedgedBinary({ yesQty, noQty }: BinaryExposure): number {
  return Math.abs(yesQty - noQty);
}

/**
 * Maximum possible payout of the unhedged tail given $1/contract payoff.
 * This is the LP's actual worst-case loss at a single key.
 */
export function maxLossAtKey({ yesQty, noQty }: BinaryExposure): number {
  return Math.abs(yesQty - noQty); // $1 per contract, scaled externally
}
