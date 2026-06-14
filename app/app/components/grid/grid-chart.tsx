import { useEffect, useRef, useState } from 'react';
import type { GridState } from './use-grid-state';
import type { Band, Epoch } from './types';

const PAD_T = 8;
const PAD_B = 22;
const PAD_L = 8;
const PAD_R = 54;

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

interface Hover {
  lower: number;
  upper: number;
  prob: number;
  mult: number;
  cost: number;
  mx: number;
  my: number;
}

export default function GridChart({ s }: { s: GridState }) {
  const { ref, w, h } = useSize();
  const [hover, setHover] = useState<Hover | null>(null);

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

  const priceMin = s.strikes[0]!;
  const priceMax = s.strikes[s.strikes.length - 1]!;
  const span = priceMax - priceMin || 1;

  const tStart = s.epochs[0]!.start;
  const tEnd = s.epochs[s.epochs.length - 1]!.end;
  const tSpan = tEnd - tStart || 1;

  const yOf = (price: number) => PAD_T + ((priceMax - price) / span) * plotH;
  const xOf = (t: number) => PAD_L + ((t - tStart) / tSpan) * plotW;

  const nowX = xOf(s.now);
  const priceY = yOf(s.price);

  const linePts = s.history
    .filter((p) => p.t >= tStart && p.t <= s.now)
    .map((p) => `${xOf(p.t).toFixed(1)},${yOf(p.price).toFixed(1)}`)
    .join(' ');

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
      {/* Behind: grid lines */}
      <svg className="absolute inset-0 pointer-events-none" width={w} height={h}>
        {s.strikes.map((p) => (
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
        {s.epochs.map((e) => (
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
      </svg>

      {/* Cells — every epoch (past = settled, current/future = tradeable) */}
      {s.epochs.map((epoch) => {
        const isPast = epoch.end <= s.now;
        return s.bands.map((band) => {
          const cell = s.cellFor(epoch, band);
          const left = xOf(epoch.start);
          const cw = xOf(epoch.end) - left;
          const top = yOf(band.upper);
          const ch = yOf(band.lower) - top;
          const c = cellColors[cell.state];
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
                  {(cell.uPnl ?? 0) >= 0 ? '+' : ''}
                  {(cell.uPnl ?? 0).toFixed(2)}
                </span>
              )}
            </div>
          );
        });
      })}

      {/* On top: price line + markers (non-interactive) */}
      <svg className="absolute inset-0 pointer-events-none" width={w} height={h}>
        {linePts && (
          <polyline
            points={linePts}
            fill="none"
            stroke="#0b9981"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
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
        <circle cx={nowX} cy={priceY} r={3.5} fill="#0b9981" />
      </svg>

      {/* price axis labels (right) */}
      {s.strikes.map((p) => (
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
      {s.epochs.map((e) => (
        <span
          key={`tl${e.id}`}
          className={`absolute text-[9px] pointer-events-none ${
            e.id === s.currentEpochId ? 'text-brand-violet font-bold' : 'text-text-quaternary'
          }`}
          style={{
            left: xOf(e.start),
            bottom: 4,
            transform: 'translateX(-50%)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {fmtTime(e.start)}
        </span>
      ))}

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
