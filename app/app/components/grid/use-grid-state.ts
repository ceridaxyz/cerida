import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { Band, Epoch, GridCell, Leg, PayoffPoint, Stats } from './types';
import { computePayoff, deriveStats } from './payoff';

// ── Tuning ───────────────────────────────────────────────────────────────────
const EDGE = 0.06; // house edge baked into multipliers
const UNIT_PAYOUT = 60; // a winning unit pays this notional
const CENTER = 1674; // anchor price for the strike ladder
// Wide ladder so the price-anchored viewport always has bands above/below to
// scroll into; the chart render-filters to the visible price window.
const NUM_BANDS = 22;
// Reference 1σ (price units) used to lay out EQUAL-PROBABILITY bands: strikes
// sit at quantiles of N(CENTER, REF_SIGMA) so each band carries ≈1/N mass at
// the reference horizon — narrow near the money, wide in the tails. Mirrors
// windows.move's quantile-inversion band model.
const REF_SIGMA = 20;
const EPOCH_MS = 60_000;
// Wide ladder so the sliding-window chart always has columns to scroll into.
// Only a handful are on-screen at once; the chart render-filters to the window.
const NUM_PAST = 6;
const NUM_FUTURE = 24;
const TICK_MS = 600;

// Normal CDF (Abramowitz–Stegun erf) and its inverse (Acklam probit).
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x));
  return x >= 0 ? y : -y;
}
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

// Exact probability that price settles within [lower, higher) under N(price, sigma).
function bandProb(lower: number, higher: number, price: number, sigma: number): number {
  const p = normCdf((higher - price) / sigma) - normCdf((lower - price) / sigma);
  return Math.max(0.005, Math.min(0.95, p));
}

// Diffusion sigma (in price units) as a function of horizon — drives both the
// per-band probabilities and the expected-move cone. Grows ~√t.
export function sigmaForHorizon(epochsAhead: number): number {
  return 3 + 2.2 * Math.sqrt(Math.max(0, epochsAhead));
}

// Deterministic, stable settlement price for a past epoch (no flicker).
function settlementPrice(epochStart: number): number {
  const seed = Math.sin(epochStart * 0.0013) * 43758.5453;
  const frac = seed - Math.floor(seed);
  return CENTER + (frac - 0.5) * (REF_SIGMA * 2.8);
}

export interface GridState {
  strikes: number[];
  bands: Band[];
  epochs: Epoch[];
  now: number;
  price: number;
  history: { t: number; price: number }[];
  currentEpochId: string | null;
  focusedEpoch: string;
  setFocusedEpoch: (id: string) => void;
  cellFor: (epoch: Epoch, band: Band) => GridCell;
  // Expected-move cone: ±1σ price half-width at a future timestamp.
  sigmaAtTime: (t: number) => number;
  // Settlement price for a past epoch (null if not yet settled).
  settleOf: (epoch: Epoch) => number | null;
  legs: Map<string, Leg>;
  hasLeg: (key: string) => boolean;
  toggleLeg: (epoch: Epoch, band: Band) => void;
  addLeg: (epoch: Epoch, band: Band) => void;
  removeLeg: (key: string) => void;
  updateLegCost: (key: string, cost: number) => void;
  updateAllLegCosts: (cost: number) => void;
  clearLegs: () => void;
  legsArr: Leg[];
  payoffPoints: PayoffPoint[];
  stats: Stats;
  stake: number;
  setStake: (v: number) => void;
}

