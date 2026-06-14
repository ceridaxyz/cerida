import type { Leg, PayoffPoint, Stats } from './types';

// Net P&L of a basket of range legs at a given settlement price.
// Each leg costs `leg.cost` up front and pays `leg.cost * leg.multiplier`
// if the price settles within [lower, upper).
export function pnlAtPrice(legs: Leg[], price: number): number {
  let pnl = 0;
  for (const leg of legs) {
    pnl -= leg.cost;
    if (price >= leg.lower && price < leg.upper) {
      pnl += leg.cost * leg.multiplier;
    }
  }
  return pnl;
}

// Price window covering all legs, padded for the payoff diagram.
export function priceRange(legs: Leg[]): [number, number] {
  if (legs.length === 0) return [0, 0];
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of legs) {
    lo = Math.min(lo, l.lower);
    hi = Math.max(hi, l.upper);
  }
  const pad = (hi - lo) * 0.18 || hi * 0.02;
  return [lo - pad, hi + pad];
}

export function computePayoff(legs: Leg[], samples = 240): PayoffPoint[] {
  if (legs.length === 0) return [];
  const [lo, hi] = priceRange(legs);
  const pts: PayoffPoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const price = lo + ((hi - lo) * i) / samples;
    pts.push({ price, pnl: pnlAtPrice(legs, price) });
  }
  return pts;
}

export function deriveStats(legs: Leg[]): Stats {
  const totalCost = legs.reduce((s, l) => s + l.cost, 0);
  if (legs.length === 0) {
    return {
      totalCost: 0,
      maxProfit: 0,
      maxProfitPct: 0,
      maxLoss: 0,
      breakevens: [],
      legCount: 0,
    };
  }

  const pts = computePayoff(legs, 480);
  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (const p of pts) {
    if (p.pnl > maxProfit) maxProfit = p.pnl;
    if (p.pnl < maxLoss) maxLoss = p.pnl;
  }

  // Breakevens: linear-interpolated zero crossings of the sampled curve.
  const breakevens: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const crosses =
      (a.pnl <= 0 && b.pnl > 0) || (a.pnl >= 0 && b.pnl < 0);
    if (crosses && a.pnl !== b.pnl) {
      const t = a.pnl / (a.pnl - b.pnl);
      breakevens.push(a.price + t * (b.price - a.price));
    }
  }

  return {
    totalCost,
    maxProfit,
    maxProfitPct: totalCost ? (maxProfit / totalCost) * 100 : 0,
    maxLoss,
    breakevens,
    legCount: legs.length,
  };
}
