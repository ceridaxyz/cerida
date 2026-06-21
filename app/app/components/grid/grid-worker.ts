/// <reference lib="webworker" />

// ── Constants (mirrors grid-chart.tsx) ──────────────────────────────────────
const PAD_T = 8, PAD_B = 22, PAD_L = 8, PAD_R = 54;
const WIN_PAST = 4 * 60_000;
const CANDLE_MS = 4_500;

const C = {
  tertiary: '#b0b5bd', quaternary: '#8e939b', primary: '#ffffff',
  accent: '#a5a3ff', violet: '#807dfe', green: '#0b9981',
  greenBright: '#19e6bd', red: '#f23546', gold: '#f5c142',
} as const;

// ── Serialised types (plain objects the main thread can postMessage) ──────────
export interface SerialCell {
  key: string;
  epochStart: number; epochEnd: number;
  bandLower: number; bandUpper: number;
  bg: string; border: string; opacity: number;
  isLive: boolean; state: string;
  mult: number; ev: number; evColor: string;
  uPnl?: number; legCost?: number;
}

export interface WorkerPayload {
  price: number;
  w: number; h: number; dpr: number;
  chartStyle: string; cellMode: string;
  visBands: number; yOffset: number; winFuture: number; xOffset: number;
  focusedLegKey: string | null;
  strikes: number[];
  epochs: Array<{ id: string; start: number; end: number }>;
  currentEpochId: string;
  cells: SerialCell[];
  history: Array<{ t: number; price: number }>;
  candles: Array<{ o: number; h: number; l: number; c: number; t: number }>;
  skip: string[];
  sigmaPoints: Array<{ t: number; sigma: number }>;
}

type WorkerMsg =
  | { type: 'init'; canvas: OffscreenCanvas; initialPrice: number }
  | { type: 'data'; payload: WorkerPayload };

// ── Worker state ─────────────────────────────────────────────────────────────
let offscreen: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let data: WorkerPayload | null = null;
let displayPrice = 0;
let last = 0;
let histWindow: Array<{ t: number; price: number }> = [];

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    offscreen = msg.canvas;
    ctx = offscreen.getContext('2d')!;
    displayPrice = msg.initialPrice;
    requestAnimationFrame(draw);
  } else if (msg.type === 'data') {
    data = msg.payload;
  }
};

// ── Geometry helpers ──────────────────────────────────────────────────────────
function bandCoordOf(strikes: number[], price: number): number {
  const last = strikes.length - 1;
  if (last < 0) return 0;
  if (price <= strikes[0]!) return (price - strikes[0]!) / ((strikes[1]! - strikes[0]!) || 1);
  if (price >= strikes[last]!) return last + (price - strikes[last]!) / ((strikes[last]! - strikes[last - 1]!) || 1);
  for (let i = 0; i < last; i++) {
    const lo = strikes[i]!, hi = strikes[i + 1]!;
    if (price < hi) return i + (price - lo) / (hi - lo);
  }
  return last;
}

function computeScale(p: WorkerPayload, dispPrice: number, liveNow: number) {
  const plotW = Math.max(1, p.w - PAD_L - PAD_R);
  const plotH = Math.max(1, p.h - PAD_T - PAD_B);
  const center = bandCoordOf(p.strikes, dispPrice);
  const coordMin = center - p.visBands / 2 + p.yOffset;
  const coordMax = center + p.visBands / 2 + p.yOffset;
  const winStart = liveNow - WIN_PAST + p.xOffset;
  const winEnd = liveNow + p.winFuture + p.xOffset;
  const tSpan = winEnd - winStart || 1;
  const coordSpan = (coordMax - coordMin) || 1;
  return { plotW, plotH, winStart, winEnd, tSpan, coordMin, coordMax, coordSpan };
}

function sigmaAt(pts: Array<{ t: number; sigma: number }>, t: number): number {
  if (!pts.length) return 0;
  if (t <= pts[0]!.t) return pts[0]!.sigma;
  if (t >= pts[pts.length - 1]!.t) return pts[pts.length - 1]!.sigma;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    if (t >= a.t && t <= b.t) return a.sigma + ((t - a.t) / (b.t - a.t)) * (b.sigma - a.sigma);
  }
  return 0;
}

