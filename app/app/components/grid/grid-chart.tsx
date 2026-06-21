import { useEffect, useRef, useState } from 'react';
import type { GridState } from './use-grid-state';
import type { Band, Epoch } from './types';
import { realizedVol } from './analytics';

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
const CANDLE_MS = 4_500; // tick bucket width for candlestick aggregation

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
  claimable: { bg: 'rgba(245,193,66,0.4)', border: '#f5c142', opacity: 1 },
  lost: { bg: 'rgba(242,53,70,0.12)', border: 'rgba(242,53,70,0.35)', opacity: 0.55 },
  expired: { bg: 'rgba(255,255,255,0.02)', border: 'rgba(255,255,255,0.04)', opacity: 0.5 },
} as const;

// Heat-map fill for tradeable cells: brighter/warmer near the money.
function heatFill(prob: number): { bg: string; border: string } {
  const t = Math.min(1, prob / 0.45);
  const a = 0.03 + t * 0.4;
  const r = Math.round(128 + t * 100);
  const g = Math.round(125 + t * 40);
  const b = Math.round(254 - t * 160);
  return {
    bg: `rgba(${r},${g},${b},${a.toFixed(3)})`,
    border: `rgba(${r},${g},${b},${(0.12 + t * 0.35).toFixed(3)})`,
  };
}

function edgeFill(ev: number): { bg: string; border: string } {
  const t = Math.min(1, Math.abs(ev) / 3);
  const a = 0.05 + t * 0.45;
  const rgb = ev >= 0 ? '25,230,189' : '242,53,70';
  return { bg: `rgba(${rgb},${a.toFixed(3)})`, border: `rgba(${rgb},${(0.2 + t * 0.5).toFixed(3)})` };
}

interface Hover {
  lower: number;
  upper: number;
  prob: number;
  mult: number;
  cost: number;
  mx: number;
  my: number;
  locked: boolean;
}

type ChartStyle = 'line' | 'candles' | 'heikin' | 'area';