export function useGridState(): GridState {
  // Equal-probability strike ladder: boundaries at quantiles of N(CENTER, REF_SIGMA),
  // so each band carries ≈1/N mass — narrow near the money, wide in the tails.
  const strikes = useMemo(() => {
    const eps = 0.4 / NUM_BANDS;
    return Array.from({ length: NUM_BANDS + 1 }, (_, i) => {
      const p = eps + (1 - 2 * eps) * (i / NUM_BANDS);
      return Math.round(CENTER + REF_SIGMA * probit(p));
    });
  }, []);

  // Manual stake ($ per band/leg) — drives cost/payout everywhere.
  const [stake, setStake] = useState(10);

  const bands = useMemo<Band[]>(
    () =>
      strikes.slice(0, -1).map((lo, i) => ({
        idx: i,
        lower: lo,
        upper: strikes[i + 1]!,
      })),
    [strikes],
  );

  // Live price — random walk, with a short rolling history for the chart line.
  const [price, setPrice] = useState(CENTER + 0.6);
  const [now, setNow] = useState(() => Date.now());
  const [history, setHistory] = useState<{ t: number; price: number }[]>(() => [
    { t: Date.now(), price: CENTER + 0.6 },
  ]);

  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setPrice((p) => {
        // Mean-reverting walk: keeps price near CENTER so it stays on the
        // strike ladder while the viewport scrolls vertically around it.
        const next = p + (CENTER - p) * 0.04 + (Math.random() - 0.5) * 1.8;
        setHistory((h) => [...h.slice(-600), { t, price: next }]);
        return next;
      });
      setNow(t);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Rolling epoch ladder anchored on the current minute, so the chart never runs
  // out of future columns as wall-clock time advances. Ids are absolute (epoch
  // index) so leg keys stay valid as columns scroll from future → past.
  const nowBucket = Math.floor(now / EPOCH_MS);
  const epochs = useMemo<Epoch[]>(
    () =>
      Array.from({ length: NUM_PAST + NUM_FUTURE + 1 }, (_, k) => {
        const idxAbs = nowBucket - NUM_PAST + k;
        const start = idxAbs * EPOCH_MS;
        return { id: `e${idxAbs}`, idx: k, start, end: start + EPOCH_MS };
      }),
    [nowBucket],
  );

  const currentEpochId = useMemo(() => {
    const e = epochs.find((ep) => now >= ep.start && now < ep.end);
    return e ? e.id : null;
  }, [epochs, now]);

  const [focusedEpoch, setFocusedEpoch] = useState<string>(() => {
    const firstFuture = epochs.find((e) => e.idx === NUM_PAST);
    return firstFuture ? firstFuture.id : epochs[0]!.id;
  });

  // ── Legs (shared selection) ────────────────────────────────────────────────
  const [legs, setLegs] = useState<Map<string, Leg>>(new Map());

  const hasLeg = useCallback((key: string) => legs.has(key), [legs]);

  const addLeg = useCallback(
    (epoch: Epoch, band: Band) => {
      const key = `${epoch.id}:${band.idx}`;
      setLegs((prev) => {
        if (prev.has(key)) return prev;
        const epochsAhead = Math.max(1, (epoch.end - Date.now()) / EPOCH_MS);
        const sigma = sigmaForHorizon(epochsAhead);
        const prob = bandProb(band.lower, band.upper, price, sigma);
        const multiplier = (1 - EDGE) / prob;
        const next = new Map(prev);
        next.set(key, {
          key,
          epochId: epoch.id,
          bandIdx: band.idx,
          lower: band.lower,
          upper: band.upper,
          qty: 1,
          cost: stakeRef.current,
          multiplier,
        });
        return next;
      });
    },
    [price],
  );

  const removeLeg = useCallback((key: string) => {
    setLegs((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleLeg = useCallback(
    (epoch: Epoch, band: Band) => {
      const key = `${epoch.id}:${band.idx}`;
      if (legs.has(key)) removeLeg(key);
      else addLeg(epoch, band);
    },
    [legs, addLeg, removeLeg],
  );

  const clearLegs = useCallback(() => setLegs(new Map()), []);

  const updateLegCost = useCallback((key: string, cost: number) => {
    setLegs((prev) => {
      const leg = prev.get(key);
      if (!leg) return prev;
      const next = new Map(prev);
      next.set(key, { ...leg, cost: Math.max(0, cost) });
      return next;
    });
  }, []);

  const updateAllLegCosts = useCallback((cost: number) => {
    setLegs((prev) => {
      if (prev.size === 0) return prev;
      const safeC = Math.max(0, cost);
      const next = new Map(prev);
      for (const [k, leg] of prev) next.set(k, { ...leg, cost: safeC });
      return next;
    });
  }, []);

  // ── Cell derivation ─────────────────────────────────────────────────────────
  // Keep a live price ref so cellFor reflects the latest tick without
  // re-creating the callback every frame.
  const priceRef = useRef(price);
  priceRef.current = price;
  const nowRef = useRef(now);
  nowRef.current = now;
  const stakeRef = useRef(stake);
  stakeRef.current = stake;

  const cellFor = useCallback(
    (epoch: Epoch, band: Band): GridCell => {
      const p = priceRef.current;
      const tNow = nowRef.current;
      const epochsAhead = Math.max(1, (epoch.end - tNow) / EPOCH_MS);
      const sigma = sigmaForHorizon(epochsAhead);
      const liveProb = bandProb(band.lower, band.upper, p, sigma);
      const key = `${epoch.id}:${band.idx}`;
      const leg = legs.get(key);

      // Once you hold a leg, its price is LOCKED at entry — show the leg's
      // captured multiplier, not a live-recomputed one. Empty cells stay live.
      const multiplier = leg ? leg.multiplier : (1 - EDGE) / liveProb;
      const prob = leg ? (1 - EDGE) / leg.multiplier : liveProb;
      const cost = Math.round((UNIT_PAYOUT / multiplier) * 100) / 100;

      const started = epoch.start <= tNow && tNow < epoch.end;
      const isPast = epoch.end <= tNow;
      const inBand = p >= band.lower && p < band.upper;

      let state: GridCell['state'] = 'available';
      let uPnl: number | undefined;
      if (isPast) {
        // Settled epoch: the band holding the settlement price wins. A winning
        // band you hold a leg in is CLAIMABLE — the keeper has redeemed the
        // Predict hedge into vault.settlements; you call claim_window_bet.
        const settle = settlementPrice(epoch.start);
        const winner = settle >= band.lower && settle < band.upper;
        if (winner && leg) {
          state = 'claimable';
          uPnl = leg.cost * (leg.multiplier - 1);
        } else {
          state = winner ? 'won' : 'lost';
        }
      } else if (leg) {
        if (started) {
          state = 'active';
          uPnl = inBand ? leg.cost * (leg.multiplier - 1) : -leg.cost;
        } else {
          state = 'selected';
        }
      }

      return {
        epochId: epoch.id,
        bandIdx: band.idx,
        lower: band.lower,
        upper: band.upper,
        prob,
        multiplier,
        cost, // per-unit market ask (BandPanel/market info); stake is the bet size
        state,
        uPnl,
      };
    },
    [legs],
  );

  const sigmaAtTime = useCallback(
    (t: number) => sigmaForHorizon((t - nowRef.current) / EPOCH_MS),
    [],
  );

  const settleOf = useCallback(
    (epoch: Epoch) =>
      epoch.end <= nowRef.current ? settlementPrice(epoch.start) : null,
    [],
  );

  const legsArr = useMemo(() => [...legs.values()], [legs]);
  const payoffPoints = useMemo(() => computePayoff(legsArr), [legsArr]);
  const stats = useMemo(() => deriveStats(legsArr), [legsArr]);

  return {
    strikes,
    bands,
    epochs,
    now,
    price,
    history,
    currentEpochId,
    focusedEpoch,
    setFocusedEpoch,
    cellFor,
    sigmaAtTime,
    settleOf,
    legs,
    hasLeg,
    toggleLeg,
    addLeg,
    removeLeg,
    updateLegCost,
    updateAllLegCosts,
    clearLegs,
    legsArr,
    payoffPoints,
    stats,
    stake,
    setStake,
  };
}
