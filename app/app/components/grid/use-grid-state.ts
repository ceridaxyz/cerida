import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { Band, Epoch, GridCell, Leg, PayoffPoint, Stats } from './types';
import { computePayoff, deriveStats } from './payoff';

// ── Tuning ───────────────────────────────────────────────────────────────────
const EDGE = 0.06; // house edge baked into multipliers
const UNIT_PAYOUT = 60; // a winning unit pays this notional
const BAND_STEP = 4; // dollars per band
const CENTER = 1674; // anchor price for the strike ladder
const NUM_BANDS = 12;
const EPOCH_MS = 60_000;
const NUM_PAST = 3;
const NUM_FUTURE = 7;
const TICK_MS = 600;

function gaussianProb(mid: number, price: number, sigma: number): number {
  const z = (mid - price) / sigma;
  const density = Math.exp(-0.5 * z * z);
  const p = density * (BAND_STEP / (sigma * 2.5));
  return Math.max(0.01, Math.min(0.92, p));
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
  return CENTER + (frac - 0.5) * (BAND_STEP * NUM_BANDS * 0.7);
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
  legs: Map<string, Leg>;
  hasLeg: (key: string) => boolean;
  toggleLeg: (epoch: Epoch, band: Band) => void;
  addLeg: (epoch: Epoch, band: Band) => void;
  removeLeg: (key: string) => void;
  clearLegs: () => void;
  legsArr: Leg[];
  payoffPoints: PayoffPoint[];
  stats: Stats;
}

export function useGridState(): GridState {
  // Strike ladder (ascending) and bands between consecutive strikes.
  const strikes = useMemo(() => {
    const base = CENTER - (NUM_BANDS / 2) * BAND_STEP;
    return Array.from({ length: NUM_BANDS + 1 }, (_, i) => base + i * BAND_STEP);
  }, []);

  const bands = useMemo<Band[]>(
    () =>
      strikes.slice(0, -1).map((lo, i) => ({
        idx: i,
        lower: lo,
        upper: strikes[i + 1]!,
      })),
    [strikes],
  );

  // Epoch ladder anchored once so columns don't jitter as time advances.
  const t0 = useMemo(() => Math.floor(Date.now() / EPOCH_MS) * EPOCH_MS, []);
  const epochs = useMemo<Epoch[]>(
    () =>
      Array.from({ length: NUM_PAST + NUM_FUTURE + 1 }, (_, k) => {
        const rel = k - NUM_PAST;
        const start = t0 + rel * EPOCH_MS;
        return { id: `e${rel}`, idx: k, start, end: start + EPOCH_MS };
      }),
    [t0],
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
        const next = p + (Math.random() - 0.5) * 1.8;
        setHistory((h) => [...h.slice(-200), { t, price: next }]);
        return next;
      });
      setNow(t);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

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
        const mid = (band.lower + band.upper) / 2;
        const epochsAhead = Math.max(1, (epoch.end - Date.now()) / EPOCH_MS);
        const sigma = sigmaForHorizon(epochsAhead);
        const prob = gaussianProb(mid, price, sigma);
        const multiplier = (1 - EDGE) / prob;
        const cost = Math.round((UNIT_PAYOUT / multiplier) * 100) / 100;
        const next = new Map(prev);
        next.set(key, {
          key,
          epochId: epoch.id,
          bandIdx: band.idx,
          lower: band.lower,
          upper: band.upper,
          qty: 1,
          cost,
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

  // ── Cell derivation ─────────────────────────────────────────────────────────
  // Keep a live price ref so cellFor reflects the latest tick without
  // re-creating the callback every frame.
  const priceRef = useRef(price);
  priceRef.current = price;
  const nowRef = useRef(now);
  nowRef.current = now;

  const cellFor = useCallback(
    (epoch: Epoch, band: Band): GridCell => {
      const p = priceRef.current;
      const tNow = nowRef.current;
      const mid = (band.lower + band.upper) / 2;
      const epochsAhead = Math.max(1, (epoch.end - tNow) / EPOCH_MS);
      const sigma = 3 + 2.2 * Math.sqrt(epochsAhead);
      const prob = gaussianProb(mid, p, sigma);
      const multiplier = (1 - EDGE) / prob;
      const cost = Math.round((UNIT_PAYOUT / multiplier) * 100) / 100;
      const key = `${epoch.id}:${band.idx}`;
      const leg = legs.get(key);

      const started = epoch.start <= tNow && tNow < epoch.end;
      const isPast = epoch.end <= tNow;
      const inBand = p >= band.lower && p < band.upper;

      let state: GridCell['state'] = 'available';
      let uPnl: number | undefined;
      if (isPast) {
        // Settled epoch: the band holding the settlement price wins.
        const settle = settlementPrice(epoch.start);
        state = settle >= band.lower && settle < band.upper ? 'won' : 'lost';
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
        cost: leg ? leg.cost : cost,
        state,
        uPnl,
      };
    },
    [legs],
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
    legs,
    hasLeg,
    toggleLeg,
    addLeg,
    removeLeg,
    clearLegs,
    legsArr,
    payoffPoints,
    stats,
  };
}