function fmtTime(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function pathRR(p: Path2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  p.moveTo(x + rr, y);
  p.arcTo(x + w, y, x + w, y + h, rr);
  p.arcTo(x + w, y + h, x, y + h, rr);
  p.arcTo(x, y + h, x, y, rr);
  p.arcTo(x, y, x + w, y, rr);
  p.closePath();
}

function ctxRR(c: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// ── Main draw loop (runs entirely off the main thread) ────────────────────────
function draw(ts: number) {
  requestAnimationFrame(draw);
  const dt = Math.min(ts - last, 100); last = ts;
  if (!offscreen || !ctx || !data) return;
  const p = data;

  // Smooth price interpolation — same lerp as before, just lives in the worker now.
  displayPrice += (p.price - displayPrice) * Math.min(1, dt / 120);

  const liveNow = Date.now();
  const sc = computeScale(p, displayPrice, liveNow);

  // Resize backing store when container resizes.
  const tw = Math.round(p.w * p.dpr);
  const th = Math.round(p.h * p.dpr);
  if (offscreen.width !== tw || offscreen.height !== th) {
    offscreen.width = tw;
    offscreen.height = th;
  }

  ctx.setTransform(p.dpr, 0, 0, p.dpr, 0, 0);
  ctx.clearRect(0, 0, p.w, p.h);

  const xOf = (t: number) => PAD_L + ((t - sc.winStart) / sc.tSpan) * sc.plotW;
  const yOf = (price: number) => PAD_T + ((sc.coordMax - bandCoordOf(p.strikes, price)) / sc.coordSpan) * sc.plotH;
  const nowX = xOf(liveNow);
  const priceY = yOf(displayPrice);

  // ── Gridlines — batched into 2 draw calls ────────────────────────────────
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath();
  for (const st of p.strikes) {
    const y = yOf(st);
    if (y < PAD_T - 2 || y > p.h - PAD_B + 2) continue;
    ctx.moveTo(PAD_L, y); ctx.lineTo(p.w - PAD_R, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.beginPath();
  for (const e of p.epochs) {
    const x = xOf(e.start);
    if (x < PAD_L - 2 || x > p.w - PAD_R + 2) continue;
    ctx.moveTo(x, PAD_T); ctx.lineTo(x, p.h - PAD_B);
  }
  ctx.stroke();

  // ── Expected-move cone (±1σ) ─────────────────────────────────────────────
  if (sc.winEnd > liveNow && p.sigmaPoints.length > 0) {
    const steps = 16;
    const startT = Math.max(liveNow, sc.winStart);
    const up: [number, number][] = [];
    const lo: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const t = startT + ((sc.winEnd - startT) * i) / steps;
      const sig = sigmaAt(p.sigmaPoints, t);
      up.push([xOf(t), yOf(displayPrice + sig)]);
      lo.push([xOf(t), yOf(displayPrice - sig)]);
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

  // ── Cells — Phase 1: Path2D batched fills + strokes ──────────────────────
  type BatchEntry = { fillPath: Path2D; strokePath: Path2D; opacity: number; strokeW: number };
  const batches = new Map<string, BatchEntry>();
  type Geom = { c: SerialCell; left: number; top: number; cw: number; ch: number };
  const geomList: Geom[] = [];
  const skipSet = new Set(p.skip);

  for (const c of p.cells) {
    if (skipSet.has(c.key)) continue;
    const left = xOf(c.epochStart) + 1;
    const top = yOf(c.bandUpper) + 1;
    const cw = xOf(c.epochEnd) - xOf(c.epochStart) - 2;
    const ch = yOf(c.bandLower) - yOf(c.bandUpper) - 2;
    if (cw <= 0 || ch <= 0) continue;
    if (left > p.w - PAD_R || left + cw < PAD_L || top > p.h - PAD_B || top + ch < PAD_T) continue;

    const isFocused = p.focusedLegKey === c.key;
    const sw = isFocused ? 2 : 1;
    const border = isFocused ? '#807dfe' : c.border;
    const bk = `${c.bg}|${border}|${c.opacity}|${sw}`;
    let b = batches.get(bk);
    if (!b) {
      b = { fillPath: new Path2D(), strokePath: new Path2D(), opacity: c.opacity, strokeW: sw };
      batches.set(bk, b);
    }
    pathRR(b.fillPath, left, top, cw, ch, 4);
    pathRR(b.strokePath, left, top, cw, ch, 4);
    geomList.push({ c, left, top, cw, ch });
  }

  for (const [bk, b] of batches) {
    const pipe = bk.indexOf('|');
    ctx.globalAlpha = b.opacity;
    ctx.fillStyle = bk.slice(0, pipe);
    ctx.fill(b.fillPath);
  }
  for (const [bk, b] of batches) {
    const p1 = bk.indexOf('|'), p2 = bk.indexOf('|', p1 + 1);
    ctx.globalAlpha = b.opacity;
    ctx.lineWidth = b.strokeW;
    ctx.strokeStyle = bk.slice(p1 + 1, p2);
    ctx.stroke(b.strokePath);
  }
  ctx.globalAlpha = 1;

  // ── Cells — Phase 2: text labels (can't batch; only large non-live cells) ─
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const { c, left, top, cw, ch } of geomList) {
    if (cw <= 46 || ch <= 22 || c.isLive) continue;
    const fs = Math.max(10, Math.min(16, Math.min(cw * 0.155, ch * 0.65)));
    const cx = left + cw / 2, cy = top + ch / 2;

    if (c.state === 'available') {
      ctx.font = `600 ${fs}px 'Berkeley Mono', monospace`;
      if (p.cellMode === 'edge') {
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
      const lc = c.legCost ?? 0;
      ctx.fillText(`$${lc.toFixed(0)} → $${(lc * c.mult).toFixed(0)}`, cx, cy + fs * 0.55);
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

  // ── Price chart ───────────────────────────────────────────────────────────
  {
    const hist = p.history;
    const cached = histWindow;
    const stale =
      !cached.length || hist.length !== cached.length ||
      hist[0]?.t !== cached[0]?.t ||
      (cached[cached.length - 1]?.t ?? 0) < sc.winStart ||
      (cached[0]?.t ?? Infinity) > liveNow;
    if (stale) histWindow = hist.filter(pt => pt.t >= sc.winStart && pt.t <= liveNow);
  }
  const wHist = histWindow;

  if (p.chartStyle === 'candles' || p.chartStyle === 'heikin') {
    const candleW = Math.max(2, (CANDLE_MS / sc.tSpan) * sc.plotW - 1.5);
    p.candles.forEach((cd, i) => {
      const cxx = xOf(cd.t + CANDLE_MS / 2);
      if (cxx < PAD_L - candleW || cxx > p.w - PAD_R + candleW) return;
      const up = cd.c >= cd.o;
      const col = up ? C.greenBright : C.red;
      const forming = i === p.candles.length - 1;
      const bodyTop = Math.min(yOf(cd.o), yOf(cd.c));
      const bodyH = Math.max(1.2, Math.abs(yOf(cd.c) - yOf(cd.o)));
      const bw = forming ? candleW + 1 : candleW;
      ctx.globalAlpha = forming ? 1 : 0.92;
      ctx.strokeStyle = col; ctx.lineWidth = forming ? 1.3 : 1;
      ctx.beginPath(); ctx.moveTo(cxx, yOf(cd.h)); ctx.lineTo(cxx, yOf(cd.l)); ctx.stroke();
      ctxRR(ctx, cxx - bw / 2, bodyTop, bw, bodyH, 1);
      ctx.fillStyle = up ? `${col}26` : col; ctx.fill();
      ctx.lineWidth = 1.1; ctx.strokeStyle = col; ctx.stroke();
      ctx.globalAlpha = 1;
    });
  } else if (wHist.length > 1) {
    if (p.chartStyle === 'area') {
      const grad = ctx.createLinearGradient(0, PAD_T, 0, p.h - PAD_B);
      grad.addColorStop(0, 'rgba(25,230,189,0.35)');
      grad.addColorStop(1, 'rgba(25,230,189,0)');
      ctx.beginPath();
      ctx.moveTo(xOf(wHist[0]!.t), p.h - PAD_B);
      for (const pt of wHist) ctx.lineTo(xOf(pt.t), yOf(pt.price));
      ctx.lineTo(nowX, p.h - PAD_B);
      ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
    }
    // Two-pass glow: wide faint + narrow bright (no shadowBlur).
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    wHist.forEach((pt, i) => { const x = xOf(pt.t), y = yOf(pt.price); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = 'rgba(11,153,129,0.22)'; ctx.lineWidth = 6; ctx.stroke();
    ctx.strokeStyle = '#19e6bd'; ctx.lineWidth = 1.75; ctx.stroke();
  }

  // ── Markers ───────────────────────────────────────────────────────────────
  ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD_L, priceY); ctx.lineTo(p.w - PAD_R, priceY); ctx.stroke();
  ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(128,125,254,0.7)';
  ctx.beginPath(); ctx.moveTo(nowX, PAD_T); ctx.lineTo(nowX, p.h - PAD_B); ctx.stroke();
  ctx.setLineDash([]);
  const pulse = 3.5 + Math.sin(ts / 300) * 0.6;
  ctx.fillStyle = 'rgba(25,230,189,0.3)';
  ctx.beginPath(); ctx.arc(nowX, priceY, pulse + 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#19e6bd';
  ctx.beginPath(); ctx.arc(nowX, priceY, pulse, 0, Math.PI * 2); ctx.fill();

  // ── Price axis labels ─────────────────────────────────────────────────────
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.font = `400 11px 'Berkeley Mono', monospace`;
  ctx.fillStyle = C.quaternary;
  for (const st of p.strikes) {
    const y = yOf(st);
    if (y < PAD_T || y > p.h - PAD_B) continue;
    ctx.fillText(st.toFixed(0), p.w - 6, y);
  }
  ctxRR(ctx, p.w - 52, priceY - 9, 50, 18, 4);
  ctx.fillStyle = C.green; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `700 12px 'Berkeley Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(p.price.toFixed(2), p.w - 27, priceY);

  // ── Time axis labels + countdown ──────────────────────────────────────────
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  for (const e of p.epochs) {
    const x = xOf(e.start);
    if (x < PAD_L - 20 || x > p.w - PAD_R + 20) continue;
    const isCurrent = e.id === p.currentEpochId;
    const isFuture = e.start > liveNow;
    ctx.fillStyle = isCurrent ? C.violet : C.quaternary;
    ctx.font = `${isCurrent ? 700 : 400} 11px 'Berkeley Mono', monospace`;
    ctx.fillText(fmtTime(e.start), x, p.h - 10);
    if (isCurrent || isFuture) {
      const remaining = Math.max(0, (e.end - liveNow) / 1000);
      const mmss = `${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, '0')}`;
      ctx.fillStyle = isCurrent ? C.accent : 'rgba(142,147,155,0.6)';
      ctx.font = `400 10px 'Berkeley Mono', monospace`;
      ctx.fillText(mmss, x, p.h - 1);
    }
  }

  // ── LIVE badge + epoch progress bar ───────────────────────────────────────
  const cur = p.epochs.find(e => e.id === p.currentEpochId);
  if (cur) {
    const left = xOf(cur.start);
    const cw = xOf(cur.end) - left;
    const frac = Math.min(1, Math.max(0, (liveNow - cur.start) / (cur.end - cur.start)));
    const bx = left + cw / 2;
    ctxRR(ctx, bx - 26, PAD_T + 2, 52, 15, 4);
    ctx.fillStyle = 'rgba(128,125,254,0.18)'; ctx.fill();
    ctx.fillStyle = C.green;
    ctx.beginPath(); ctx.arc(bx - 16, PAD_T + 9.5, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.accent; ctx.font = `700 10px 'Berkeley Mono', monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('LIVE', bx + 4, PAD_T + 10);
    ctx.textBaseline = 'alphabetic';
    ctxRR(ctx, left + 2, p.h - PAD_B - 1, Math.max(0, cw - 4), 3, 1.5);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
    ctxRR(ctx, left + 2, p.h - PAD_B - 1, Math.max(0, (cw - 4) * frac), 3, 1.5);
    ctx.fillStyle = C.accent; ctx.fill();
  }
}
