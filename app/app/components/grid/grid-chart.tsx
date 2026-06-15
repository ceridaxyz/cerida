import { useEffect, useRef, useState } from 'react';
import type { GridState } from './use-grid-state';
import type { Band, Epoch } from './types';

const PAD_T = 8;
const PAD_B = 22;
const PAD_L = 8;
const PAD_R = 54;

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const EPOCH_MS = 60_000;
// Sliding window: how much past/future time is visible. `now` sits at
// WIN_PAST / (WIN_PAST + WIN_FUTURE) across the plot.
const WIN_PAST = 4 * EPOCH_MS;
const WIN_FUTURE = 6 * EPOCH_MS;

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(ref.current);
    setSize({ w: ref.current.clientWidth, h: ref.current.clientHeight });
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

function fmtTime(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const cellColors = {
  available: { bg: 'rgba(128,125,254,0.05)', border: 'rgba(255,255,255,0.08)', opacity: 1 },
  selected: { bg: 'rgba(128,125,254,0.22)', border: '#807dfe', opacity: 1 },
  active: { bg: 'rgba(11,153,129,0.16)', border: '#0b9981', opacity: 1 },
  won: { bg: 'rgba(11,153,129,0.5)', border: '#0b9981', opacity: 1 },
  lost: { bg: 'rgba(242,53,70,0.12)', border: 'rgba(242,53,70,0.35)', opacity: 0.55 },
  expired: { bg: 'rgba(255,255,255,0.02)', border: 'rgba(255,255,255,0.04)', opacity: 0.5 },
} as const;

// Heat-map fill for tradeable cells: brighter/warmer near the money, fading to
// near-black in the tails. Driven by the cell's win probability.
function heatFill(prob: number): { bg: string; border: string } {
  const t = Math.min(1, prob / 0.45); // 0 (tail) → 1 (ATM)
  const a = 0.03 + t * 0.4;
  // Hue shifts cool-violet (tails) → warm-amber (hot) as probability rises.
  const r = Math.round(128 + t * 100);
  const g = Math.round(125 + t * 40);
  const b = Math.round(254 - t * 160);
  return {
    bg: `rgba(${r},${g},${b},${a.toFixed(3)})`,
    border: `rgba(${r},${g},${b},${(0.12 + t * 0.35).toFixed(3)})`,
  };
}

interface Hover {
  lower: number;
  upper: number;
  prob: number;
  mult: number;
  cost: number;
  mx: number;
  my: number;
}

type ChartStyle = 'line' | 'candles' | 'area';

export default function GridChart({ s }: { s: GridState }) {
  const { ref, w, h } = useSize();
  const [hover, setHover] = useState<Hover | null>(null);
  const [chartStyle, setChartStyle] = useState<ChartStyle>('line');

  // Drag-select state.
  const dragging = useRef(false);
  const dragMode = useRef<'add' | 'remove'>('add');

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  const plotW = Math.max(1, w - PAD_L - PAD_R);
  const plotH = Math.max(1, h - PAD_T - PAD_B);

  // Sliding price viewport anchored on the live price: the price line stays
  // pinned at vertical centre and the strike boxes scroll up/down through it.
  const strikeStep = (s.strikes[1] ?? 0) - (s.strikes[0] ?? 0) || 1;
  const PRICE_HALF = 7 * strikeStep; // ~14 bands tall
  const priceMin = s.price - PRICE_HALF;
  const priceMax = s.price + PRICE_HALF;
  const span = priceMax - priceMin || 1;

  // Only strikes/bands inside the price window are drawn.
  const visibleStrikes = s.strikes.filter((p) => p >= priceMin && p <= priceMax);
  const visibleBands = s.bands.filter(
    (b) => b.upper >= priceMin && b.lower <= priceMax,
  );

  // Sliding time window anchored on `now`: the "now" marker stays put at a fixed
  // screen x and the columns flow leftward through it as time advances.
  const winStart = s.now - WIN_PAST;
  const winEnd = s.now + WIN_FUTURE;
  const tSpan = winEnd - winStart; // constant

  // Only the columns inside (or straddling) the window are drawn.
  const visibleEpochs = s.epochs.filter(
    (e) => e.end >= winStart && e.start <= winEnd,
  );

  const yOf = (price: number) => PAD_T + ((priceMax - price) / span) * plotH;
  const xOf = (t: number) => PAD_L + ((t - winStart) / tSpan) * plotW;

  const nowX = xOf(s.now);
  const priceY = yOf(s.price);

  // Expected-move cone: ±1σ band fanning out from current price into the future.
  const coneUpper: string[] = [];
  const coneLower: string[] = [];
  {
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const t = s.now + ((winEnd - s.now) * i) / steps;
      const sig = s.sigmaAtTime(t);
      const x = xOf(t).toFixed(1);
      coneUpper.push(`${x},${yOf(s.price + sig).toFixed(1)}`);
      coneLower.push(`${x},${yOf(s.price - sig).toFixed(1)}`);
    }
  }
  const conePath = `M${coneUpper.join(' L')} L${[...coneLower].reverse().join(' L')} Z`;

  // Header analytics: 1σ move one epoch out, and an annualized implied vol.
  const horizonSig = s.sigmaAtTime(s.now + EPOCH_MS);
  const ivPct = (horizonSig / s.price) * Math.sqrt(SECONDS_PER_YEAR / 60) * 100;

  const windowHist = s.history.filter((p) => p.t >= winStart && p.t <= s.now);

  const linePts = windowHist
    .map((p) => `${xOf(p.t).toFixed(1)},${yOf(p.price).toFixed(1)}`)
    .join(' ');

  // Area = line closed down to the baseline.
  const areaPath =
    windowHist.length > 1
      ? `M${xOf(windowHist[0]!.t).toFixed(1)},${(h - PAD_B).toFixed(1)} ` +
        `L${linePts.split(' ').join(' L')} ` +
        `L${nowX.toFixed(1)},${(h - PAD_B).toFixed(1)} Z`
      : '';

  // OHLC candles aggregated from ticks into fixed-time buckets.
  const candles = (() => {
    if (chartStyle !== 'candles') return [];
    const buckets = new Map<number, { o: number; h: number; l: number; c: number; t: number }>();
    for (const p of windowHist) {
      const b = Math.floor(p.t / CANDLE_MS) * CANDLE_MS;
      const cur = buckets.get(b);
      if (!cur) buckets.set(b, { o: p.price, h: p.price, l: p.price, c: p.price, t: b });
      else {
        cur.h = Math.max(cur.h, p.price);
        cur.l = Math.min(cur.l, p.price);
        cur.c = p.price;
      }
    }
    return [...buckets.values()];
  })();
  const candleW = Math.max(2, (CANDLE_MS / tSpan) * plotW - 1.5);

  const onCellDown = (epoch: Epoch, band: Band) => {
    dragging.current = true;
    const key = `${epoch.id}:${band.idx}`;
    dragMode.current = s.hasLeg(key) ? 'remove' : 'add';
    s.toggleLeg(epoch, band);
  };
  const onCellEnter = (epoch: Epoch, band: Band) => {
    if (!dragging.current) return;
    const key = `${epoch.id}:${band.idx}`;
    if (dragMode.current === 'add' && !s.hasLeg(key)) s.addLeg(epoch, band);
    if (dragMode.current === 'remove' && s.hasLeg(key)) s.removeLeg(key);
  };

  return (
    <div ref={ref} className="relative h-full w-full overflow-hidden select-none">
      {/* Header chips: implied vol + expected move */}
      <div className="absolute z-20 left-2 top-1.5 flex items-center gap-1.5 pointer-events-none">
        <span
          className="px-1.5 py-0.5 rounded-[4px] text-[9px] font-semibold uppercase tracking-wider"
          style={{ background: 'rgba(128,125,254,0.15)', color: '#a6a3ff', fontFamily: 'var(--font-mono)' }}
        >
          IV {ivPct.toFixed(0)}%
        </span>
        <span
          className="px-1.5 py-0.5 rounded-[4px] text-[9px] font-medium tracking-wider text-text-quaternary"
          style={{ background: 'rgba(255,255,255,0.04)', fontFamily: 'var(--font-mono)' }}
        >
          ±${horizonSig.toFixed(1)} / epoch
        </span>
      </div>

      {/* Behind: grid lines */}
      <svg className="absolute inset-0 pointer-events-none" width={w} height={h}>
        {visibleStrikes.map((p) => (
          <line
            key={`h${p}`}
            x1={PAD_L}
            x2={w - PAD_R}
            y1={yOf(p)}
            y2={yOf(p)}
            stroke="rgba(255,255,255,0.05)"
            strokeWidth={1}
          />
        ))}
        {visibleEpochs.map((e) => (
          <line
            key={`v${e.id}`}
            x1={xOf(e.start)}
            x2={xOf(e.start)}
            y1={PAD_T}
            y2={h - PAD_B}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={1}
          />
        ))}

        {/* Expected-move cone (±1σ) */}
        <path d={conePath} fill="rgba(128,125,254,0.07)" stroke="none" />
        <polyline
          points={coneUpper.join(' ')}
          fill="none"
          stroke="rgba(128,125,254,0.3)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        <polyline
          points={coneLower.join(' ')}
          fill="none"
          stroke="rgba(128,125,254,0.3)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>

      {/* Cells — every visible epoch (past = settled, current/future = tradeable) */}
      {visibleEpochs.map((epoch) => {
        const isPast = epoch.end <= s.now;
        return visibleBands.map((band) => {
          const cell = s.cellFor(epoch, band);
          const left = xOf(epoch.start);
          const cw = xOf(epoch.end) - left;
          const top = yOf(band.upper);
          const ch = yOf(band.lower) - top;
          const base = cellColors[cell.state];
          // Heat-map only the plain tradeable cells; keep semantic states bold.
          const heat = cell.state === 'available' ? heatFill(cell.prob) : null;
          const c = heat ? { ...base, bg: heat.bg, border: heat.border } : base;
          const big = cw > 46 && ch > 22;
          const isFocused = epoch.id === s.focusedEpoch;
          return (
            <div
              key={`${epoch.id}:${band.idx}`}
              onPointerDown={isPast ? undefined : () => onCellDown(epoch, band)}
              onPointerEnter={(e) => {
                if (!isPast) onCellEnter(epoch, band);
                const rect = ref.current?.getBoundingClientRect();
                setHover({
                  lower: band.lower,
                  upper: band.upper,
                  prob: cell.prob,
                  mult: cell.multiplier,
                  cost: cell.cost,
                  mx: rect ? e.clientX - rect.left : 0,
                  my: rect ? e.clientY - rect.top : 0,
                });
              }}
              onPointerMove={(e) => {
                const rect = ref.current?.getBoundingClientRect();
                setHover((prev) =>
                  prev
                    ? {
                        ...prev,
                        mx: rect ? e.clientX - rect.left : prev.mx,
                        my: rect ? e.clientY - rect.top : prev.my,
                      }
                    : prev,
                );
              }}
              onPointerLeave={() => setHover(null)}
              onClick={isPast ? undefined : () => s.setFocusedEpoch(epoch.id)}
              className="absolute flex flex-col items-center justify-center transition-colors"
              style={{
                left: left + 1,
                top: top + 1,
                width: Math.max(0, cw - 2),
                height: Math.max(0, ch - 2),
                background: c.bg,
                border: `1px solid ${c.border}`,
                borderRadius: 4,
                opacity: c.opacity,
                cursor: isPast ? 'default' : 'pointer',
                outline: isFocused && !isPast ? '1px solid rgba(128,125,254,0.35)' : 'none',
                outlineOffset: -1,
              }}
            >
              {big && cell.state === 'available' && (
                <span className="text-[10px] font-semibold text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                  {cell.multiplier.toFixed(2)}x
                </span>
              )}
              {big && cell.state === 'selected' && (
                <>
                  <span className="text-[10px] font-bold text-text-primary">{cell.multiplier.toFixed(2)}x</span>
                  <span className="text-[9px] text-accent-light" style={{ fontFamily: 'var(--font-mono)' }}>
                    ${cell.cost.toFixed(2)}
                  </span>
                </>
              )}
              {big && cell.state === 'active' && (
                <span
                  className="text-[10px] font-bold"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: (cell.uPnl ?? 0) >= 0 ? '#0b9981' : '#f23546',
                  }}
                >
                  {(cell.uPnl ?? 0) >= 0 ? '+$' : '−$'}
                  {Math.abs(cell.uPnl ?? 0).toFixed(2)}
                </span>
              )}
            </div>
          );
        });
      })}

      {/* On top: price line + markers (non-interactive) */}
      <svg className="absolute inset-0 pointer-events-none" width={w} height={h}>
        <defs>
          <filter id="priceGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {linePts && (
          <>
            {/* soft neon underlay */}
            <polyline
              points={linePts}
              fill="none"
              stroke="#0b9981"
              strokeWidth={5}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.28}
              filter="url(#priceGlow)"
            />
            <polyline
              points={linePts}
              fill="none"
              stroke="#19e6bd"
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}
        <line
          x1={PAD_L}
          x2={w - PAD_R}
          y1={priceY}
          y2={priceY}
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <line
          x1={nowX}
          x2={nowX}
          y1={PAD_T}
          y2={h - PAD_B}
          stroke="#807dfe"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.7}
        />
        {/* glowing price dot */}
        <circle cx={nowX} cy={priceY} r={6} fill="#19e6bd" opacity={0.3} filter="url(#priceGlow)" />
        <circle cx={nowX} cy={priceY} r={3.5} fill="#19e6bd">
          <animate attributeName="r" values="3.5;4.5;3.5" dur="1.8s" repeatCount="indefinite" />
        </circle>
      </svg>

      {/* price axis labels (right) */}
      {visibleStrikes.map((p) => (
        <span
          key={`pl${p}`}
          className="absolute text-[9px] text-text-quaternary pointer-events-none"
          style={{ right: 6, top: yOf(p) - 6, fontFamily: 'var(--font-mono)' }}
        >
          {p.toFixed(0)}
        </span>
      ))}

      {/* live price chip */}
      <span
        className="absolute text-[10px] font-bold text-white px-1 rounded-[3px] pointer-events-none"
        style={{ right: 2, top: priceY - 8, background: '#0b9981', fontFamily: 'var(--font-mono)' }}
      >
        {s.price.toFixed(2)}
      </span>

      {/* time axis labels (bottom) */}
      {visibleEpochs.map((e) => {
        const isCurrent = e.id === s.currentEpochId;
        const isFuture = e.start > s.now;
        const remaining = Math.max(0, (e.end - s.now) / 1000);
        const mmss = `${Math.floor(remaining / 60)}:${String(
          Math.floor(remaining % 60),
        ).padStart(2, '0')}`;
        return (
          <span
            key={`tl${e.id}`}
            className={`absolute text-[9px] pointer-events-none flex flex-col items-center ${
              isCurrent ? 'text-brand-violet font-bold' : 'text-text-quaternary'
            }`}
            style={{
              left: xOf(e.start),
              bottom: 4,
              transform: 'translateX(-50%)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span>{fmtTime(e.start)}</span>
            {(isCurrent || isFuture) && (
              <span className={isCurrent ? 'text-accent-light' : 'text-text-quaternary/60'}>
                {mmss}
              </span>
            )}
          </span>
        );
      })}

      {/* LIVE badge + progress bar on the current epoch column */}
      {s.epochs
        .filter((e) => e.id === s.currentEpochId)
        .map((e) => {
          const frac = Math.min(1, Math.max(0, (s.now - e.start) / (e.end - e.start)));
          const left = xOf(e.start);
          const cw = xOf(e.end) - left;
          return (
            <div key={`live${e.id}`} className="pointer-events-none">
              <span
                className="absolute z-20 flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] text-[8px] font-bold uppercase tracking-widest"
                style={{
                  left: left + cw / 2,
                  top: PAD_T + 2,
                  transform: 'translateX(-50%)',
                  background: 'rgba(128,125,254,0.18)',
                  color: '#a6a3ff',
                }}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-bullish-green animate-pulse" />
                LIVE
              </span>
              {/* progress bar at the bottom of the column */}
              <div
                className="absolute h-[3px] rounded-full overflow-hidden"
                style={{ left: left + 2, width: Math.max(0, cw - 4), bottom: PAD_B - 2, background: 'rgba(255,255,255,0.06)' }}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-500 ease-linear"
                  style={{ width: `${frac * 100}%`, background: 'linear-gradient(90deg,#807dfe,#a6a3ff)' }}
                />
              </div>
            </div>
          );
        })}

      {/* hover tooltip */}
      {hover && (
        <div
          className="absolute z-20 pointer-events-none rounded-[6px] border border-border-default bg-surface-card px-2.5 py-1.5 shadow-xl"
          style={{
            left: Math.min(hover.mx + 14, w - 150),
            top: Math.min(hover.my + 14, h - 70),
          }}
        >
          <div className="text-[11px] font-semibold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
            ${hover.lower}–{hover.upper}
          </div>
          <div className="flex gap-3 mt-1 text-[10px]" style={{ fontFamily: 'var(--font-mono)' }}>
            <span className="text-text-tertiary">{(hover.prob * 100).toFixed(0)}%</span>
            <span className="text-bullish-green">{hover.mult.toFixed(2)}x</span>
            <span className="text-text-secondary">${hover.cost.toFixed(2)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
