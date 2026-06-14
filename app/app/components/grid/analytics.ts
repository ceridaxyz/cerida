// Derived analytics for the grid — all computed from the live GridState so the
// numbers stay consistent with what the cells/bands show. Pure functions only.

import type { GridState } from './use-grid-state';
import type { Band, Epoch, Leg } from './types';

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export interface BandDist {
  band: Band;
  prob: number;
  mult: number;
  inPrice: boolean;
}

export interface Analytics {
  focused: Epoch;
  dist: BandDist[]; // probability mass per band, high→low price
  mean: number; // probability-weighted expected settle price
  sigma: number; // 1σ move in dollars
  lower1: number; // mean − σ
  upper1: number; // mean + σ
  ivPct: number; // annualized implied vol (%)
  secsToExpiry: number;
  // selection-derived (legs)
  ev: number; // expected value of current selection ($)
  evPct: number; // ev / cost
  winProb: number; // P(at least one leg in the money)
  totalCost: number;
}

// Volume per band — deterministic synthetic flow so it doesn't flicker.
export function bandVolume(epochId: string, bandIdx: number): number {
  const seed = Math.sin((bandIdx + 1) * 12.9898 + epochId.length * 78.233) * 43758.5453;
  const frac = seed - Math.floor(seed);
  return Math.round((0.2 + frac * frac * 9.8) * 100) / 10; // ~0.2–10.0 (×$1k)
}

export function computeAnalytics(s: GridState): Analytics {
  const focused = s.epochs.find((e) => e.id === s.focusedEpoch) ?? s.epochs[0]!;

  // Probability mass across bands for the focused epoch.
  const dist: BandDist[] = [...s.bands]
    .sort((a, b) => b.lower - a.lower)
    .map((band) => {
      const cell = s.cellFor(focused, band);
      return {
        band,
        prob: cell.prob,
        mult: cell.multiplier,
        inPrice: s.price >= band.lower && s.price < band.upper,
      };
    });

  // Normalise (band probs are independent gaussian samples, not a true pmf).
  const probSum = dist.reduce((a, d) => a + d.prob, 0) || 1;
  const mean = dist.reduce((a, d) => {
    const mid = (d.band.lower + d.band.upper) / 2;
    return a + (d.prob / probSum) * mid;
  }, 0);
  const variance = dist.reduce((a, d) => {
    const mid = (d.band.lower + d.band.upper) / 2;
    return a + (d.prob / probSum) * (mid - mean) ** 2;
  }, 0);
  const sigma = Math.sqrt(variance);

  const secsToExpiry = Math.max(1, (focused.end - s.now) / 1000);
  const ivPct =
    (sigma / s.price) * Math.sqrt(SECONDS_PER_YEAR / secsToExpiry) * 100;

  // ── Selection analytics ─────────────────────────────────────────────────────
  const legs = s.legsArr;
  const totalCost = legs.reduce((a, l) => a + l.cost, 0);

  // Group legs by epoch; within an epoch only one band can win.
  const byEpoch = new Map<string, Leg[]>();
  for (const l of legs) {
    const arr = byEpoch.get(l.epochId) ?? [];
    arr.push(l);
    byEpoch.set(l.epochId, arr);
  }

  let ev = 0;
  let surviveProb = 1; // P(no leg wins) across independent epochs
  for (const [epochId, group] of byEpoch) {
    const epoch = s.epochs.find((e) => e.id === epochId);
    if (!epoch) continue;
    const epochCost = group.reduce((a, l) => a + l.cost, 0);
    const covered = new Map(group.map((l) => [l.bandIdx, l]));

    // Probability-weighted payoff over all bands of this epoch.
    let pmass = 0;
    let evWin = 0;
    let pWin = 0;
    for (const band of s.bands) {
      const cell = s.cellFor(epoch, band);
      pmass += cell.prob;
      const leg = covered.get(band.idx);
      if (leg) {
        evWin += cell.prob * leg.cost * leg.multiplier;
        pWin += cell.prob;
      }
    }
    const norm = pmass || 1;
    ev += evWin / norm - epochCost;
    surviveProb *= 1 - pWin / norm;
  }

  const winProb = legs.length ? 1 - surviveProb : 0;
  const evPct = totalCost ? (ev / totalCost) * 100 : 0;

  return {
    focused,
    dist,
    mean,
    sigma,
    lower1: mean - sigma,
    upper1: mean + sigma,
    ivPct,
    secsToExpiry,
    ev,
    evPct,
    winProb,
    totalCost,
  };
}
