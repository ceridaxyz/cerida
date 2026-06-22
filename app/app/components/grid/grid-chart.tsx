import { useEffect, useRef, useState, useMemo } from 'react';
import type { GridState } from './use-grid-state';
import type { Band, Epoch } from './types';
import type { WorkerPayload, SerialCell } from './grid-worker';
import { realizedVol } from './analytics';

const PAD_T = 8;
const PAD_B = 22;
const PAD_L = 8;
const PAD_R = 54;

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const EPOCH_MS = 60_000;
const WIN_PAST = 4 * EPOCH_MS;
const CANDLE_MS = 4_500;

const C_BRIGHT = '#19e6bd';

const cellColors = {
  available: { bg: 'rgba(128,125,254,0.05)', border: 'rgba(255,255,255,0.08)', opacity: 1 },
  selected: { bg: 'rgba(128,125,254,0.22)', border: '#807dfe', opacity: 1 },
  active: { bg: 'rgba(11,153,129,0.16)', border: '#0b9981', opacity: 1 },
  won: { bg: 'rgba(11,153,129,0.5)', border: '#0b9981', opacity: 1 },
  claimable: { bg: 'rgba(245,193,66,0.4)', border: '#f5c142', opacity: 1 },
  lost: { bg: 'rgba(242,53,70,0.12)', border: 'rgba(242,53,70,0.35)', opacity: 0.55 },
  expired: { bg: 'rgba(255,255,255,0.02)', border: 'rgba(255,255,255,0.04)', opacity: 0.5 },
} as const;

// Pre-baked lookup tables (identical to the worker — main thread uses them for the
// cells useMemo which feeds hit-testing AND the serialised worker payload).
const HEAT_BUCKETS = 8;
const HEAT_TABLE = (() => {
  const out: { bg: string; border: string }[] = [];
  for (let i = 0; i < HEAT_BUCKETS; i++) {
    const t = i / (HEAT_BUCKETS - 1);
    const a = 0.03 + t * 0.4;
    const r = Math.round(128 + t * 100);
    const g = Math.round(125 + t * 40);
    const b = Math.round(254 - t * 160);
    out.push({ bg: `rgba(${r},${g},${b},${a.toFixed(3)})`, border: `rgba(${r},${g},${b},${(0.12 + t * 0.35).toFixed(3)})` });
  }
  return out;
})();
function heatFill(prob: number) {
  return HEAT_TABLE[Math.round(Math.min(1, prob / 0.45) * (HEAT_BUCKETS - 1))]!;
}
const EDGE_BUCKETS = 8;
const EDGE_TABLE_POS = (() => {
  const out: { bg: string; border: string }[] = [];
  for (let i = 0; i < EDGE_BUCKETS; i++) {
    const t = i / (EDGE_BUCKETS - 1);
    const a = 0.05 + t * 0.45;
    out.push({ bg: `rgba(25,230,189,${a.toFixed(3)})`, border: `rgba(25,230,189,${(0.2 + t * 0.5).toFixed(3)})` });
  }
  return out;
})();
const EDGE_TABLE_NEG = (() => {
  const out: { bg: string; border: string }[] = [];
  for (let i = 0; i < EDGE_BUCKETS; i++) {
    const t = i / (EDGE_BUCKETS - 1);
    const a = 0.05 + t * 0.45;
    out.push({ bg: `rgba(242,53,70,${a.toFixed(3)})`, border: `rgba(242,53,70,${(0.2 + t * 0.5).toFixed(3)})` });
  }
  return out;
})();
function edgeFill(ev: number) {
  const idx = Math.round(Math.min(1, Math.abs(ev) / 3) * (EDGE_BUCKETS - 1));
  return ev >= 0 ? EDGE_TABLE_POS[idx]! : EDGE_TABLE_NEG[idx]!;
}

interface Hover {
  lower: number; upper: number; prob: number; mult: number; cost: number;
  mx: number; my: number; locked: boolean;
}

type ChartStyle = 'line' | 'candles' | 'heikin' | 'area';

interface CellDatum {
  key: string; epoch: Epoch; band: Band; lower: number; upper: number;
  state: keyof typeof cellColors; bg: string; border: string; opacity: number;
  isFuture: boolean; isLive: boolean; isPast: boolean;
  mult: number; ev: number; evColor: string; prob: number; cost: number; uPnl: number | undefined;
}