export default function GridChart({ s }: { s: GridState }) {
  const { ref, w, h } = useSize();
  const [hover, setHover] = useState<Hover | null>(null);
  const [chartStyle, setChartStyle] = useState<ChartStyle>('line');
  const [cellMode, setCellMode] = useState<'mult' | 'edge'>('mult');
  const isCandle = chartStyle === 'candles' || chartStyle === 'heikin';

  const [showIso, _setShowIso] = useState(false);

  // Zoom & Pan states
  const [visBands, setVisBands] = useState<number>(14);
  const [yOffset, setYOffset] = useState<number>(0);
  const [winFuture, setWinFuture] = useState<number>(6 * EPOCH_MS);
  const [xOffset, setXOffset] = useState<number>(0);

  // Drag-select state.
  const dragging = useRef(false);
  const dragMode = useRef<'add' | 'remove'>('add');

  // Frozen positions for animating cells so time-drift doesn't jitter them.
  const animFrozenPos = useRef<Map<string, { left: number; top: number; width: number; height: number }>>(new Map());

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  const animatedCellsRef = useRef<Set<string>>(new Set());
  const [animatingKeys, setAnimatingKeys] = useState<
    Map<
      string,
      {
        tone: 'settled' | 'win' | 'lose';
        text?: string;
        delay: number;
      }
    >
  >(new Map());

  // Winning-band eruption — fires once per epoch, independent of user bets.
  const eruptingBandsRef = useRef<Set<string>>(new Set());
  const [eruptingWinKeys, setEruptingWinKeys] = useState<Set<string>>(new Set());

  const isFirstRender = useRef(true);

  useEffect(() => {
    const now = s.now;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      for (const epoch of s.epochs) {
        if (epoch.end <= now) {
          for (const band of s.bands) {
            animatedCellsRef.current.add(`${epoch.id}:${band.idx}`);
          }
          // Mark already-settled epochs so they don't re-erupt on mount.
          eruptingBandsRef.current.add(`epoch:${epoch.id}`);
        }
      }
      return;
    }

    for (const epoch of s.epochs) {
      if (epoch.end > now) continue;

      // Winning band eruption — once per epoch, for all viewers.
      const epochKey = `epoch:${epoch.id}`;
      if (!eruptingBandsRef.current.has(epochKey)) {
        const settle = s.settleOf(epoch);
        if (settle !== null) {
          const winBand = s.bands.find((b) => settle >= b.lower && settle < b.upper);
          if (winBand) {
            eruptingBandsRef.current.add(epochKey);
            const winKey = `${epoch.id}:${winBand.idx}`;
            setEruptingWinKeys((prev) => new Set([...prev, winKey]));
            setTimeout(() => {
              setEruptingWinKeys((prev) => {
                const n = new Set(prev);
                n.delete(winKey);
                return n;
              });
            }, 2000);
          }
        }
      }

      // Per-leg fall-out animation for cells the user bet on.
      for (const band of s.bands) {
        const key = `${epoch.id}:${band.idx}`;
        const leg = s.legs.get(key);
        if (!leg) continue;

        if (!animatedCellsRef.current.has(key)) {
          animatedCellsRef.current.add(key);
          const settle = s.settleOf(epoch);
          const winner = settle !== null && settle >= band.lower && settle < band.upper;

          setAnimatingKeys((prev) => {
            const copy = new Map(prev);
            copy.set(key, {
              tone: winner ? 'win' : 'lose',
              text: winner
                ? `+$${(s.stake * (leg.multiplier - 1)).toFixed(0)}`
                : `-$${s.stake.toFixed(0)}`,
              delay: 0,
            });
            return copy;
          });

          setTimeout(() => {
            setAnimatingKeys((prev) => {
              const copy = new Map(prev);
              copy.delete(key);
              return copy;
            });
          }, 1050);
        }
      }
    }
  }, [s.now, s.epochs, s.bands, s.legs, s.stake]);

  // Attach mouse wheel zoom listener to the container ref
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        // Zoom horizontal time scale
        setWinFuture((prev) => {
          const delta = e.deltaY > 0 ? 1 * EPOCH_MS : -1 * EPOCH_MS;
          return Math.max(2 * EPOCH_MS, Math.min(15 * EPOCH_MS, prev + delta));
        });
      } else {
        // Zoom vertical price bands
        setVisBands((prev) => {
          const delta = e.deltaY > 0 ? 1 : -1;
          return Math.max(6, Math.min(22, prev + delta));
        });
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [ref]);

  const plotW = Math.max(1, w - PAD_L - PAD_R);
  const plotH = Math.max(1, h - PAD_T - PAD_B);

  // Uniform-row y-axis: map by BAND INDEX, not price, so every cell is the same
  // height despite equal-probability (unequal-width) bands. The price axis labels
  // carry the non-uniform spacing instead. Price line stays pinned at centre.
  const strikeStep = (s.strikes[1] ?? 0) - (s.strikes[0] ?? 0) || 1; // edge-mode scale only
  const lastStrike = s.strikes.length - 1;
  // Continuous band coordinate for any price (interpolates within its band).
  const bandCoordOf = (price: number): number => {
    if (price <= s.strikes[0]!) {
      return (price - s.strikes[0]!) / ((s.strikes[1]! - s.strikes[0]!) || 1);
    }
    if (price >= s.strikes[lastStrike]!) {
      return lastStrike + (price - s.strikes[lastStrike]!) / ((s.strikes[lastStrike]! - s.strikes[lastStrike - 1]!) || 1);
    }
    for (let i = 0; i < lastStrike; i++) {
      const lo = s.strikes[i]!;
      const hi = s.strikes[i + 1]!;
      if (price < hi) return i + (price - lo) / (hi - lo);
    }
    return lastStrike;
  };
  const centerCoord = bandCoordOf(s.price);
  const coordMin = centerCoord - visBands / 2 + yOffset;
  const coordMax = centerCoord + visBands / 2 + yOffset;
  const coordSpan = coordMax - coordMin || 1;
  const yOf = (price: number) => PAD_T + ((coordMax - bandCoordOf(price)) / coordSpan) * plotH;

  // Only bands/strikes inside the band-index window are drawn.
  const visibleStrikes = s.strikes.filter((_, i) => i >= coordMin - 1 && i <= coordMax + 1);
  const visibleBands = s.bands.filter((b) => b.idx >= coordMin - 1 && b.idx <= coordMax + 1);

  // Sliding time window anchored on `now`: the "now" marker stays put at a fixed
  // screen x and the columns flow leftward through it as time advances.
  const winStart = s.now - WIN_PAST + xOffset;
  const winEnd = s.now + winFuture + xOffset;
  const tSpan = winEnd - winStart; // constant

  // Only the columns inside (or straddling) the window are drawn.
  const visibleEpochs = s.epochs.filter(
    (e) => e.end >= winStart && e.start <= winEnd,
  );

  const xOf = (t: number) => PAD_L + ((t - winStart) / tSpan) * plotW;

  const nowX = xOf(s.now);
  const priceY = yOf(s.price);

  // Expected-move cone: ±1σ band fanning out from current price into the future.
  const coneUpper: string[] = [];
  const coneLower: string[] = [];
  if (winEnd > s.now) {
    const steps = 16;
    const startT = Math.max(s.now, winStart);
    for (let i = 0; i <= steps; i++) {
      const t = startT + ((winEnd - startT) * i) / steps;
      const sig = s.sigmaAtTime(t);
      const x = xOf(t).toFixed(1);
      coneUpper.push(`${x},${yOf(s.price + sig).toFixed(1)}`);
      coneLower.push(`${x},${yOf(s.price - sig).toFixed(1)}`);
    }
  }
  const conePath = coneUpper.length > 0 ? `M${coneUpper.join(' L')} L${[...coneLower].reverse().join(' L')} Z` : '';

  // Probability isolines: equal-probability contours = price ± k·σ(t) across the
  // future window. Together they form the expected-range corridor.
  const isoSteps = 20;
  const isoline = (k: number, side: 1 | -1) => {
    const pts: string[] = [];
    if (winEnd > s.now) {
      const startT = Math.max(s.now, winStart);
      for (let i = 0; i <= isoSteps; i++) {
        const t = startT + ((winEnd - startT) * i) / isoSteps;
        pts.push(`${xOf(t).toFixed(1)},${yOf(s.price + side * k * s.sigmaAtTime(t)).toFixed(1)}`);
      }
    }
    return pts.join(' ');
  };
  const isoLevels = [0.5, 1, 1.5];

  // Header analytics: 1σ move one epoch out, implied vol, and realized vol.
  const horizonSig = s.sigmaAtTime(s.now + EPOCH_MS);
  const ivPct = (horizonSig / s.price) * Math.sqrt(SECONDS_PER_YEAR / 60) * 100;
  const rvPct = realizedVol(s.history);
  const ivRv = rvPct > 0 ? ivPct / rvPct : 0;
  const rich = ivRv >= 1.1 ? 'RICH' : ivRv > 0 && ivRv <= 0.9 ? 'CHEAP' : 'FAIR';

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

  // OHLC candles aggregated from ticks into fixed-time buckets. Heikin-Ashi
  // smooths each candle off the previous HA open/close.
  const candles = (() => {
    if (!isCandle) return [];
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
    const raw = [...buckets.values()].sort((x, y) => x.t - y.t);
    if (chartStyle === 'candles') return raw;
    // Heikin-Ashi
    const ha: typeof raw = [];
    let pO: number | undefined;
    let pC: number | undefined;
    for (const r of raw) {
      const close = (r.o + r.h + r.l + r.c) / 4;
      const open = pO === undefined ? (r.o + r.c) / 2 : (pO + pC!) / 2;
      ha.push({ o: open, c: close, h: Math.max(r.h, open, close), l: Math.min(r.l, open, close), t: r.t });
      pO = open;
      pC = close;
    }
    return ha;
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
    if (dragMode.current === 'add' && !s.hasLeg(key)) {
      s.addLeg(epoch, band);
    }
    if (dragMode.current === 'remove' && s.hasLeg(key)) {
      s.removeLeg(key);
    }
  };

  return (
    <div className="flex flex-col h-full w-full">
      <style>{`
        @keyframes gridWinErupt {
          0% {
            transform: scale(1);
            box-shadow: 0 0 0 0 rgba(11,153,129,0);
            background: rgba(11,153,129,0.16);
            border-color: #0b9981;
          }
          10% {
            transform: scale(1.06);
            box-shadow: 0 0 0 6px rgba(11,153,129,0.5), 0 0 50px 12px rgba(11,153,129,0.55), inset 0 0 20px rgba(25,230,189,0.3);
            background: rgba(25,230,189,0.85);
            border-color: #19e6bd;
          }
          28% {
            transform: scale(1.03);
            box-shadow: 0 0 0 3px rgba(11,153,129,0.3), 0 0 28px 6px rgba(11,153,129,0.35);
            background: rgba(11,153,129,0.75);
          }
          65% {
            transform: scale(1.01);
            box-shadow: 0 0 0 1px rgba(11,153,129,0.15), 0 0 12px 2px rgba(11,153,129,0.2);
            background: rgba(11,153,129,0.6);
          }
          100% {
            transform: scale(1);
            box-shadow: 0 0 6px 1px rgba(11,153,129,0.12);
            background: rgba(11,153,129,0.5);
            border-color: #0b9981;
          }
        }
        .animate-win-erupt {
          animation: gridWinErupt 1.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          z-index: 30;
        }
        @keyframes gridFallOut {
          0% {
            transform: translate3d(0,0,0) rotate(0deg) scale(1);
            opacity: 1;
            filter: blur(0px);
          }
          18% {
            transform: translate3d(0,-7px,0) rotate(-1.5deg) scale(1.025);
            opacity: 1;
          }
          100% {
            transform: translate3d(0,150px,0) rotate(12deg) scale(0.72);
            opacity: 0;
            filter: blur(1px);
          }
        }
        @keyframes gridSettleShadow {
          0% { box-shadow: 0 0 0 rgba(0,0,0,0); }
          35% { box-shadow: 0 10px 22px rgba(0,0,0,0.35); }
          100% { box-shadow: 0 16px 28px rgba(0,0,0,0); }
        }
        .animate-fall-out {
          animation:
            gridFallOut 0.95s cubic-bezier(0.22, 0.72, 0.16, 1) forwards,
            gridSettleShadow 0.95s ease-out forwards;
          transform-origin: 50% 50%;
        }
      `}</style>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-border-subtle">
        {/* Cell display mode */}
        <div className="flex items-center rounded-[5px] p-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          {(['mult', 'edge'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setCellMode(m)}
              className="px-2 py-0.5 rounded-[4px] text-[10px] font-medium transition-colors"
              style={{
                background: cellMode === m ? 'rgba(128,125,254,0.2)' : 'transparent',
                color: cellMode === m ? '#a6a3ff' : 'var(--color-text-quaternary)',
              }}
            >
              {m === 'mult' ? 'Payoff' : 'Edge'}
            </button>
          ))}
        </div>

        {/* Zoom */}
        <div className="flex items-center gap-0.5 rounded-[5px] p-0.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <button onClick={() => setVisBands((b) => Math.max(6, b - 1))} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[11px] font-bold" title="Zoom in">+</button>
          <button onClick={() => setVisBands((b) => Math.min(22, b + 1))} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[11px] font-bold" title="Zoom out">−</button>
          <button onClick={() => setYOffset((y) => y + 1)} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[9px]" title="Pan up">▲</button>
          <button onClick={() => setYOffset((y) => y - 1)} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[9px]" title="Pan down">▼</button>
          <button onClick={() => setXOffset((x) => x - 15_000)} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[9px]" title="Pan left">◀</button>
          <button onClick={() => setXOffset((x) => x + 15_000)} className="flex items-center justify-center w-5 h-5 rounded-[3px] text-text-tertiary hover:text-text-primary text-[9px]" title="Pan right">▶</button>
        </div>

        {(yOffset !== 0 || xOffset !== 0 || visBands !== 14 || winFuture !== 6 * EPOCH_MS) && (
          <button
            onClick={() => { setYOffset(0); setXOffset(0); setVisBands(14); setWinFuture(6 * EPOCH_MS); }}
            className="text-[10px] text-text-quaternary hover:text-text-tertiary transition-colors"
          >
            Reset
          </button>
        )}

        {/* IV chip — informational only */}
        <span className="text-[10px] text-text-quaternary ml-1" style={{ fontFamily: 'var(--font-mono)' }}>
          IV {ivPct.toFixed(0)}%
          {rich !== 'FAIR' && (
            <span style={{ color: rich === 'RICH' ? '#f23546' : '#19e6bd' }}> · {rich}</span>
          )}
        </span>

        {/* chart style */}
        <div className="flex items-center rounded-[5px] p-0.5 ml-auto" style={{ background: 'rgba(255,255,255,0.04)' }}>
          {(['line', 'candles', 'heikin', 'area'] as const).map((style) => (
            <button
              key={style}
              onClick={() => setChartStyle(style)}
              className="px-2 py-0.5 rounded-[4px] text-[10px] font-medium transition-colors"
              style={{
                background: chartStyle === style ? 'rgba(128,125,254,0.2)' : 'transparent',
                color: chartStyle === style ? '#a6a3ff' : 'var(--color-text-quaternary)',
              }}
            >
              {style === 'line' ? 'Line' : style === 'candles' ? 'Candle' : style === 'heikin' ? 'HA' : 'Area'}
            </button>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div ref={ref} className="relative flex-1 overflow-hidden select-none">
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
        <polyline points={coneUpper.join(' ')} fill="none" stroke="rgba(128,125,254,0.3)" strokeWidth={1} strokeDasharray="2 3" />
        <polyline points={coneLower.join(' ')} fill="none" stroke="rgba(128,125,254,0.3)" strokeWidth={1} strokeDasharray="2 3" />

        {/* Probability isolines */}
        {showIso &&
          isoLevels.flatMap((k) =>
            ([1, -1] as const).map((side) => (
              <polyline
                key={`iso${k}-${side}`}
                points={isoline(k, side)}
                fill="none"
                stroke="#a6a3ff"
                strokeWidth={k === 1 ? 1.4 : 1}
                strokeLinecap="round"
                opacity={k === 0.5 ? 0.7 : k === 1 ? 0.5 : 0.3}
                filter="url(#priceGlow)"
              />
            )),
          )}
      </svg>

      {/* Cells — every visible epoch (past = settled, current/future = tradeable) */}
      {visibleEpochs.map((epoch) => {
        const isPast = epoch.end <= s.now;
        return visibleBands.map((band) => {
          const cell = s.cellFor(epoch, band);
          const rawLeft = xOf(epoch.start);
          const rawCw = xOf(epoch.end) - rawLeft;
          const rawTop = yOf(band.upper);
          const rawCh = yOf(band.lower) - rawTop;
          const base = cellColors[cell.state];
          // Your-model EV vs the priced multiplier. A tilt (you expect calmer
          // realized vol than implied) makes centre bands underpriced → +EV,
          // tails overpriced → −EV.
          let ev = 0;
          let c: { bg: string; border: string; opacity: number } = base;
          if (cell.state === 'available') {
            const mid = (band.lower + band.upper) / 2;
            const closeness = Math.exp(-0.5 * ((mid - s.price) / (3 * strikeStep)) ** 2);
            const yourProb = Math.max(0, Math.min(1, cell.prob * (1 + 0.18 * (2 * closeness - 1))));
            ev = yourProb * cell.cost * cell.multiplier - cell.cost;
            const f = cellMode === 'edge' ? edgeFill(ev) : heatFill(cell.prob);
            c = { ...base, bg: f.bg, border: f.border };
          }
          const isFuture = epoch.start > s.now;
          const isLive = !isFuture && !isPast;
          const key = `${epoch.id}:${band.idx}`;
          const animInfo = animatingKeys.get(key);
          const isAnimating = Boolean(animInfo);
          const isErupting = eruptingWinKeys.has(key);
          const isActive = isAnimating || isErupting;

          // Freeze cell position the first tick an animation starts so time-drift
          // doesn't jitter the element while the keyframe runs.
          if (isActive && !animFrozenPos.current.has(key)) {
            animFrozenPos.current.set(key, {
              left: rawLeft + 1,
              top: rawTop + 1,
              width: Math.max(0, rawCw - 2),
              height: Math.max(0, rawCh - 2),
            });
          } else if (!isActive && animFrozenPos.current.has(key)) {
            animFrozenPos.current.delete(key);
          }
          const frozen = animFrozenPos.current.get(key);
          const left = frozen?.left ?? rawLeft + 1;
          const top = frozen?.top ?? rawTop + 1;
          const cw = frozen?.width ?? Math.max(0, rawCw - 2);
          const ch = frozen?.height ?? Math.max(0, rawCh - 2);

          const big = cw > 46 && ch > 22;
          const fs = Math.max(10, Math.min(16, Math.min(cw * 0.155, ch * 0.65)));
          const fsSub = Math.max(9, fs * 0.82);
          const isFocused = epoch.id === s.focusedEpoch;
          const isPastChosen = isPast && s.legs.has(key) && animatedCellsRef.current.has(key);
          const animTone =
            animInfo?.tone === 'win'
              ? { bg: 'rgba(245,193,66,0.34)', border: '#f5c142', color: '#f5c142' }
              : animInfo?.tone === 'lose'
                ? { bg: 'rgba(242,53,70,0.2)', border: '#f23546', color: '#f23546' }
                : null;
          return (
            <div
              key={key}
              id={`cell-${epoch.id}-${band.idx}`}
              onPointerDown={!isFuture ? undefined : () => onCellDown(epoch, band)}
              onPointerEnter={(e) => {
                if (isFuture) onCellEnter(epoch, band);
                const rect = ref.current?.getBoundingClientRect();
                setHover({
                  lower: band.lower,
                  upper: band.upper,
                  prob: cell.prob,
                  mult: cell.multiplier,
                  cost: cell.cost,
                  mx: rect ? e.clientX - rect.left : 0,
                  my: rect ? e.clientY - rect.top : 0,
                  locked: isLive,
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
              onClick={!isFuture ? undefined : () => s.setFocusedEpoch(epoch.id)}
              className={`absolute flex flex-col items-center justify-center ${
                isActive ? '' : 'transition-colors'
              } ${isAnimating ? 'animate-fall-out' : isErupting ? 'animate-win-erupt' : ''}`}
              style={{
                left,
                top,
                width: cw,
                height: ch,
                background: animTone?.bg ?? c.bg,
                border: `1px solid ${animTone?.border ?? c.border}`,
                borderRadius: 4,
                opacity: isPastChosen && !isAnimating ? 0 : c.opacity,
                cursor: isFuture ? 'pointer' : 'default',
                outline: isFocused && isFuture ? '1px solid rgba(128,125,254,0.35)' : 'none',
                outlineOffset: -1,
                color: animTone?.color,
                zIndex: isAnimating ? 50 : undefined,
                willChange: isActive ? 'transform, opacity, box-shadow' : undefined,
              }}
            >
              {!isAnimating && !isLive && big && cell.state === 'available' && (
                <span
                  className="font-semibold whitespace-nowrap"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: fs,
                    lineHeight: 1.1,
                    color: cellMode === 'edge'
                      ? ev >= 0 ? '#19e6bd' : '#f23546'
                      : 'var(--color-text-tertiary)',
                  }}
                >
                  {cellMode === 'edge'
                    ? `${ev >= 0 ? '+' : '−'}$${Math.abs(ev).toFixed(1)}`
                    : `${cell.multiplier.toFixed(2)}x`}
                </span>
              )}
              {!isAnimating && !isLive && big && cell.state === 'selected' && (
                <>
                  <span className="font-bold text-text-primary whitespace-nowrap" style={{ fontSize: fs, lineHeight: 1.1 }}>{cell.multiplier.toFixed(2)}x</span>
                  <span className="text-accent-light whitespace-nowrap" style={{ fontFamily: 'var(--font-mono)', fontSize: fsSub, lineHeight: 1.1 }}>
                    ${s.stake.toFixed(0)} → ${(s.stake * cell.multiplier).toFixed(0)}
                  </span>
                </>
              )}
              {!isAnimating && big && cell.state === 'active' && (
                <span
                  className="font-bold whitespace-nowrap"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: fs,
                    lineHeight: 1.1,
                    color: (cell.uPnl ?? 0) >= 0 ? '#0b9981' : '#f23546',
                  }}
                >
                  {(cell.uPnl ?? 0) >= 0 ? '+$' : '−$'}
                  {Math.abs(cell.uPnl ?? 0).toFixed(2)}
                </span>
              )}
              {!isAnimating && big && cell.state === 'claimable' && (
                <>
                  <span className="font-bold uppercase tracking-wider animate-pulse whitespace-nowrap" style={{ color: '#f5c142', fontSize: fsSub, lineHeight: 1.1 }}>
                    Claim
                  </span>
                  <span className="font-bold whitespace-nowrap" style={{ fontFamily: 'var(--font-mono)', fontSize: fsSub, lineHeight: 1.1, color: '#f5c142' }}>
                    +${(cell.uPnl ?? 0).toFixed(2)}
                  </span>
                </>
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
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#19e6bd" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#19e6bd" stopOpacity={0} />
          </linearGradient>
        </defs>

        {chartStyle === 'area' && areaPath && (
          <path d={areaPath} fill="url(#areaFill)" stroke="none" />
        )}

        {!isCandle && linePts && (
          <>
            <polyline points={linePts} fill="none" stroke="#0b9981" strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" opacity={0.28} filter="url(#priceGlow)" />
            <polyline points={linePts} fill="none" stroke="#19e6bd" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}

        {isCandle &&
          candles.map((cd, i) => {
            const up = cd.c >= cd.o;
            const col = up ? '#19e6bd' : '#f23546';
            const forming = i === candles.length - 1;
            const cx = xOf(cd.t + CANDLE_MS / 2);
            const bodyTop = Math.min(yOf(cd.o), yOf(cd.c));
            const bodyH = Math.max(1.2, Math.abs(yOf(cd.c) - yOf(cd.o)));
            const bw = forming ? candleW + 1 : candleW;
            return (
              <g key={cd.t} filter={forming ? 'url(#priceGlow)' : undefined} opacity={forming ? 1 : 0.92}>
                <line x1={cx} x2={cx} y1={yOf(cd.h)} y2={yOf(cd.l)} stroke={col} strokeWidth={forming ? 1.3 : 1} strokeLinecap="round" />
                <rect x={cx - bw / 2} y={bodyTop} width={bw} height={bodyH} rx={1} fill={up ? `${col}26` : col} stroke={col} strokeWidth={1.1} />
              </g>
            );
          })}

        <line x1={PAD_L} x2={w - PAD_R} y1={priceY} y2={priceY} stroke="rgba(255,255,255,0.45)" strokeWidth={1} strokeDasharray="4 4" />
        <line x1={nowX} x2={nowX} y1={PAD_T} y2={h - PAD_B} stroke="#807dfe" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
        <circle cx={nowX} cy={priceY} r={6} fill="#19e6bd" opacity={0.3} filter="url(#priceGlow)" />
        <circle cx={nowX} cy={priceY} r={3.5} fill="#19e6bd">
          <animate attributeName="r" values="3.5;4.5;3.5" dur="1.8s" repeatCount="indefinite" />
        </circle>
      </svg>

      {/* price axis labels (right) */}
      {visibleStrikes.map((p) => (
        <span
          key={`pl${p}`}
          className="absolute text-[11px] text-text-quaternary pointer-events-none"
          style={{ right: 6, top: yOf(p) - 7, fontFamily: 'var(--font-mono)' }}
        >
          {p.toFixed(0)}
        </span>
      ))}

      {/* live price chip */}
      <span
        className="absolute text-[12px] font-bold text-white px-1.5 py-0.5 rounded-[4px] pointer-events-none"
        style={{ right: 2, top: priceY - 10, background: '#0b9981', fontFamily: 'var(--font-mono)' }}
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
            className={`absolute text-[11px] pointer-events-none flex flex-col items-center ${
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
                className="absolute z-20 flex items-center gap-1 px-2 py-0.5 rounded-[4px] text-[10px] font-bold uppercase tracking-widest"
                style={{
                  left: left + cw / 2,
                  top: PAD_T + 2,
                  transform: 'translateX(-50%)',
                  background: 'rgba(128,125,254,0.18)',
                  color: '#a6a3ff',
                }}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-bullish-green animate-pulse" style={{ boxShadow: '0 0 8px #0b9981' }} />
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
          className="absolute z-20 pointer-events-none rounded-xl border border-white/10 bg-[#0a0c16]/85 backdrop-blur-md px-3.5 py-2 shadow-2xl"
          style={{
            left: Math.min(hover.mx + 14, w - 175),
            top: Math.min(hover.my + 14, h - 90),
          }}
        >
          <div className="text-[11px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
            ${hover.lower.toLocaleString()} – ${hover.upper.toLocaleString()}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[10px]" style={{ fontFamily: 'var(--font-mono)' }}>
            <span className="text-text-tertiary flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand-violet" />
              {(hover.prob * 100).toFixed(0)}%
            </span>
            <span className="text-bullish-green font-bold">{hover.mult.toFixed(2)}x</span>
            <span className="text-text-secondary">${hover.cost.toFixed(2)}</span>
          </div>
          {hover.locked && (
            <div className="flex items-center gap-1 mt-1.5 text-[9px] font-semibold uppercase tracking-wider" style={{ color: '#a6a3ff' }}>
              <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
                <path d="M7.5 4.5H7V3C7 1.62 5.88.5 4.5.5S2 1.62 2 3v1.5H1.5C.95 4.5.5 4.95.5 5.5v3c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-3c0-.55-.45-1-1-1zm-4-1.5C3.5 2.12 3.88 1.5 4.5 1.5S5.5 2.12 5.5 3v1.5h-2V3z"/>
              </svg>
              Live · Betting closed
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
