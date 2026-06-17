// Grid-based trading — shared types.
// Prices are plain USD floats in the UI layer; on-chain integration would
// scale these by 1e9 at the boundary.

export type CellState =
  | 'available'
  | 'selected'
  | 'active'
  | 'won'
  | 'claimable' // settled winner you hold — call claim_window_bet
  | 'lost'
  | 'expired';

export interface Band {
  idx: number;
  lower: number;
  upper: number;
}

export interface Epoch {
  id: string;
  idx: number;
  start: number; // ms timestamp
  end: number;
}

export interface GridCell {
  epochId: string;
  bandIdx: number;
  lower: number;
  upper: number;
  prob: number; // 0–1
  multiplier: number; // payout / cost
  cost: number; // cost for 1 unit
  state: CellState;
  uPnl?: number; // only for active positions
}

export interface Leg {
  key: string; // `${epochId}:${bandIdx}`
  epochId: string;
  bandIdx: number;
  lower: number;
  upper: number;
  qty: number;
  cost: number; // total cost (unit cost × qty)
  multiplier: number;
}

export interface PayoffPoint {
  price: number;
  pnl: number;
}

export interface Stats {
  totalCost: number;
  maxProfit: number;
  maxProfitPct: number;
  maxLoss: number;
  breakevens: number[];
  legCount: number;
}
