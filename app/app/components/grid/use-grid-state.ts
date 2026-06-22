import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { Band, Epoch, GridCell, Leg, PayoffPoint, Stats } from './types';
import { computePayoff, deriveStats } from './payoff';
import {
  getOracles, getActiveLadder, getLatestPrice, getLatestSvi, getPriceHistory,
} from '../../lib/predict-api';
import type { Oracle, Svi } from '../../lib/predict-api';
import { yesNo } from '../../lib/svi';

// ── Config ────────────────────────────────────────────────────────────────────
const ANNUAL_VOL    = 0.60;   // fallback vol when SVI is flat (testnet)
const EDGE          = 0.04;   // spread baked into displayed multiplier
const UNIT_PAYOUT   = 100;    // display: a winning unit pays $100
const POLL_MS       = 10_000; // live price refresh
const HISTORY_LIMIT = 300;

// ── Helpers ───────────────────────────────────────────────────────────────────
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t * Math.exp(-x * x));
  return x >= 0 ? y : -y;
}
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

// Risk-neutral probability spot expires in [lower, upper].
// Falls back to log-normal when SVI is flat (testnet b ≈ 0).
function rangeProb(
  svi: Svi | null, forward: number,
  lower: number, upper: number, tYears: number,
): number {
  if (forward <= 0 || lower >= upper || tYears <= 0) return 1 / 3;
  const hasSvi = svi != null && (Math.abs(svi.a) + Math.abs(svi.b)) > 1e-6;
  if (hasSvi) {
    const p = yesNo(svi!, forward, lower).yes - yesNo(svi!, forward, upper).yes;
    return Math.max(0.005, Math.min(0.99, p));
  }
  const sigma = forward * ANNUAL_VOL * Math.sqrt(tYears);
  if (sigma <= 0) return 1 / 3;
  return Math.max(0.005, Math.min(0.99,
    normCdf((upper - forward) / sigma) - normCdf((lower - forward) / sigma),
  ));
}

function sigmaForTime(forward: number, t: number): number {
  const tYears = Math.max((t - Date.now()) / (365.25 * 24 * 3600e3), 0);
  return Math.max(1, forward * ANNUAL_VOL * Math.sqrt(tYears));
}

// Sigma-adjusted strikes: [outer_lo, inner_lo, inner_hi, outer_hi]
function computeStrikes(forward: number, tYears: number, tick: number): number[] {
  const sigma = forward * ANNUAL_VOL * Math.sqrt(Math.max(tYears, 1 / 525_960));
  const snap  = (d: number) => Math.round(d / tick) * tick;
  const inner = Math.max(tick, snap(sigma * 0.5));
  const outer = Math.max(inner + tick, snap(sigma * 2.5));
  return [forward - outer, forward - inner, forward + inner, forward + outer];
}

function oracleToEpoch(o: Oracle, idx: number): Epoch {
  return {
    id: o.oracle_id, oracleId: o.oracle_id, idx,
    start: o.expiry - 30 * 60_000,
    end:   o.expiry,
  };
}

// ── Live data ─────────────────────────────────────────────────────────────────
interface LiveData {
  active:  Oracle[];
  settled: Oracle[];
  forward: number;
  spot:    number;
  svi:     Svi | null;
  history: { t: number; price: number }[];
}
const EMPTY: LiveData = { active: [], settled: [], forward: 0, spot: 0, svi: null, history: [] };