interface Scale {
  plotW: number; plotH: number;
  winStart: number; winEnd: number; tSpan: number;
  coordMin: number; coordMax: number; coordSpan: number;
}

export default function GridChart({
  s,
  focusedLegKey,
  setFocusedLegKey,
}: {
  s: GridState;
  focusedLegKey: string | null;
  setFocusedLegKey: (key: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Canvas is created programmatically inside the worker-init effect so that
  // transferControlToOffscreen() is always called on a fresh element, which lets
  // React StrictMode safely double-invoke the effect without the "already transferred" error.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const { w, h } = size;

  // Stable dispatch refs — pointer handlers are defined later in the render scope
  // (they need current state), but the actual DOM listeners are attached once and
  // call through these refs so they always see the latest handler.
  const onDownRef = useRef<(e: PointerEvent) => void>(() => {});
  const onMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const onUpRef = useRef<() => void>(() => {});
  const onLeaveRef = useRef<() => void>(() => {});

  // Hover is kept in a ref — tooltip updates imperatively to avoid re-renders on every pointermove.
  const tipRef = useRef<HTMLDivElement>(null);
  const tipRangeEl = useRef<HTMLDivElement>(null);
  const tipProbEl = useRef<HTMLSpanElement>(null);
  const tipMultEl = useRef<HTMLSpanElement>(null);
  const tipCostEl = useRef<HTMLSpanElement>(null);
  const tipLockedEl = useRef<HTMLDivElement>(null);

  const [chartStyle, setChartStyle] = useState<ChartStyle>('line');
  const [cellMode, setCellMode] = useState<'mult' | 'edge'>('mult');
  const isCandle = chartStyle === 'candles' || chartStyle === 'heikin';

  const [visBands, setVisBands] = useState(14);
  const [yOffset, setYOffset] = useState(0);
  const [winFuture, setWinFuture] = useState(6 * EPOCH_MS);
  const [xOffset, setXOffset] = useState(0);

  const dragging = useRef(false);
  const dragMode = useRef<'add' | 'remove'>('add');
  const workerRef = useRef<Worker | null>(null);

  // ── animations (DOM overlay) ───────────────────────────────────────────────
  const activatedRef = useRef<Set<string>>(new Set());
  const eruptingBandsRef = useRef<Set<string>>(new Set());
  const animFrozenPos = useRef<Map<string, { left: number; top: number; width: number; height: number }>>(new Map());
  const [poppingKeys, setPoppingKeys] = useState<Map<string, { text: string }>>(new Map());
  const [eruptingWinKeys, setEruptingWinKeys] = useState<Set<string>>(new Set());
  const isFirstRender = useRef(true);

  // ── resize ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── wheel zoom ───────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        setWinFuture((p) => Math.max(2 * EPOCH_MS, Math.min(15 * EPOCH_MS, p + (e.deltaY > 0 ? EPOCH_MS : -EPOCH_MS))));
      } else {
        setVisBands((p) => Math.max(6, Math.min(22, p + (e.deltaY > 0 ? 1 : -1))));
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // ── header analytics ──────────────────────────────────────────────────────
  const horizonSig = s.sigmaAtTime(s.now + EPOCH_MS);
  const ivPct = (horizonSig / s.price) * Math.sqrt(SECONDS_PER_YEAR / 60) * 100;
  const rvPct = realizedVol(s.history);
  const ivRv = rvPct > 0 ? ivPct / rvPct : 0;
  const rich = ivRv >= 1.1 ? 'RICH' : ivRv > 0 && ivRv <= 0.9 ? 'CHEAP' : 'FAIR';

  // ── strike → uniform band coordinate ─────────────────────────────────────
  const lastStrike = s.strikes.length - 1;
  const strikeStep = (s.strikes[1] ?? 0) - (s.strikes[0] ?? 0) || 1;
  const bandCoordOf = useMemo(() => {
    const strikes = s.strikes;
    return (price: number): number => {
      if (price <= strikes[0]!) return (price - strikes[0]!) / ((strikes[1]! - strikes[0]!) || 1);
      if (price >= strikes[lastStrike]!) return lastStrike + (price - strikes[lastStrike]!) / ((strikes[lastStrike]! - strikes[lastStrike - 1]!) || 1);
      for (let i = 0; i < lastStrike; i++) {
        const lo = strikes[i]!, hi = strikes[i + 1]!;
        if (price < hi) return i + (price - lo) / (hi - lo);
      }
      return lastStrike;
    };
  }, [s.strikes, lastStrike]);

  // ── per-cell content (data cadence; also used for hit-testing) ────────────
  const cells = useMemo<CellDatum[]>(() => {
    const center = bandCoordOf(s.price);
    const coordMin = center - visBands / 2 + yOffset - 2;
    const coordMax = center + visBands / 2 + yOffset + 2;
    const winStart = s.now - WIN_PAST + xOffset - EPOCH_MS;
    const winEnd = s.now + winFuture + xOffset + EPOCH_MS;
    const bandsVis = s.bands.filter((b) => b.idx >= coordMin && b.idx <= coordMax);
    const epochsVis = s.epochs.filter((e) => e.end >= winStart && e.start <= winEnd);
    const out: CellDatum[] = [];
    for (const epoch of epochsVis) {
      const isPast = epoch.end <= s.now;
      const isFuture = epoch.start > s.now;
      const isLive = !isPast && !isFuture;
      for (const band of bandsVis) {
        const cell = s.cellFor(epoch, band);
        const base = cellColors[cell.state];
        let ev = 0;
        let bg: string = base.bg, border: string = base.border;
        if (cell.state === 'available') {
          const mid = (band.lower + band.upper) / 2;
          const closeness = Math.exp(-0.5 * ((mid - s.price) / (3 * strikeStep)) ** 2);
          const yourProb = Math.max(0, Math.min(1, cell.prob * (1 + 0.18 * (2 * closeness - 1))));
          ev = yourProb * cell.cost * cell.multiplier - cell.cost;
          const f = cellMode === 'edge' ? edgeFill(ev) : heatFill(cell.prob);
          bg = f.bg; border = f.border;
        }
        out.push({
          key: `${epoch.id}:${band.idx}`, epoch, band, lower: band.lower, upper: band.upper,
          state: cell.state, bg, border, opacity: base.opacity,
          isFuture, isLive, isPast, mult: cell.multiplier, ev,
          evColor: ev >= 0 ? C_BRIGHT : '#f23546', prob: cell.prob, cost: cell.cost, uPnl: cell.uPnl,
        });
      }
    }
    return out;
  }, [s, bandCoordOf, strikeStep, visBands, yOffset, winFuture, xOffset, cellMode]);

  // ── candles (data cadence) ────────────────────────────────────────────────
  const candles = useMemo(() => {
    if (!isCandle) return [];
    const buckets = new Map<number, { o: number; h: number; l: number; c: number; t: number }>();
    for (const p of s.history) {
      const b = Math.floor(p.t / CANDLE_MS) * CANDLE_MS;
      const cur = buckets.get(b);
      if (!cur) buckets.set(b, { o: p.price, h: p.price, l: p.price, c: p.price, t: b });
      else { cur.h = Math.max(cur.h, p.price); cur.l = Math.min(cur.l, p.price); cur.c = p.price; }
    }
    const raw = [...buckets.values()].sort((x, y) => x.t - y.t);
    if (chartStyle === 'candles') return raw;
    const ha: typeof raw = [];
    let pO: number | undefined, pC: number | undefined;
    for (const r of raw) {
      const close = (r.o + r.h + r.l + r.c) / 4;
      const open = pO === undefined ? (r.o + r.c) / 2 : (pO + pC!) / 2;
      ha.push({ o: open, c: close, h: Math.max(r.h, open, close), l: Math.min(r.l, open, close), t: r.t });
      pO = open; pC = close;
    }
    return ha;
  }, [s.history, isCandle, chartStyle]);

  // ── skip set (keys rendered by DOM overlay, not canvas) ───────────────────
  const skip = useMemo(() => {
    const set = new Set<string>(eruptingWinKeys);
    for (const k of poppingKeys.keys()) set.add(k);
    return set;
  }, [eruptingWinKeys, poppingKeys]);

  // ── scale helper (for hit-testing; worker has its own copy) ───────────────
  const computeScale = (displayPrice: number, liveNow: number): Scale => {
    const plotW = Math.max(1, w - PAD_L - PAD_R);
    const plotH = Math.max(1, h - PAD_T - PAD_B);
    const center = bandCoordOf(displayPrice);
    const coordMin = center - visBands / 2 + yOffset;
    const coordMax = center + visBands / 2 + yOffset;
    const winStart = liveNow - WIN_PAST + xOffset;
    const winEnd = liveNow + winFuture + xOffset;
    return { plotW, plotH, winStart, winEnd, tSpan: (winEnd - winStart) || 1, coordMin, coordMax, coordSpan: (coordMax - coordMin) || 1 };
  };

  // ── worker: init on mount ────────────────────────────────────────────────
  // Canvas is created here (not in JSX) so every effect invocation gets a brand-new
  // HTMLCanvasElement. This means transferControlToOffscreen() always succeeds even when
  // React StrictMode runs the effect twice (mount → cleanup → mount).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;position:absolute;top:0;left:0;width:100%;height:100%;';
    container.appendChild(canvas);
    canvasRef.current = canvas;

    const offscreen = canvas.transferControlToOffscreen();
    const worker = new Worker(new URL('./grid-worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.postMessage({ type: 'init', canvas: offscreen, initialPrice: s.price }, [offscreen]);

    // Stable listeners dispatch to refs so they always call the latest handler.
    const dn = (e: PointerEvent) => onDownRef.current(e);
    const mv = (e: PointerEvent) => onMoveRef.current(e);
    const up = () => onUpRef.current();
    const lv = () => onLeaveRef.current();
    canvas.addEventListener('pointerdown', dn);
    canvas.addEventListener('pointermove', mv);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', lv);

    return () => {
      worker.terminate();
      workerRef.current = null;
      canvas.remove();
      canvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── worker: post updated data whenever state that affects drawing changes ──
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;

    // Pre-sample sigma for the expected-move cone (24 points across the future window).
    const now = Date.now();
    const futureEnd = now + winFuture + xOffset;
    const sigmaPoints: WorkerPayload['sigmaPoints'] = Array.from({ length: 24 }, (_, i) => {
      const t = now + ((futureEnd - now) * i) / 23;
      return { t, sigma: s.sigmaAtTime(t) };
    });

    const serialCells: SerialCell[] = cells.map((c) => ({
      key: c.key,
      epochStart: c.epoch.start, epochEnd: c.epoch.end,
      bandLower: c.band.lower, bandUpper: c.band.upper,
      bg: c.bg, border: c.border, opacity: c.opacity,
      isLive: c.isLive, state: c.state,
      mult: c.mult, ev: c.ev, evColor: c.evColor,
      uPnl: c.uPnl,
      legCost: c.state === 'selected' ? (s.legs.get(c.key)?.cost ?? s.stake) : undefined,
    }));

    const payload: WorkerPayload = {
      price: s.price, w, h, dpr: window.devicePixelRatio || 1,
      chartStyle, cellMode, visBands, yOffset, winFuture, xOffset,
      focusedLegKey,
      strikes: s.strikes,
      epochs: s.epochs.map((e) => ({ id: e.id, start: e.start, end: e.end })),
      currentEpochId: s.currentEpochId,
      cells: serialCells,
      history: s.history,
      candles,
      skip: [...skip],
      sigmaPoints,
    };

    worker.postMessage({ type: 'data', payload });
  // s.sigmaAtTime is called inside but s is in deps via cells; s.history for sigma accuracy.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, candles, s.price, s.history, w, h, visBands, yOffset, winFuture, xOffset,
      chartStyle, cellMode, focusedLegKey, skip, s.currentEpochId]);

  // ── settlement / leg animations (DOM overlay) ─────────────────────────────
  useEffect(() => {
    const now = s.now;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      for (const epoch of s.epochs) {
        if (epoch.start <= now)
          for (const [key, leg] of s.legs) if (leg.epochId === epoch.id) activatedRef.current.add(key);
        if (epoch.end <= now) eruptingBandsRef.current.add(`epoch:${epoch.id}`);
      }
      return;
    }

    const freeze = (epoch: Epoch, band: Band, key: string) => {
      const sc = computeScale(s.price, Date.now());
      const xOf = (t: number) => PAD_L + ((t - sc.winStart) / sc.tSpan) * sc.plotW;
      const yOf = (p: number) => PAD_T + ((sc.coordMax - bandCoordOf(p)) / sc.coordSpan) * sc.plotH;
      animFrozenPos.current.set(key, {
        left: xOf(epoch.start) + 1, top: yOf(band.upper) + 1,
        width: Math.max(0, xOf(epoch.end) - xOf(epoch.start) - 2),
        height: Math.max(0, yOf(band.lower) - yOf(band.upper) - 2),
      });
    };

    for (const [key, leg] of s.legs) {
      if (activatedRef.current.has(key)) continue;
      const epoch = s.epochs.find((e) => e.id === leg.epochId);
      if (!epoch || epoch.start > now) continue;
      const band = s.bands.find((b) => b.idx === leg.bandIdx);
      if (!band) continue;
      activatedRef.current.add(key);
      freeze(epoch, band, key);
      setPoppingKeys((p) => { const c = new Map(p); c.set(key, { text: `${leg.multiplier.toFixed(2)}x` }); return c; });
      setTimeout(() => setPoppingKeys((p) => { const c = new Map(p); c.delete(key); return c; }), 950);
    }

    for (const epoch of s.epochs) {
      if (epoch.end > now) continue;
      const epochKey = `epoch:${epoch.id}`;
      if (eruptingBandsRef.current.has(epochKey)) continue;
      const settle = s.settleOf(epoch);
      if (settle === null) continue;
      const winBand = s.bands.find((b) => settle >= b.lower && settle < b.upper);
      if (!winBand) continue;
      eruptingBandsRef.current.add(epochKey);
      const winKey = `${epoch.id}:${winBand.idx}`;
      freeze(epoch, winBand, winKey);
      setEruptingWinKeys((p) => new Set([...p, winKey]));
      setTimeout(() => setEruptingWinKeys((p) => { const n = new Set(p); n.delete(winKey); return n; }), 2000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.now, s.epochs, s.bands, s.legs, s]);

  // ── pointer interaction (hit-test against computed scale) ─────────────────
  const cellAt = (mx: number, my: number) => {
    if (mx < PAD_L || mx > w - PAD_R || my < PAD_T || my > h - PAD_B) return null;
    const sc = computeScale(s.price, Date.now());
    const t = sc.winStart + ((mx - PAD_L) / sc.plotW) * sc.tSpan;
    const epoch = s.epochs.find((e) => t >= e.start && t < e.end);
    const coord = sc.coordMax - ((my - PAD_T) / sc.plotH) * sc.coordSpan;
    const band = s.bands.find((b) => b.idx === Math.floor(coord));
    return epoch && band ? { epoch, band } : null;
  };

  const localXY = (e: PointerEvent) => {
    const r = containerRef.current!.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top };
  };

  const onPointerDown = (e: PointerEvent) => {
    const { mx, my } = localXY(e);
    const hit = cellAt(mx, my);
    if (!hit || hit.epoch.start <= s.now) return;
    dragging.current = true;
    const key = `${hit.epoch.id}:${hit.band.idx}`;
    const isAdding = !s.hasLeg(key);
    dragMode.current = isAdding ? 'add' : 'remove';
    s.toggleLeg(hit.epoch, hit.band);
    s.setFocusedEpoch(hit.epoch.id);
    if (isAdding) setFocusedLegKey(key);
    else if (focusedLegKey === key) setFocusedLegKey(null);
  };

  const showTip = (h: Hover) => {
    const tip = tipRef.current;
    if (!tip) return;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(h.mx + 14, w - 180)}px`;
    tip.style.top = `${h.my > (size.h - 110) ? h.my - 100 : h.my + 14}px`;
    if (tipRangeEl.current) tipRangeEl.current.textContent = `$${h.lower.toLocaleString()} – $${h.upper.toLocaleString()}`;
    if (tipProbEl.current) tipProbEl.current.textContent = `${(h.prob * 100).toFixed(0)}%`;
    if (tipMultEl.current) tipMultEl.current.textContent = `${h.mult.toFixed(2)}x`;
    if (tipCostEl.current) tipCostEl.current.textContent = `$${h.cost.toFixed(2)}`;
    if (tipLockedEl.current) tipLockedEl.current.style.display = h.locked ? 'flex' : 'none';
  };
  const hideTip = () => { if (tipRef.current) tipRef.current.style.display = 'none'; };

  const onPointerMove = (e: PointerEvent) => {
    const { mx, my } = localXY(e);
    const hit = cellAt(mx, my);
    if (!hit) { hideTip(); return; }
    const key = `${hit.epoch.id}:${hit.band.idx}`;
    if (dragging.current && hit.epoch.start > s.now) {
      if (dragMode.current === 'add' && !s.hasLeg(key)) { s.addLeg(hit.epoch, hit.band); setFocusedLegKey(key); }
      if (dragMode.current === 'remove' && s.hasLeg(key)) { s.removeLeg(key); if (focusedLegKey === key) setFocusedLegKey(null); }
    }
    const cell = s.cellFor(hit.epoch, hit.band);
    showTip({ lower: hit.band.lower, upper: hit.band.upper, prob: cell.prob, mult: cell.multiplier,
      cost: cell.cost, mx, my, locked: hit.epoch.start <= s.now && hit.epoch.end > s.now });
  };
  const onPointerUp = () => { dragging.current = false; };
  const onPointerLeave = () => { dragging.current = false; hideTip(); };

  // Keep dispatch refs current every render so the stable listeners always call
  // the latest handler (which closes over current s, focusedLegKey, etc.).
  onDownRef.current = onPointerDown;
  onMoveRef.current = onPointerMove;
  onUpRef.current = onPointerUp;
  onLeaveRef.current = onPointerLeave;

  const overlayCells = useMemo(() => {
    const items: { key: string; text?: string; pop: boolean }[] = [];
    for (const [key, info] of poppingKeys) items.push({ key, text: info.text, pop: true });
    for (const key of eruptingWinKeys) items.push({ key, pop: false });
    return items;
  }, [poppingKeys, eruptingWinKeys]);

  return (
    <div className="flex flex-col h-full w-full">
      <style>{`
        @keyframes gridWinErupt{0%{transform:scale(1);box-shadow:0 0 0 0 rgba(11,153,129,0);background:rgba(11,153,129,0.16);border-color:#0b9981}10%{transform:scale(1.06);box-shadow:0 0 0 6px rgba(11,153,129,0.5),0 0 50px 12px rgba(11,153,129,0.55),inset 0 0 20px rgba(25,230,189,0.3);background:rgba(25,230,189,0.85);border-color:#19e6bd}28%{transform:scale(1.03);background:rgba(11,153,129,0.75)}65%{transform:scale(1.01);background:rgba(11,153,129,0.6)}100%{transform:scale(1);box-shadow:0 0 6px 1px rgba(11,153,129,0.12);background:rgba(11,153,129,0.5);border-color:#0b9981}}
        .animate-win-erupt{animation:gridWinErupt 1.8s cubic-bezier(0.16,1,0.3,1) forwards;z-index:30}
        @keyframes gridPop{0%{transform:scale(1)}32%{transform:scale(1.13);box-shadow:0 0 0 5px rgba(11,153,129,0.45),0 0 34px 9px rgba(11,153,129,0.5),inset 0 0 16px rgba(25,230,189,0.25)}62%{transform:scale(0.99)}100%{transform:scale(1);box-shadow:0 0 9px 1px rgba(11,153,129,0.22)}}
        .animate-pop{animation:gridPop 0.7s cubic-bezier(0.16,1,0.3,1) forwards}
        @keyframes gridTextFall{0%{transform:translate3d(0,0,0) rotate(0deg);opacity:1;filter:blur(0)}14%{transform:translate3d(0,-6px,0) rotate(-3deg)}100%{transform:translate3d(0,46px,0) rotate(14deg);opacity:0;filter:blur(1px)}}
        .animate-text-fall{animation:gridTextFall 0.9s cubic-bezier(0.22,0.72,0.16,1) forwards;transform-origin:50% 50%}
      `}</style>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-border-subtle">
        <div className="flex items-center rounded-[5px] p-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          {(['mult', 'edge'] as const).map((m) => (
            <button key={m} onClick={() => setCellMode(m)} className="px-2 py-0.5 rounded-[4px] text-[10px] font-medium transition-colors"
              style={{ background: cellMode === m ? 'rgba(128,125,254,0.2)' : 'transparent', color: cellMode === m ? '#a6a3ff' : 'var(--color-text-quaternary)' }}>
              {m === 'mult' ? 'Payoff' : 'Edge'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-[5px] p-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <button onClick={() => setVisBands((b) => Math.max(6, b - 1))} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[11px] font-bold" title="Zoom in">+</button>
          <button onClick={() => setVisBands((b) => Math.min(22, b + 1))} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[11px] font-bold" title="Zoom out">−</button>
          <button onClick={() => setYOffset((y) => y + 1)} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[9px]" title="Pan up">▲</button>
          <button onClick={() => setYOffset((y) => y - 1)} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[9px]" title="Pan down">▼</button>
          <button onClick={() => setXOffset((x) => x - 15_000)} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[9px]" title="Pan left">◀</button>
          <button onClick={() => setXOffset((x) => x + 15_000)} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[9px]" title="Pan right">▶</button>
        </div>
        {(yOffset !== 0 || xOffset !== 0 || visBands !== 14 || winFuture !== 6 * EPOCH_MS) && (
          <button onClick={() => { setYOffset(0); setXOffset(0); setVisBands(14); setWinFuture(6 * EPOCH_MS); }}
            className="text-[10px] text-text-quaternary hover:text-text-tertiary transition-colors">Reset</button>
        )}
        <span className="text-[10px] text-text-quaternary ml-1" style={{ fontFamily: 'var(--font-mono)' }}>
          IV {ivPct.toFixed(0)}%
          {rich !== 'FAIR' && <span style={{ color: rich === 'RICH' ? '#f23546' : '#19e6bd' }}> · {rich}</span>}
        </span>
        <div className="flex items-center rounded-[5px] p-0.5 ml-auto" style={{ background: 'rgba(255,255,255,0.04)' }}>
          {(['line', 'candles', 'heikin', 'area'] as const).map((style) => (
            <button key={style} onClick={() => setChartStyle(style)} className="px-2 py-0.5 rounded-[4px] text-[10px] font-medium transition-colors"
              style={{ background: chartStyle === style ? 'rgba(128,125,254,0.2)' : 'transparent', color: chartStyle === style ? '#a6a3ff' : 'var(--color-text-quaternary)' }}>
              {style === 'line' ? 'Line' : style === 'candles' ? 'Candle' : style === 'heikin' ? 'HA' : 'Area'}
            </button>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden select-none">

        {/* DOM animation overlay — only cells mid-animation */}
        {overlayCells.map(({ key, text, pop }) => {
          const pos = animFrozenPos.current.get(key);
          if (!pos) return null;
          if (pop) {
            return (
              <div key={key} className="absolute flex items-center justify-center pointer-events-none animate-pop overflow-hidden"
                style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height,
                  background: 'rgba(11,153,129,0.16)', border: '1px solid #0b9981', borderRadius: 4, zIndex: 50 }}>
                <span className="animate-text-fall"
                  style={{ color: '#19e6bd', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 }}>
                  {text}
                </span>
              </div>
            );
          }
          return (
            <div key={key} className="absolute pointer-events-none animate-win-erupt"
              style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height,
                background: 'rgba(11,153,129,0.5)', border: '1px solid #0b9981', borderRadius: 4, zIndex: 30 }} />
          );
        })}

        {/* Hover tooltip — always mounted, shown/hidden imperatively */}
        <div ref={tipRef} className="absolute z-20 pointer-events-none rounded-xl border border-white/10 bg-[#0a0c16]/85 backdrop-blur-md px-3.5 py-2 shadow-2xl"
          style={{ display: 'none' }}>
          <div ref={tipRangeEl} className="text-[11px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }} />
          <div className="flex items-center gap-3 mt-1.5 text-[10px]" style={{ fontFamily: 'var(--font-mono)' }}>
            <span className="text-text-tertiary flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-violet" />
              <span ref={tipProbEl} />
            </span>
            <span ref={tipMultEl} className="text-bullish-green font-bold" />
            <span ref={tipCostEl} className="text-text-secondary" />
          </div>
          <div ref={tipLockedEl} className="items-center gap-1 mt-1.5 text-[9px] font-semibold uppercase tracking-wider"
            style={{ color: '#a6a3ff', display: 'none' }}>
            Live · Betting closed
          </div>
        </div>
      </div>
    </div>
  );
}
