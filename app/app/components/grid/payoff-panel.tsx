import { useEffect, useRef, useState } from 'react';
import { IconX } from '@tabler/icons-react';
import type { GridState } from './use-grid-state';
import { pnlAtPrice } from './payoff';

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 200 });
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

function PayoffDiagram({ s }: { s: GridState }) {
  const { ref, w, h } = useSize();
  const pts = s.payoffPoints;
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);

  if (pts.length === 0) {
    return (
      <div
        ref={ref}
        className="flex items-center justify-center h-full text-[11px] text-text-quaternary uppercase tracking-widest"
      >
        Select bands to see payoff
      </div>
    );
  }

  const PAD = 10;
  const PAD_B = 16;
  const plotW = Math.max(1, w - PAD * 2);
  const plotH = Math.max(1, h - PAD - PAD_B);

  const prices = pts.map((p) => p.price);
  const pnls = pts.map((p) => p.pnl);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  let yMin = Math.min(...pnls, 0);
  let yMax = Math.max(...pnls, 0);
  const yPad = (yMax - yMin) * 0.12 || 1;
  yMin -= yPad;
  yMax += yPad;

  const xOf = (price: number) =>
    PAD + ((price - pMin) / (pMax - pMin || 1)) * plotW;
  const yOf = (pnl: number) =>
    PAD + ((yMax - pnl) / (yMax - yMin || 1)) * plotH;

  const zeroY = yOf(0);
  const hoverPnl = hoverPrice == null ? null : pnlAtPrice(s.legsArr, hoverPrice);
  const hoverPt = hoverPrice == null || hoverPnl == null ? null : { price: hoverPrice, pnl: hoverPnl };

  // Build the step area split at the zero line for green/red fills.
  const linePath = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.price).toFixed(1)} ${yOf(p.pnl).toFixed(1)}`)
    .join(' ');

  const areaPos =
    `M${xOf(pts[0]!.price).toFixed(1)} ${zeroY.toFixed(1)} ` +
    pts.map((p) => `L${xOf(p.price).toFixed(1)} ${yOf(Math.max(0, p.pnl)).toFixed(1)}`).join(' ') +
    ` L${xOf(pts[pts.length - 1]!.price).toFixed(1)} ${zeroY.toFixed(1)} Z`;

  const areaNeg =
    `M${xOf(pts[0]!.price).toFixed(1)} ${zeroY.toFixed(1)} ` +
    pts.map((p) => `L${xOf(p.price).toFixed(1)} ${yOf(Math.min(0, p.pnl)).toFixed(1)}`).join(' ') +
    ` L${xOf(pts[pts.length - 1]!.price).toFixed(1)} ${zeroY.toFixed(1)} Z`;

  // Max profit point.
  let maxI = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]!.pnl > pts[maxI]!.pnl) maxI = i;
  const maxPt = pts[maxI]!;

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, x / rect.width));
    setHoverPrice(pMin + frac * (pMax - pMin));
  };

  return (
    <div ref={ref} className="relative h-full w-full">
      <svg
        width={w}
        height={h}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverPrice(null)}
        className="cursor-crosshair"
      >
        <path d={areaPos} fill="rgba(11,153,129,0.18)" />
        <path d={areaNeg} fill="rgba(242,53,70,0.15)" />

        {/* zero line */}
        <line
          x1={PAD}
          x2={w - PAD}
          y1={zeroY}
          y2={zeroY}
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={1}
        />

        {/* breakeven verticals */}
        {s.stats.breakevens.map((b, i) => (
          <line
            key={i}
            x1={xOf(b)}
            x2={xOf(b)}
            y1={PAD}
            y2={h - PAD_B}
            stroke="rgba(255,255,255,0.3)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ))}

        {/* payoff step line */}
        <path d={linePath} fill="none" stroke="#807dfe" strokeWidth={1.75} />

        {/* hover crosshair + point */}
        {hoverPt && (
          <>
            <line
              x1={xOf(hoverPt.price)}
              x2={xOf(hoverPt.price)}
              y1={PAD}
              y2={h - PAD_B}
              stroke="rgba(255,255,255,0.32)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle cx={xOf(hoverPt.price)} cy={yOf(hoverPt.pnl)} r={4} fill="#807dfe" />
          </>
        )}

        {/* max profit marker */}
        <circle cx={xOf(maxPt.price)} cy={yOf(maxPt.pnl)} r={3} fill="#0b9981" />
        <text
          x={xOf(maxPt.price)}
          y={yOf(maxPt.pnl) - 6}
          fill="#0b9981"
          fontSize={9}
          textAnchor="middle"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          +${maxPt.pnl.toFixed(0)}
        </text>

        {/* breakeven labels */}
        {s.stats.breakevens.map((b, i) => (
          <text
            key={`bl${i}`}
            x={xOf(b)}
            y={h - 4}
            fill="rgba(255,255,255,0.5)"
            fontSize={9}
            textAnchor="middle"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            ${b.toFixed(0)}
          </text>
        ))}
      </svg>

      {hoverPt && (
        <div
          className="pointer-events-none absolute z-20 rounded-[6px] border border-border-default bg-[rgba(8,10,18,0.96)] px-2 py-1.5 shadow-2xl"
          style={{
            left: Math.min(Math.max(xOf(hoverPt.price) - 56, 12), w - 112),
            top: Math.max(12, yOf(hoverPt.pnl) - 6),
            width: 112,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[9px] uppercase tracking-wider text-text-quaternary">Hover</span>
            <span className="text-[10px] font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
              ${hoverPt.price.toFixed(0)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 mt-0.5">
            <span className="text-[9px] text-text-tertiary">PnL</span>
            <span
              className="text-[10px] font-semibold"
              style={{
                fontFamily: 'var(--font-mono)',
                color: hoverPt.pnl >= 0 ? '#0b9981' : '#f23546',
              }}
            >
              {hoverPt.pnl >= 0 ? '+' : '−'}${Math.abs(hoverPt.pnl).toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PayoffPanel({ s }: { s: GridState }) {
  const { legsArr } = s;

  return (
    <div className="flex h-full text-[11px]">
      {/* Left — legs list */}
      <div className="flex flex-col w-[46%] min-w-0 border-r border-border-subtle">
        <div className="px-3 py-2 border-b border-border-subtle shrink-0">
          <span className="text-text-secondary font-semibold">Legs</span>
        </div>
        <div className="grid grid-cols-[1.3fr_0.6fr_0.8fr_auto] gap-1 px-3 py-1 text-[9px] uppercase tracking-wider text-text-quaternary border-b border-border-subtle shrink-0">
          <span>Band</span>
          <span className="text-right">Cost</span>
          <span className="text-right">Payout</span>
          <span className="w-4" />
        </div>
        <div className="flex-1 overflow-auto">
          {legsArr.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[10px] text-text-quaternary uppercase tracking-widest p-4 text-center">
              No legs selected
            </div>
          ) : (
            legsArr.map((l) => (
              <div
                key={l.key}
                className="grid grid-cols-[1.3fr_0.6fr_0.8fr_auto] gap-1 items-center px-3 py-1.5 border-b border-border-subtle/50"
              >
                <span className="text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${l.lower}–{l.upper}
                </span>
                <span className="text-right text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${l.cost.toFixed(2)}
                </span>
                <span className="text-right text-bullish-green" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${(l.cost * l.multiplier).toFixed(2)}
                </span>
                <button
                  onClick={() => s.removeLeg(l.key)}
                  className="flex items-center justify-center w-4 h-4 text-text-quaternary hover:text-bearish-red transition-colors"
                >
                  <IconX size={12} stroke={2.5} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right — payoff diagram */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="px-3 py-2 border-b border-border-subtle shrink-0">
          <span className="text-text-secondary font-semibold">Payoff</span>
        </div>
        <div className="flex-1 min-h-0">
          <PayoffDiagram s={s} />
        </div>
      </div>
    </div>
  );
}
