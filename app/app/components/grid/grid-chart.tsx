import { useEffect, useRef, useState, useMemo } from 'react';
import type { GridState } from './use-grid-state';
import type { Band, Epoch } from './types';
import { realizedVol } from './analytics';

const PAD_T = 8;
const PAD_B = 22;
const PAD_L = 8;
const PAD_R = 54;

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const EPOCH_MS = 60_000;
const WIN_PAST = 4 * EPOCH_MS;
const CANDLE_MS = 4_500;

// Theme literals (canvas needs concrete colors, not CSS vars).
const C = {
  tertiary: '#b0b5bd',
  quaternary: '#8e939b',
  primary: '#ffffff',
  accent: '#a5a3ff',
  violet: '#807dfe',
  green: '#0b9981',
  greenBright: '#19e6bd',
  red: '#f23546',
  gold: '#f5c142',
};

function fmtTime(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const cellColors = {
  available: { bg: 'rgba(128,125,254,0.05)', border: 'rgba(255,255,255,0.08)', opacity: 1 },
  selected: { bg: 'rgba(128,125,254,0.22)', border: '#807dfe', opacity: 1 },
  active: { bg: 'rgba(11,153,129,0.16)', border: '#0b9981', opacity: 1 },
  won: { bg: 'rgba(11,153,129,0.5)', border: '#0b9981', opacity: 1 },
  claimable: { bg: 'rgba(245,193,66,0.4)', border: '#f5c142', opacity: 1 },
  lost: { bg: 'rgba(242,53,70,0.12)', border: 'rgba(242,53,70,0.35)', opacity: 0.55 },
  expired: { bg: 'rgba(255,255,255,0.02)', border: 'rgba(255,255,255,0.04)', opacity: 0.5 },
} as const;

// Pre-baked into 8 discrete buckets so Path2D batching collapses ~100 unique
// fill colors down to 8. Visual difference vs continuous is imperceptible.
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
  const idx = Math.round(Math.min(1, prob / 0.45) * (HEAT_BUCKETS - 1));
  return HEAT_TABLE[idx]!;
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

// Mutable view snapshot the rAF loop reads without re-subscribing.
interface View {
  s: GridState; w: number; h: number;
  chartStyle: ChartStyle; cellMode: 'mult' | 'edge'; showIso: boolean;
  visBands: number; yOffset: number; winFuture: number; xOffset: number;
  cells: CellDatum[];
  candles: { o: number; h: number; l: number; c: number; t: number }[];
  skip: Set<string>; // keys drawn by the DOM overlay instead
  focusedLegKey: string | null;
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const { w, h } = size;

  // Hover is kept in a ref — tooltip updates imperatively to avoid re-renders on every pointermove.
  const hoverRef = useRef<Hover | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipRangeEl = useRef<HTMLDivElement>(null);
  const tipProbEl = useRef<HTMLSpanElement>(null);
  const tipMultEl = useRef<HTMLSpanElement>(null);
  const tipCostEl = useRef<HTMLSpanElement>(null);
  const tipLockedEl = useRef<HTMLDivElement>(null);

  const [chartStyle, setChartStyle] = useState<ChartStyle>('line');
  const [cellMode, setCellMode] = useState<'mult' | 'edge'>('mult');
  const [showIso] = useState(false);
  const isCandle = chartStyle === 'candles' || chartStyle === 'heikin';

  const [visBands, setVisBands] = useState(14);
  const [yOffset, setYOffset] = useState(0);
  const [winFuture, setWinFuture] = useState(6 * EPOCH_MS);
  const [xOffset, setXOffset] = useState(0);

  const dragging = useRef(false);
  const dragMode = useRef<'add' | 'remove'>('add');

  // ── animations (kept as DOM overlay) ──────────────────────────────────────
  const activatedRef = useRef<Set<string>>(new Set());
  const eruptingBandsRef = useRef<Set<string>>(new Set());
  const animFrozenPos = useRef<Map<string, { left: number; top: number; width: number; height: number }>>(new Map());
  // Selected boxes whose epoch just went live → box pops, text falls out.
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

  // ── wheel zoom ──────────────────────────────────────────────────────────────
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

  // ── strike → uniform band coordinate ──────────────────────────────────────
  const lastStrike = s.strikes.length - 1;
  const strikeStep = (s.strikes[1] ?? 0) - (s.strikes[0] ?? 0) || 1;
  const bandCoordOf = useMemo(() => {
    const strikes = s.strikes;
    return (price: number): number => {
      if (price <= strikes[0]!) return (price - strikes[0]!) / ((strikes[1]! - strikes[0]!) || 1);
      if (price >= strikes[lastStrike]!) return lastStrike + (price - strikes[lastStrike]!) / ((strikes[lastStrike]! - strikes[lastStrike - 1]!) || 1);
      for (let i = 0; i < lastStrike; i++) {
        const lo = strikes[i]!; const hi = strikes[i + 1]!;
        if (price < hi) return i + (price - lo) / (hi - lo);
      }
      return lastStrike;
    };
  }, [s.strikes, lastStrike]);

  // ── per-cell content (data cadence, not per-frame) ────────────────────────
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
        let bg: string = base.bg;
        let border: string = base.border;
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
          evColor: ev >= 0 ? C.greenBright : C.red, prob: cell.prob, cost: cell.cost, uPnl: cell.uPnl,
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

  // ── view snapshot + scale ref for the loop & hit-testing ──────────────────
  const skip = useMemo(() => {
    const set = new Set<string>(eruptingWinKeys);
    for (const k of poppingKeys.keys()) set.add(k);
    return set;
  }, [eruptingWinKeys, poppingKeys]);

  const viewRef = useRef<View>(null as unknown as View);
  viewRef.current = { s, w, h, chartStyle, cellMode, showIso, visBands, yOffset, winFuture, xOffset, cells, candles, skip, focusedLegKey };
  const scaleRef = useRef<Scale | null>(null);
  const displayPriceRef = useRef(s.price);
  // Cached 2d context — avoids getContext() on every rAF frame.
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  // Pre-filtered history window updated on data tick, not per-frame.
  const histWindowRef = useRef<typeof s.history>([]);

  const computeScale = (v: View, displayPrice: number, liveNow: number): Scale => {
    const plotW = Math.max(1, v.w - PAD_L - PAD_R);
    const plotH = Math.max(1, v.h - PAD_T - PAD_B);
    const center = bandCoordOf(displayPrice);
    const coordMin = center - v.visBands / 2 + v.yOffset;
    const coordMax = center + v.visBands / 2 + v.yOffset;
    const winStart = liveNow - WIN_PAST + v.xOffset;
    const winEnd = liveNow + v.winFuture + v.xOffset;
    return { plotW, plotH, winStart, winEnd, tSpan: winEnd - winStart, coordMin, coordMax, coordSpan: (coordMax - coordMin) || 1 };
  };

  // ── render loop ───────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const draw = (ts: number) => {
      const v = viewRef.current;
      const canvas = canvasRef.current;
      const dt = ts - last; last = ts;
      if (!canvas || v.w < 2 || v.h < 2) { raf = requestAnimationFrame(draw); return; }

      // ease displayed price toward the live target
      displayPriceRef.current += (v.s.price - displayPriceRef.current) * Math.min(1, dt / 120);
      const price = displayPriceRef.current;
      const liveNow = Date.now();

      const sc = computeScale(v, price, liveNow);
      scaleRef.current = sc;

      const dpr = window.devicePixelRatio || 1;
      const needsResize = canvas.width !== Math.round(v.w * dpr) || canvas.height !== Math.round(v.h * dpr);
      if (needsResize) {
        canvas.width = Math.round(v.w * dpr);
        canvas.height = Math.round(v.h * dpr);
        ctxRef.current = null; // context survives resize but reset just in case
      }
      if (!ctxRef.current) ctxRef.current = canvas.getContext('2d')!;
      const ctx = ctxRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, v.w, v.h);

      const xOf = (t: number) => PAD_L + ((t - sc.winStart) / sc.tSpan) * sc.plotW;
      const yOf = (p: number) => PAD_T + ((sc.coordMax - bandCoordOf(p)) / sc.coordSpan) * sc.plotH;
      const nowX = xOf(liveNow);
      const priceY = yOf(price);

      // gridlines — batched into 2 draw calls instead of N
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      for (const st of v.s.strikes) {
        const y = yOf(st);
        if (y < PAD_T - 2 || y > v.h - PAD_B + 2) continue;
        ctx.moveTo(PAD_L, y); ctx.lineTo(v.w - PAD_R, y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath();
      for (const e of v.s.epochs) {
        const x = xOf(e.start);
        if (x < PAD_L - 2 || x > v.w - PAD_R + 2) continue;
        ctx.moveTo(x, PAD_T); ctx.lineTo(x, v.h - PAD_B);
      }
      ctx.stroke();

      // expected-move cone (±1σ)
      if (sc.winEnd > liveNow) {
        const steps = 16;
        const startT = Math.max(liveNow, sc.winStart);
        const up: [number, number][] = [];
        const lo: [number, number][] = [];
        for (let i = 0; i <= steps; i++) {
          const t = startT + ((sc.winEnd - startT) * i) / steps;
          const sig = v.s.sigmaAtTime(t);
          up.push([xOf(t), yOf(price + sig)]);
          lo.push([xOf(t), yOf(price - sig)]);
        }
        ctx.beginPath();
        ctx.moveTo(up[0]![0], up[0]![1]);
        for (const [x, y] of up) ctx.lineTo(x, y);
        for (let i = lo.length - 1; i >= 0; i--) ctx.lineTo(lo[i]![0], lo[i]![1]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(128,125,254,0.07)';
        ctx.fill();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(128,125,254,0.3)';
        for (const arr of [up, lo]) {
          ctx.beginPath();
          ctx.moveTo(arr[0]![0], arr[0]![1]);
          for (const [x, y] of arr) ctx.lineTo(x, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // cells — Phase 1: batch fills + strokes by color to minimize canvas state changes.
      // Instead of N×(fillStyle+fill+strokeStyle+stroke) we do K×(fill+stroke) where K
      // is the number of unique color buckets (~15-20) vs N visible cells (~100-160).
      type BatchEntry = { fillPath: Path2D; strokePath: Path2D; opacity: number; strokeW: number };
      const batches = new Map<string, BatchEntry>();
      type GeomEntry = { c: CellDatum; left: number; top: number; cw: number; ch: number };
      const geomList: GeomEntry[] = [];

      for (const c of v.cells) {
        if (v.skip.has(c.key)) continue;
        const left = xOf(c.epoch.start) + 1;
        const top = yOf(c.band.upper) + 1;
        const cw = xOf(c.epoch.end) - xOf(c.epoch.start) - 2;
        const ch = yOf(c.band.lower) - yOf(c.band.upper) - 2;
        if (cw <= 0 || ch <= 0) continue;
        if (left > v.w - PAD_R || left + cw < PAD_L || top > v.h - PAD_B || top + ch < PAD_T) continue;

        const isFocused = v.focusedLegKey === c.key;
        const sw = isFocused ? 2 : 1;
        const border = isFocused ? '#807dfe' : c.border;
        const bk = `${c.bg}|${border}|${c.opacity}|${sw}`;
        let b = batches.get(bk);
        if (!b) { b = { fillPath: new Path2D(), strokePath: new Path2D(), opacity: c.opacity, strokeW: sw }; batches.set(bk, b); }
        pathRoundRect(b.fillPath, left, top, cw, ch, 4);
        pathRoundRect(b.strokePath, left, top, cw, ch, 4);
        geomList.push({ c, left, top, cw, ch });
      }

      for (const [bk, b] of batches) {
        const pipe = bk.indexOf('|');
        ctx.globalAlpha = b.opacity;
        ctx.fillStyle = bk.slice(0, pipe);
        ctx.fill(b.fillPath);
      }
      for (const [bk, b] of batches) {
        const p1 = bk.indexOf('|'); const p2 = bk.indexOf('|', p1 + 1);
        ctx.globalAlpha = b.opacity;
        ctx.lineWidth = b.strokeW;
        ctx.strokeStyle = bk.slice(p1 + 1, p2);
        ctx.stroke(b.strokePath);
      }
      ctx.globalAlpha = 1;

      // cells — Phase 2: text labels (can't batch; only big non-live cells need them).
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const { c, left, top, cw, ch } of geomList) {
        const big = cw > 46 && ch > 22;
        if (!big || c.isLive) continue;
        const fs = Math.max(10, Math.min(16, Math.min(cw * 0.155, ch * 0.65)));
        const cx = left + cw / 2;
        const cy = top + ch / 2;

        if (c.state === 'available') {
          ctx.font = `600 ${fs}px 'Berkeley Mono', monospace`;
          if (v.cellMode === 'edge') {
            ctx.fillStyle = c.evColor;
            ctx.fillText(`${c.ev >= 0 ? '+' : '−'}$${Math.abs(c.ev).toFixed(1)}`, cx, cy);
          } else {
            ctx.fillStyle = C.tertiary;
            ctx.fillText(`${c.mult.toFixed(2)}x`, cx, cy);
          }
        } else if (c.state === 'selected') {
          ctx.font = `700 ${fs}px 'Berkeley Mono', monospace`;
          ctx.fillStyle = C.primary;
          ctx.fillText(`${c.mult.toFixed(2)}x`, cx, cy - fs * 0.5);
          ctx.font = `400 ${Math.max(9, fs * 0.82)}px 'Berkeley Mono', monospace`;
          ctx.fillStyle = C.accent;
          const leg = v.s.legs.get(c.key);
          const legCost = leg ? leg.cost : v.s.stake;
          ctx.fillText(`$${legCost.toFixed(0)} → $${(legCost * c.mult).toFixed(0)}`, cx, cy + fs * 0.55);
        } else if (c.state === 'active') {
          ctx.font = `700 ${fs}px 'Berkeley Mono', monospace`;
          ctx.fillStyle = (c.uPnl ?? 0) >= 0 ? C.green : C.red;
          ctx.fillText(`${(c.uPnl ?? 0) >= 0 ? '+$' : '−$'}${Math.abs(c.uPnl ?? 0).toFixed(2)}`, cx, cy);
        } else if (c.state === 'claimable') {
          const sub = Math.max(9, fs * 0.82);
          ctx.fillStyle = C.gold;
          ctx.font = `700 ${sub}px 'Berkeley Mono', monospace`;
          ctx.fillText('CLAIM', cx, cy - sub * 0.6);
          ctx.fillText(`+$${(c.uPnl ?? 0).toFixed(2)}`, cx, cy + sub * 0.6);
        }
      }

      // price line / area / candles
      // Use pre-filtered window ref (updated on data tick, not here in the hot path).
      // Refresh it whenever the scale window shifts or new data arrives.
      {
        const hist = v.s.history;
        const cached = histWindowRef.current;
        const needsReslice =
          cached.length === 0 ||
          hist.length !== cached.length ||
          (hist[0]?.t !== cached[0]?.t) ||
          cached[cached.length - 1]!.t < sc.winStart ||
          cached[0]!.t > liveNow;
        if (needsReslice) {
          histWindowRef.current = hist.filter((p) => p.t >= sc.winStart && p.t <= liveNow);
        }
      }
      const windowHist = histWindowRef.current;
      if (isCandleStyle(v.chartStyle)) {
        const candleW = Math.max(2, (CANDLE_MS / sc.tSpan) * sc.plotW - 1.5);
        v.candles.forEach((cd, i) => {
          const cxx = xOf(cd.t + CANDLE_MS / 2);
          if (cxx < PAD_L - candleW || cxx > v.w - PAD_R + candleW) return;
          const up = cd.c >= cd.o;
          const col = up ? C.greenBright : C.red;
          const forming = i === v.candles.length - 1;
          const bodyTop = Math.min(yOf(cd.o), yOf(cd.c));
          const bodyH = Math.max(1.2, Math.abs(yOf(cd.c) - yOf(cd.o)));
          const bw = forming ? candleW + 1 : candleW;
          ctx.globalAlpha = forming ? 1 : 0.92;
          ctx.strokeStyle = col; ctx.lineWidth = forming ? 1.3 : 1;
          ctx.beginPath(); ctx.moveTo(cxx, yOf(cd.h)); ctx.lineTo(cxx, yOf(cd.l)); ctx.stroke();
          roundRect(ctx, cxx - bw / 2, bodyTop, bw, bodyH, 1);
          ctx.fillStyle = up ? `${col}26` : col; ctx.fill();
          ctx.lineWidth = 1.1; ctx.strokeStyle = col; ctx.stroke();
          ctx.globalAlpha = 1;
        });
      } else if (windowHist.length > 1) {
        if (v.chartStyle === 'area') {
          const grad = ctx.createLinearGradient(0, PAD_T, 0, v.h - PAD_B);
          grad.addColorStop(0, 'rgba(25,230,189,0.35)');
          grad.addColorStop(1, 'rgba(25,230,189,0)');
          ctx.beginPath();
          ctx.moveTo(xOf(windowHist[0]!.t), v.h - PAD_B);
          for (const p of windowHist) ctx.lineTo(xOf(p.t), yOf(p.price));
          ctx.lineTo(nowX, v.h - PAD_B);
          ctx.closePath();
          ctx.fillStyle = grad; ctx.fill();
        }
        // Two-pass manual glow: wide faint stroke then narrow bright — avoids shadowBlur
        // which triggers expensive compositor layer and blocks GPU pipeline.
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        windowHist.forEach((p, i) => { const x = xOf(p.t), y = yOf(p.price); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.strokeStyle = 'rgba(11,153,129,0.22)'; ctx.lineWidth = 6;
        ctx.stroke();
        ctx.strokeStyle = '#19e6bd'; ctx.lineWidth = 1.75;
        ctx.stroke();
      }

      // markers
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD_L, priceY); ctx.lineTo(v.w - PAD_R, priceY); ctx.stroke();
      ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(128,125,254,0.7)';
      ctx.beginPath(); ctx.moveTo(nowX, PAD_T); ctx.lineTo(nowX, v.h - PAD_B); ctx.stroke();
      ctx.setLineDash([]);
      const pulse = 3.5 + Math.sin(ts / 300) * 0.6;
      ctx.fillStyle = 'rgba(25,230,189,0.3)';
      ctx.beginPath(); ctx.arc(nowX, priceY, pulse + 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#19e6bd';
      ctx.beginPath(); ctx.arc(nowX, priceY, pulse, 0, Math.PI * 2); ctx.fill();

      // price axis labels (right)
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.font = `400 11px 'Berkeley Mono', monospace`;
      ctx.fillStyle = C.quaternary;
      for (const st of v.s.strikes) {
        const y = yOf(st);
        if (y < PAD_T || y > v.h - PAD_B) continue;
        ctx.fillText(st.toFixed(0), v.w - 6, y);
      }
      // live price chip
      roundRect(ctx, v.w - 52, priceY - 9, 50, 18, 4);
      ctx.fillStyle = C.green; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `700 12px 'Berkeley Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(v.s.price.toFixed(2), v.w - 27, priceY);

      // time axis labels (bottom)
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
      for (const e of v.s.epochs) {
        const x = xOf(e.start);
        if (x < PAD_L - 20 || x > v.w - PAD_R + 20) continue;
        const isCurrent = e.id === v.s.currentEpochId;
        const isFuture = e.start > liveNow;
        ctx.fillStyle = isCurrent ? C.violet : C.quaternary;
        ctx.font = `${isCurrent ? 700 : 400} 11px 'Berkeley Mono', monospace`;
        ctx.fillText(fmtTime(e.start), x, v.h - 10);
        if (isCurrent || isFuture) {
          const remaining = Math.max(0, (e.end - liveNow) / 1000);
          const mmss = `${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, '0')}`;
          ctx.fillStyle = isCurrent ? C.accent : 'rgba(142,147,155,0.6)';
          ctx.font = `400 10px 'Berkeley Mono', monospace`;
          ctx.fillText(mmss, x, v.h - 1);
        }
      }

      // LIVE badge + progress on current column
      const cur = v.s.epochs.find((e) => e.id === v.s.currentEpochId);
      if (cur) {
        const left = xOf(cur.start);
        const cw = xOf(cur.end) - left;
        const frac = Math.min(1, Math.max(0, (liveNow - cur.start) / (cur.end - cur.start)));
        const bx = left + cw / 2;
        roundRect(ctx, bx - 26, PAD_T + 2, 52, 15, 4);
        ctx.fillStyle = 'rgba(128,125,254,0.18)'; ctx.fill();
        ctx.fillStyle = C.green;
        ctx.beginPath(); ctx.arc(bx - 16, PAD_T + 9.5, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = C.accent; ctx.font = `700 10px 'Berkeley Mono', monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('LIVE', bx + 4, PAD_T + 10);
        ctx.textBaseline = 'alphabetic';
        roundRect(ctx, left + 2, v.h - PAD_B - 1, Math.max(0, cw - 4), 3, 1.5);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
        roundRect(ctx, left + 2, v.h - PAD_B - 1, Math.max(0, (cw - 4) * frac), 3, 1.5);
        ctx.fillStyle = C.accent; ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [bandCoordOf]);

  // ── settlement / leg animations (DOM overlay) ─────────────────────────────
  useEffect(() => {
    const now = s.now;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      for (const epoch of s.epochs) {
        // already-live/past legs shouldn't pop on mount
        if (epoch.start <= now) {
          for (const [key, leg] of s.legs) if (leg.epochId === epoch.id) activatedRef.current.add(key);
        }
        if (epoch.end <= now) eruptingBandsRef.current.add(`epoch:${epoch.id}`);
      }
      return;
    }
    const sc = scaleRef.current;
    const freeze = (epoch: Epoch, band: Band, key: string) => {
      if (!sc) return;
      const xOf = (t: number) => PAD_L + ((t - sc.winStart) / sc.tSpan) * sc.plotW;
      const yOf = (p: number) => PAD_T + ((sc.coordMax - bandCoordOf(p)) / sc.coordSpan) * sc.plotH;
      animFrozenPos.current.set(key, {
        left: xOf(epoch.start) + 1, top: yOf(band.upper) + 1,
        width: Math.max(0, xOf(epoch.end) - xOf(epoch.start) - 2),
        height: Math.max(0, yOf(band.lower) - yOf(band.upper) - 2),
      });
    };

    // ── Activation pop: a preselected epoch just went live → pop each of your
    //    boxes in it and fall its text out. Fires at the START of the epoch.
    for (const [key, leg] of s.legs) {
      if (activatedRef.current.has(key)) continue;
      const epoch = s.epochs.find((e) => e.id === leg.epochId);
      if (!epoch || epoch.start > now) continue; // not live yet
      const band = s.bands.find((b) => b.idx === leg.bandIdx);
      if (!band) continue;
      activatedRef.current.add(key);
      freeze(epoch, band, key);
      setPoppingKeys((p) => { const c = new Map(p); c.set(key, { text: `${leg.multiplier.toFixed(2)}x` }); return c; });
      setTimeout(() => setPoppingKeys((p) => { const c = new Map(p); c.delete(key); return c; }), 950);
    }

    // ── Settlement eruption: winning band reveal at the END of the epoch.
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
  }, [s.now, s.epochs, s.bands, s.legs, bandCoordOf, s]);

  // ── pointer interaction (hit-test on canvas) ──────────────────────────────
  const cellAt = (mx: number, my: number) => {
    const sc = scaleRef.current;
    if (!sc) return null;
    if (mx < PAD_L || mx > w - PAD_R || my < PAD_T || my > h - PAD_B) return null;
    const t = sc.winStart + ((mx - PAD_L) / sc.plotW) * sc.tSpan;
    const epoch = s.epochs.find((e) => t >= e.start && t < e.end);
    const coord = sc.coordMax - ((my - PAD_T) / sc.plotH) * sc.coordSpan;
    const band = s.bands.find((b) => b.idx === Math.floor(coord));
    return epoch && band ? { epoch, band } : null;
  };

  const localXY = (e: React.PointerEvent) => {
    const r = containerRef.current!.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { mx, my } = localXY(e);
    const hit = cellAt(mx, my);
    if (!hit || hit.epoch.start <= s.now) return; // only future is tradeable
    dragging.current = true;
    const key = `${hit.epoch.id}:${hit.band.idx}`;
    const isAdding = !s.hasLeg(key);
    dragMode.current = isAdding ? 'add' : 'remove';
    s.toggleLeg(hit.epoch, hit.band);
    s.setFocusedEpoch(hit.epoch.id);
    if (isAdding) {
      setFocusedLegKey(key);
    } else {
      if (focusedLegKey === key) setFocusedLegKey(null);
    }
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

  const onPointerMove = (e: React.PointerEvent) => {
    const { mx, my } = localXY(e);
    const hit = cellAt(mx, my);
    if (!hit) { hideTip(); return; }
    const key = `${hit.epoch.id}:${hit.band.idx}`;
    if (dragging.current && hit.epoch.start > s.now) {
      if (dragMode.current === 'add' && !s.hasLeg(key)) {
        s.addLeg(hit.epoch, hit.band);
        setFocusedLegKey(key);
      }
      if (dragMode.current === 'remove' && s.hasLeg(key)) {
        s.removeLeg(key);
        if (focusedLegKey === key) setFocusedLegKey(null);
      }
    }
    const cell = s.cellFor(hit.epoch, hit.band);
    showTip({
      lower: hit.band.lower, upper: hit.band.upper, prob: cell.prob, mult: cell.multiplier,
      cost: cell.cost, mx, my, locked: hit.epoch.start <= s.now && hit.epoch.end > s.now,
    });
  };
  const onPointerUp = () => { dragging.current = false; };
  const onPointerLeave = () => { dragging.current = false; hideTip(); };

  // overlay cell lookup by key
  const overlayCells = useMemo(() => {
    const items: { key: string; text?: string; pop: boolean; erupt: boolean }[] = [];
    for (const [key, info] of poppingKeys) items.push({ key, text: info.text, pop: true, erupt: false });
    for (const key of eruptingWinKeys) items.push({ key, pop: false, erupt: true });
    return items;
  }, [poppingKeys, eruptingWinKeys]);

  return (
    <div className="flex flex-col h-full w-full">
      <style>{`
        @keyframes gridWinErupt{0%{transform:scale(1);box-shadow:0 0 0 0 rgba(11,153,129,0);background:rgba(11,153,129,0.16);border-color:#0b9981}10%{transform:scale(1.06);box-shadow:0 0 0 6px rgba(11,153,129,0.5),0 0 50px 12px rgba(11,153,129,0.55),inset 0 0 20px rgba(25,230,189,0.3);background:rgba(25,230,189,0.85);border-color:#19e6bd}28%{transform:scale(1.03);background:rgba(11,153,129,0.75)}65%{transform:scale(1.01);background:rgba(11,153,129,0.6)}100%{transform:scale(1);box-shadow:0 0 6px 1px rgba(11,153,129,0.12);background:rgba(11,153,129,0.5);border-color:#0b9981}}
        .animate-win-erupt{animation:gridWinErupt 1.8s cubic-bezier(0.16,1,0.3,1) forwards;z-index:30}
        @keyframes gridFallOut{0%{transform:translate3d(0,0,0) rotate(0deg) scale(1);opacity:1;filter:blur(0)}18%{transform:translate3d(0,-7px,0) rotate(-1.5deg) scale(1.025);opacity:1}100%{transform:translate3d(0,150px,0) rotate(12deg) scale(0.72);opacity:0;filter:blur(1px)}}
        .animate-fall-out{animation:gridFallOut 0.95s cubic-bezier(0.22,0.72,0.16,1) forwards;transform-origin:50% 50%}
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
        <canvas
          ref={canvasRef}
          style={{ width: w, height: h, display: 'block' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        />

        {/* animation overlay — only the few cells mid-animation */}
        {overlayCells.map(({ key, text, pop }) => {
          const pos = animFrozenPos.current.get(key);
          if (!pos) return null;

          // Box went live: POP the box in place, fall its text out — box stays.
          if (pop) {
            return (
              <div
                key={key}
                className="absolute flex items-center justify-center pointer-events-none animate-pop overflow-hidden"
                style={{
                  left: pos.left, top: pos.top, width: pos.width, height: pos.height,
                  background: 'rgba(11,153,129,0.16)', border: '1px solid #0b9981', borderRadius: 4,
                  zIndex: 50,
                }}
              >
                <span
                  className="animate-text-fall"
                  style={{ color: '#19e6bd', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 }}
                >
                  {text}
                </span>
              </div>
            );
          }

          // Settlement eruption (winning band reveal at end).
          return (
            <div
              key={key}
              className="absolute pointer-events-none animate-win-erupt"
              style={{
                left: pos.left, top: pos.top, width: pos.width, height: pos.height,
                background: 'rgba(11,153,129,0.5)', border: '1px solid #0b9981', borderRadius: 4,
                zIndex: 30,
              }}
            />
          );
        })}

        {/* hover tooltip — always mounted, shown/hidden imperatively to avoid re-renders */}
        <div
          ref={tipRef}
          className="absolute z-20 pointer-events-none rounded-xl border border-white/10 bg-[#0a0c16]/85 backdrop-blur-md px-3.5 py-2 shadow-2xl"
          style={{ display: 'none' }}
        >
          <div ref={tipRangeEl} className="text-[11px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }} />
          <div className="flex items-center gap-3 mt-1.5 text-[10px]" style={{ fontFamily: 'var(--font-mono)' }}>
            <span className="text-text-tertiary flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-violet" />
              <span ref={tipProbEl} />
            </span>
            <span ref={tipMultEl} className="text-bullish-green font-bold" />
            <span ref={tipCostEl} className="text-text-secondary" />
          </div>
          <div ref={tipLockedEl} className="items-center gap-1 mt-1.5 text-[9px] font-semibold uppercase tracking-wider" style={{ color: '#a6a3ff', display: 'none' }}>
            Live · Betting closed
          </div>
        </div>
      </div>
    </div>
  );
}

function isCandleStyle(c: ChartStyle) {
  return c === 'candles' || c === 'heikin';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Path2D variant for batched cell rendering (no ctx needed; appends sub-path).
function pathRoundRect(p: Path2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  p.moveTo(x + rr, y);
  p.arcTo(x + w, y, x + w, y + h, rr);
  p.arcTo(x + w, y + h, x, y + h, rr);
  p.arcTo(x, y + h, x, y, rr);
  p.arcTo(x, y, x + w, y, rr);
  p.closePath();
}