// ── Public interface ──────────────────────────────────────────────────────────
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
  sigmaAtTime: (t: number) => number;
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
  const [live, setLive]   = useState<LiveData>(EMPTY);
  const [now, setNow]     = useState(() => Date.now());
  const [stake, setStake] = useState(10);
  const [focusedEpoch, setFocusedEpoch] = useState('');
  const histFetched = useRef(false);

  // ── Fetch loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function refresh() {
      try {
        const [all, active] = await Promise.all([getOracles(), getActiveLadder()]);
        const settled = all
          .filter(o => o.status === 'settled' && o.underlying_asset === 'BTC')
          .sort((a, b) => b.expiry - a.expiry)
          .slice(0, 4);

        // Use soonest future-expiry oracle for live price; stale ones have no fresh prices.
        const now = Date.now();
        const pricingOracle = active.find(o => o.expiry > now) ?? active[0];
        if (!pricingOracle) { setLive(l => ({ ...l, active, settled })); setNow(Date.now()); return; }

        const [price, svi] = await Promise.all([
          getLatestPrice(pricingOracle.oracle_id),
          getLatestSvi(pricingOracle.oracle_id).catch(() => null),
        ]);

        setLive(prev => ({
          active, settled,
          forward: price.forward, spot: price.spot, svi,
          history: prev.history,
        }));

        if (!histFetched.current) {
          histFetched.current = true;
          getPriceHistory(pricingOracle.oracle_id, HISTORY_LIMIT)
            .then(pts => setLive(l => ({ ...l, history: pts.map(p => ({ t: p.t, price: p.spot })) })))
            .catch(() => {});
        }
      } catch (e) {
        console.warn('[grid] refresh error:', e);
      }
      setNow(Date.now());
    }

    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // ── Epochs ──────────────────────────────────────────────────────────────────
  const epochs = useMemo<Epoch[]>(() => {
    const past = live.settled.map((o, i) => oracleToEpoch(o, -(live.settled.length - i)));
    const curr = live.active.map((o, i) => oracleToEpoch(o, i));
    return [...past, ...curr];
  }, [live.active, live.settled]);

  const currentEpochId = useMemo(() => {
    const n = Date.now();
    return epochs.find(e => e.start <= n && n < e.end)?.id ?? epochs[epochs.length - 1]?.id ?? null;
  }, [epochs]);

  useEffect(() => {
    if (!focusedEpoch && currentEpochId) setFocusedEpoch(currentEpochId);
  }, [focusedEpoch, currentEpochId]);

  // ── Bands ────────────────────────────────────────────────────────────────────
  const { strikes, bands } = useMemo(() => {
    const now = Date.now();
    const nearest = live.active.find(o => o.expiry > now) ?? live.active[0];
    const forward = live.forward || 60_000;
    const tick    = nearest ? nearest.tick_size / 1e9 : 1;
    const tYears  = nearest && nearest.expiry > now
      ? Math.max((nearest.expiry - now) / (365.25 * 24 * 3600e3), 1 / 525_960)
      : 1 / 48;
    const s = computeStrikes(forward, tYears, tick);
    const bs: Band[] = s.slice(0, -1).map((lo, i) => ({ idx: i, lower: lo, upper: s[i + 1]! }));
    return { strikes: s, bands: bs };
  }, [live.forward, live.active]);

  // ── Legs ────────────────────────────────────────────────────────────────────
  const [legs, setLegs] = useState<Map<string, Leg>>(new Map());
  const liveRef  = useRef(live);  liveRef.current  = live;
  const nowRef   = useRef(now);   nowRef.current   = now;
  const stakeRef = useRef(stake); stakeRef.current = stake;

  const hasLeg = useCallback((key: string) => legs.has(key), [legs]);

  const addLeg = useCallback((epoch: Epoch, band: Band) => {
    const key = `${epoch.id}:${band.idx}`;
    setLegs(prev => {
      if (prev.has(key)) return prev;
      const { svi, forward } = liveRef.current;
      const tYears = Math.max((epoch.end - Date.now()) / (365.25 * 24 * 3600e3), 1 / 525_960);
      const prob = rangeProb(svi, forward, band.lower, band.upper, tYears);
      const multiplier = (1 - EDGE) / prob;
      const n = new Map(prev);
      n.set(key, {
        key, epochId: epoch.id, bandIdx: band.idx,
        lower: band.lower, upper: band.upper,
        qty: 1, cost: stakeRef.current, multiplier,
      });
      return n;
    });
  }, []);

  const removeLeg = useCallback((key: string) => setLegs(p => {
    if (!p.has(key)) return p;
    const n = new Map(p); n.delete(key); return n;
  }), []);

  const toggleLeg = useCallback((epoch: Epoch, band: Band) => {
    const key = `${epoch.id}:${band.idx}`;
    if (legs.has(key)) removeLeg(key); else addLeg(epoch, band);
  }, [legs, addLeg, removeLeg]);

  const clearLegs         = useCallback(() => setLegs(new Map()), []);
  const updateLegCost     = useCallback((key: string, cost: number) => setLegs(p => {
    const leg = p.get(key); if (!leg) return p;
    const n = new Map(p); n.set(key, { ...leg, cost: Math.max(0, cost) }); return n;
  }), []);
  const updateAllLegCosts = useCallback((cost: number) => setLegs(p => {
    if (!p.size) return p;
    const n = new Map(p);
    for (const [k, l] of p) n.set(k, { ...l, cost: Math.max(0, cost) });
    return n;
  }), []);

  // ── Cell derivation ─────────────────────────────────────────────────────────
  const cellFor = useCallback((epoch: Epoch, band: Band): GridCell => {
    const { svi, forward, spot, active, settled } = liveRef.current;
    const tNow   = nowRef.current;
    const tYears = Math.max((epoch.end - tNow) / (365.25 * 24 * 3600e3), 1 / 525_960);
    const liveProb   = rangeProb(svi, forward, band.lower, band.upper, tYears);
    const key        = `${epoch.id}:${band.idx}`;
    const leg        = legs.get(key);
    const multiplier = leg ? leg.multiplier : (1 - EDGE) / liveProb;
    const prob       = leg ? (1 - EDGE) / leg.multiplier : liveProb;
    const cost       = Math.round((UNIT_PAYOUT / multiplier) * 100) / 100;

    const isPast    = epoch.end <= tNow;
    const isActive  = epoch.start <= tNow && tNow < epoch.end;
    const px        = spot || forward;
    const inBandNow = px >= band.lower && px < band.upper;

    const oracle   = [...settled, ...active].find(o => o.oracle_id === epoch.oracleId);
    const settlePx = oracle?.settlement_price != null ? oracle.settlement_price / 1e9 : null;

    let state: GridCell['state'] = 'available';
    let uPnl: number | undefined;

    if (isPast && settlePx != null) {
      const winner = settlePx >= band.lower && settlePx < band.upper;
      if (winner && leg) { state = 'claimable'; uPnl = leg.cost * (leg.multiplier - 1); }
      else state = winner ? 'won' : 'lost';
    } else if (isPast) {
      state = 'expired';
    } else if (leg) {
      state = isActive ? 'active' : 'selected';
      if (isActive) uPnl = inBandNow ? leg.cost * (leg.multiplier - 1) : -leg.cost;
    }

    return { epochId: epoch.id, bandIdx: band.idx, lower: band.lower, upper: band.upper, prob, multiplier, cost, state, uPnl };
  }, [legs]);

  const sigmaAtTime = useCallback((t: number) =>
    sigmaForTime(liveRef.current.forward || 60_000, t), []);

  const settleOf = useCallback((epoch: Epoch): number | null => {
    const oracle = [...liveRef.current.settled, ...liveRef.current.active]
      .find(o => o.oracle_id === epoch.oracleId);
    return oracle?.settlement_price != null ? oracle.settlement_price / 1e9 : null;
  }, []);

  const legsArr      = useMemo(() => [...legs.values()], [legs]);
  const payoffPoints = useMemo(() => computePayoff(legsArr), [legsArr]);
  const stats        = useMemo(() => deriveStats(legsArr), [legsArr]);

  return {
    strikes, bands, epochs, now,
    price:   live.spot || live.forward || 0,
    history: live.history,
    currentEpochId, focusedEpoch, setFocusedEpoch,
    cellFor, sigmaAtTime, settleOf,
    legs, hasLeg, toggleLeg, addLeg, removeLeg,
    updateLegCost, updateAllLegCosts, clearLegs,
    legsArr, payoffPoints, stats, stake, setStake,
  };
}
