// Combo / multi-leg position types shared across PTB builder, keeper, and API.

// ── Leg specs ─────────────────────────────────────────────────────────────────

export interface BinaryLegSpec {
  kind: 'binary'
  oracle_id: string  // hex object ID
  asset: string      // 'BTC', 'ETH', etc — for display only
  expiry: bigint     // unix ms
  strike: bigint     // scaled 1e9
  is_up: boolean     // true = YES (BTC > strike), false = NO (BTC ≤ strike)
  qty: bigint        // position quantity (scaled 1e6)
  max_cost: bigint   // 0 = market order; >0 = limit (scaled 1e6 USDC)
  escrow: bigint     // USDC to lock (>= theoretical max cost)
}

export interface RangeLegSpec {
  kind: 'range'
  oracle_id: string
  asset: string
  expiry: bigint
  lower_strike: bigint
  higher_strike: bigint
  qty: bigint
  max_cost: bigint
  escrow: bigint
}

export type LegSpec = BinaryLegSpec | RangeLegSpec

// ── Combo types ───────────────────────────────────────────────────────────────

// spread:    2 legs, same oracle, same expiry, K1 < K2. YES(K1) + NO(K2).
//            Wins if K1 < spot < K2 at expiry (parlay of the two).
// condor:    4 legs, same oracle, same expiry. 2 YES inner, 2 NO outer.
//            Wins if spot stays in the middle band.
// cross:     any number of legs across different assets / expiries.
//            All-or-nothing parlay.
// custom:    user-assembled arbitrary legs.
export type ComboKind = 'spread' | 'condor' | 'cross' | 'custom'

// payout mode
// parlay: all legs must win; payout = stake × product(1/prob_i) × (1 - edge)
// portfolio: independent legs, no pooled payout logic (just tracking)
export type PayoutMode = 'parlay' | 'portfolio'

export interface ComboSpec {
  kind: ComboKind
  mode: PayoutMode
  legs: LegSpec[]
  // UI-side denormalised fields
  label?: string      // e.g. 'BTC Spread 65k–70k'
  note?: string
}

// ── Settlement result per leg ─────────────────────────────────────────────────

export type LegStatus = 'pending' | 'active' | 'won' | 'lost' | 'voided'
export type ComboStatus = 'pending' | 'active' | 'won' | 'lost' | 'partial' | 'voided'

export interface LegState {
  spec:             LegSpec
  intent_id?:       bigint  // set after request_mint
  position_token?:  string  // object ID, set after execute_mint
  status:           LegStatus
  cost?:            bigint
  payout?:          bigint
}

export interface ComboState {
  id:         string   // server-assigned UUID
  spec:       ComboSpec
  owner:      string   // Sui address
  legs:       LegState[]
  status:     ComboStatus
  total_cost: bigint
  max_payout: bigint
  created_at: number   // unix ms
  last_expiry: bigint  // ms of last leg's expiry — keeper wakes up then
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function legExpiry(leg: LegSpec): bigint {
  return leg.expiry
}

export function lastExpiry(legs: LegSpec[]): bigint {
  return legs.reduce((max, l) => l.expiry > max ? l.expiry : max, 0n)
}

export function totalEscrow(legs: LegSpec[]): bigint {
  return legs.reduce((sum, l) => sum + l.escrow, 0n)
}

export function comboLabel(spec: ComboSpec): string {
  if (spec.label) return spec.label
  const assets = [...new Set(spec.legs.map(l => l.asset))].join('+')
  return `${spec.kind.toUpperCase()} · ${assets} · ${spec.legs.length}L`
}
