import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { IconCheck, IconPlus } from '@tabler/icons-react';
import type { GridState } from './use-grid-state';

// ── Compact payoff chart ──────────────────────────────────────────────────────

function PayoffChart({ s }: { s: GridState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 240, h: 96 });
  const [cursor, setCursor] = useState<{ x: number; price: number; pnl: number } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(ref.current);
    setSize({ w: ref.current.clientWidth, h: ref.current.clientHeight });
    return () => ro.disconnect();
  }, []);

  const pts = s.payoffPoints;
  const { w, h } = size;

  if (pts.length === 0) {
    return (
      <div ref={ref} className="flex items-center justify-center h-full text-[12px] text-text-quaternary">
        Select bands to see payoff
      </div>
    );
  }

  const P = 8;
  const PB = 16;
  const plotW = Math.max(1, w - P * 2);
  const plotH = Math.max(1, h - P - PB);

  const prices = pts.map((p) => p.price);
  const pnls = pts.map((p) => p.pnl);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  let yMin = Math.min(...pnls, 0);
  let yMax = Math.max(...pnls, 0);
  const yPad = (yMax - yMin) * 0.15 || 1;
  yMin -= yPad;
  yMax += yPad;

  const xOf = (price: number) => P + ((price - pMin) / (pMax - pMin || 1)) * plotW;
  const yOf = (pnl: number) => P + ((yMax - pnl) / (yMax - yMin || 1)) * plotH;
  const zeroY = yOf(0);

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

  let maxI = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]!.pnl > pts[maxI]!.pnl) maxI = i;
  const maxPt = pts[maxI]!;

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, (mx - P) / plotW));
    const price = pMin + frac * (pMax - pMin);
    // find closest point
    let ci = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i]!.price - price) < Math.abs(pts[ci]!.price - price)) ci = i;
    }
    const snap = pts[ci]!;
    setCursor({ x: xOf(snap.price), price: snap.price, pnl: snap.pnl });
  };

  const cursorDotY = cursor ? yOf(cursor.pnl) : 0;
  const tooltipRight = cursor && cursor.x > w / 2;

  return (
    <div ref={ref} className="relative h-full w-full">
      <svg
        width={w} height={h}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setCursor(null)}
        style={{ cursor: 'crosshair' }}
      >
        <path d={areaPos} fill="rgba(11,153,129,0.15)" />
        <path d={areaNeg} fill="rgba(242,53,70,0.12)" />
        <line x1={P} x2={w - P} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
        {s.stats.breakevens.map((b, i) => (
          <line key={i} x1={xOf(b)} x2={xOf(b)} y1={P} y2={h - PB} stroke="rgba(255,255,255,0.2)" strokeWidth={1} strokeDasharray="2 3" />
        ))}
        <path d={linePath} fill="none" stroke="#807dfe" strokeWidth={2} />
        <circle cx={xOf(maxPt.price)} cy={yOf(maxPt.pnl)} r={3} fill="#0b9981" />
        {s.stats.breakevens.map((b, i) => (
          <text key={`bl${i}`} x={xOf(b)} y={h - 2} fill="rgba(255,255,255,0.35)" fontSize={9} textAnchor="middle" style={{ fontFamily: 'var(--font-mono)' }}>
            ${b.toFixed(0)}
          </text>
        ))}
        {cursor && (
          <>
            <line x1={cursor.x} x2={cursor.x} y1={P} y2={h - PB} stroke="rgba(255,255,255,0.3)" strokeWidth={1} strokeDasharray="3 3" />
            <line x1={P} x2={w - P} y1={cursorDotY} y2={cursorDotY} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
            <circle cx={cursor.x} cy={cursorDotY} r={4} fill={cursor.pnl >= 0 ? '#0b9981' : '#f23546'} stroke="rgba(0,0,0,0.4)" strokeWidth={1.5} />
          </>
        )}
      </svg>

      {cursor && (
        <div
          className="absolute pointer-events-none px-2 py-1.5 rounded-[7px] text-[11px] leading-snug"
          style={{
            top: Math.max(4, Math.min(cursorDotY - 36, h - 60)),
            ...(tooltipRight ? { right: w - cursor.x + 8 } : { left: cursor.x + 8 }),
            background: 'var(--color-surface-card)',
            border: '1px solid var(--color-border-default)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <div className="text-text-quaternary">${cursor.price.toFixed(0)}</div>
          <div className="font-semibold" style={{ color: cursor.pnl >= 0 ? '#0b9981' : '#f23546' }}>
            {cursor.pnl >= 0 ? '+' : ''}{cursor.pnl.toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Right panel ───────────────────────────────────────────────────────────────

export default function RightPanel({ s }: { s: GridState }) {
  // true = require manual confirm before placing; false = auto-place on click
  const [confirmBets, setConfirmBets] = useState(false);
  const [cellAnim, setCellAnim] = useState<Record<string, 'pop' | 'fall'>>({});
  const [focusedLegKey, setFocusedLegKey] = useState<string | null>(null);

  const focusedEpoch =
    s.epochs.find((e) => e.id === s.focusedEpoch) ??
    s.epochs.find((e) => e.start > s.now) ??
    s.epochs[0];

  const bands = useMemo(() => [...s.bands].sort((a, b) => b.lower - a.lower), [s.bands]);

  const outcomes = useMemo(() => {
    let won = 0, lost = 0, open = 0;
    for (const l of s.legsArr) {
      const epoch = s.epochs.find((e) => e.id === l.epochId);
      if (!epoch || epoch.end > s.now) { open++; continue; }
      const settle = s.settleOf(epoch);
      if (settle === null) { open++; continue; }
      if (settle >= l.lower && settle < l.upper) won++;
      else lost++;
    }
    return { won, lost, open };
  }, [s.legsArr, s.epochs, s.now]);

  const activity = useMemo(() => {
    const items: {
      key: string;
      lower: number;
      upper: number;
      epochEnd: number;
      cost: number;
      won: boolean;
      pnl: number;
    }[] = [];
    for (const l of s.legsArr) {
      const epoch = s.epochs.find((e) => e.id === l.epochId);
      if (!epoch || epoch.end > s.now) continue;
      const settle = s.settleOf(epoch);
      if (settle === null) continue;
      const won = settle >= l.lower && settle < l.upper;
      items.push({
        key: l.key,
        lower: l.lower,
        upper: l.upper,
        epochEnd: epoch.end,
        cost: l.cost,
        won,
        pnl: won ? l.cost * (l.multiplier - 1) : -l.cost,
      });
    }
    return items.sort((a, b) => b.epochEnd - a.epochEnd).slice(0, 20);
  }, [s.legsArr, s.epochs, s.now]);

  const netPnl = activity.reduce((sum, a) => sum + a.pnl, 0);
  const openLegs = s.legsArr.filter((l) => {
    const epoch = s.epochs.find((e) => e.id === l.epochId);
    return epoch && epoch.end > s.now;
  });

  const activeBandRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeBandRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [s.price]);

  const focusedLeg = focusedLegKey ? s.legs.get(focusedLegKey) ?? null : null;
  const tradeSizeValue = focusedLeg ? focusedLeg.cost : s.stake;
  const setTradeSize = (v: number) => {
    if (focusedLegKey) s.updateLegCost(focusedLegKey, v);
    else s.setStake(v);
  };

  const handleBandClick = useCallback((epoch: typeof focusedEpoch, band: (typeof bands)[number]) => {
    if (!epoch || epoch.start <= s.now) return;
    const key = `${epoch.id}:${band.idx}`;
    const isSelected = s.hasLeg(key);
    setCellAnim((prev) => ({ ...prev, [key]: isSelected ? 'fall' : 'pop' }));
    if (isSelected) {
      if (focusedLegKey === key) {
        s.removeLeg(key);
        setFocusedLegKey(null);
      } else {
        setFocusedLegKey(key);
      }
    } else {
      s.addLeg(epoch, band);
      setFocusedLegKey(key);
    }
    setTimeout(() => setCellAnim((prev) => { const n = { ...prev }; delete n[key]; return n; }), 480);
  }, [s, focusedEpoch, focusedLegKey]);

  const fmtTime = (t: number) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Trade Size ── */}
      <div className="px-4 pt-5 pb-4 border-b border-border-subtle shrink-0">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">Trade Size</span>
          {focusedLeg && (
            <span className="text-[10px] text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
              ${focusedLeg.lower}–{focusedLeg.upper}
            </span>
          )}
        </div>
        <div
          className="flex items-center rounded-[10px] px-4 py-3 gap-2 mb-3"
          style={{
            background: 'var(--color-surface-card)',
            border: `1px solid ${focusedLeg ? 'rgba(128,125,254,0.4)' : 'var(--color-border-default)'}`,
          }}
        >
          <span className="text-text-quaternary text-[20px] font-light">$</span>
          <input
            type="number"
            min={0}
            value={String(tradeSizeValue)}
            onChange={(e) => setTradeSize(Math.max(0, parseFloat(e.target.value) || 0))}
            className="flex-1 bg-transparent text-[28px] font-semibold text-text-primary outline-none w-0"
            style={{ fontFamily: 'var(--font-mono)' }}
          />
          <span className="text-[12px] text-text-quaternary font-medium">USDC</span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {([5, 10, 25, 50, 'MAX'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setTradeSize(v === 'MAX' ? 1000 : Number(v))}
              className="py-2 rounded-[7px] text-[12px] font-semibold transition-all"
              style={{
                background: v !== 'MAX' && tradeSizeValue === v ? 'rgba(128,125,254,0.2)' : 'var(--color-surface-card)',
                color: v !== 'MAX' && tradeSizeValue === v ? '#a6a3ff' : 'var(--color-text-tertiary)',
                border: `1px solid ${v !== 'MAX' && tradeSizeValue === v ? 'rgba(128,125,254,0.4)' : 'var(--color-border-subtle)'}`,
              }}
            >
              {v === 'MAX' ? 'MAX' : `$${v}`}
            </button>
          ))}
        </div>
      </div>

      {/* ── Confirm bets toggle ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
        <span className="text-[13px] text-text-secondary">Confirm bets</span>
        <button
          onClick={() => setConfirmBets((v) => !v)}
          className="relative w-11 h-6 rounded-full transition-colors duration-200"
          style={{ background: confirmBets ? '#0b9981' : 'rgba(255,255,255,0.1)' }}
        >
          <span
            className="absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-200"
            style={{ left: confirmBets ? '22px' : '4px' }}
          />
        </button>
      </div>

      {/* ── Bands ── */}
      {focusedEpoch && (
        <div className="border-b border-border-subtle shrink-0">
          <style>{`
            @keyframes bandPop {
              0%   { transform: scale(1); }
              35%  { transform: scale(1.015); }
              100% { transform: scale(1); }
            }
            @keyframes bandFall {
              0%   { opacity: 1; }
              40%  { opacity: 0.4; }
              100% { opacity: 1; }
            }
          `}</style>
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">Bands</span>
            <span className="text-[11px] text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
              {fmtTime(focusedEpoch.start)}
            </span>
          </div>
          <div className="max-h-44 overflow-auto no-scrollbar">
            {bands.map((band) => {
              const cell = s.cellFor(focusedEpoch, band);
              const key = `${focusedEpoch.id}:${band.idx}`;
              const selected = s.hasLeg(key);
              const isFuture = focusedEpoch.start > s.now;
              const isPriceBand = s.price >= band.lower && s.price < band.upper;
              const anim = cellAnim[key];
              const isFocused = focusedLegKey === key;
              return (
                <button
                  key={band.idx}
                  ref={isPriceBand ? activeBandRef : undefined}
                  onClick={() => handleBandClick(focusedEpoch, band)}
                  className="relative flex items-center w-full px-4 py-2 text-left overflow-hidden hover:bg-white/[0.02] transition-colors"
                  style={{
                    cursor: isFuture ? 'pointer' : 'default',
                    borderLeft: `2px solid ${isFocused ? '#a6a3ff' : isPriceBand ? '#807dfe' : 'transparent'}`,
                    background: isFocused ? 'rgba(128,125,254,0.06)' : 'transparent',
                    animation: anim ? `${anim === 'pop' ? 'bandPop' : 'bandFall'} 0.48s cubic-bezier(0.34,1.56,0.64,1)` : undefined,
                  }}
                >
                  {/* probability bar */}
                  <div
                    className="absolute inset-y-0 left-0 transition-[width] duration-500 pointer-events-none"
                    style={{
                      width: `${Math.min(100, cell.prob * 130)}%`,
                      background: isPriceBand ? 'rgba(128,125,254,0.1)' : 'rgba(255,255,255,0.03)',
                    }}
                  />
                  {/* pulsing ring on live-price band */}
                  {isPriceBand && (
                    <div className="absolute inset-0 pointer-events-none animate-pulse" style={{ boxShadow: 'inset 0 0 0 1px rgba(128,125,254,0.3)' }} />
                  )}
                  <span className="relative flex-1 text-[12px] text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                    ${band.lower}–{band.upper}
                  </span>
                  <span
                    key={cell.multiplier.toFixed(1)}
                    className="relative text-[12px] mr-4"
                    style={{ fontFamily: 'var(--font-mono)', color: '#0b9981' }}
                  >
                    {cell.multiplier.toFixed(1)}x
                  </span>
                  <span className="relative text-[12px] text-text-quaternary w-8 text-right" style={{ fontFamily: 'var(--font-mono)' }}>
                    {(cell.prob * 100).toFixed(0)}%
                  </span>
                  <span
                    className="relative flex items-center justify-center w-5 h-5 rounded-[4px] ml-2 shrink-0"
                    style={{
                      background: selected ? '#807dfe' : 'rgba(255,255,255,0.06)',
                      color: selected ? '#fff' : 'var(--color-text-quaternary)',
                    }}
                  >
                    {selected ? <IconCheck size={11} stroke={2.5} /> : <IconPlus size={11} stroke={2.5} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Active Summary ── */}
      <div className="px-4 py-4 border-b border-border-subtle shrink-0">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">Active Summary</span>
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: '#0b9981' }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block animate-pulse" style={{ background: '#0b9981' }} />
            LIVE
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-quaternary mb-1">Total Stake</div>
            <div className="text-[20px] font-bold text-text-primary leading-none" style={{ fontFamily: 'var(--font-mono)' }}>
              {openLegs.reduce((sum, l) => sum + l.cost, 0).toFixed(2)}
              <span className="text-[10px] text-text-quaternary ml-1 font-normal">USDC</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-quaternary mb-1">Net P&amp;L</div>
            <div
              className="text-[20px] font-bold leading-none"
              style={{ fontFamily: 'var(--font-mono)', color: netPnl >= 0 ? '#0b9981' : '#f23546' }}
            >
              {netPnl >= 0 ? '+' : ''}{netPnl.toFixed(2)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-5 mb-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Won</span>
            <span className="text-[18px] font-bold" style={{ fontFamily: 'var(--font-mono)', color: '#0b9981' }}>{outcomes.won}</span>
          </div>
          <div className="w-px h-8 bg-border-subtle" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Lost</span>
            <span className="text-[18px] font-bold" style={{ fontFamily: 'var(--font-mono)', color: '#f23546' }}>{outcomes.lost}</span>
          </div>
          <div className="w-px h-8 bg-border-subtle" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Open</span>
            <span className="text-[18px] font-bold text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>{outcomes.open}</span>
          </div>
        </div>

        {/* Confirm Order button — shown when toggle is ON (manual confirm required) and legs exist */}
        {openLegs.length > 0 && confirmBets && (
          <button
            onClick={s.clearLegs}
            className="w-full py-3 text-[14px] font-semibold rounded-[10px] text-white transition-all hover:opacity-90"
            style={{ background: '#807dfe' }}
          >
            Confirm Order · {openLegs.length} leg{openLegs.length !== 1 ? 's' : ''}
          </button>
        )}
      </div>

      {/* ── Recent Activity ── */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="flex items-center px-4 py-2.5 border-b border-border-subtle shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">Recent Activity</span>
        </div>
        {activity.length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-[13px] text-text-quaternary">No history yet</div>
        ) : (
          <div className="flex-1 overflow-auto no-scrollbar">
            {activity.map((item) => (
              <div
                key={item.key}
                className="flex items-start justify-between px-4 py-3 border-b hover:bg-surface-hover/10 transition-colors"
                style={{ borderColor: 'var(--color-border-subtle)' }}
              >
                <div className="flex flex-col gap-1">
                  <span className="text-[12px] font-bold uppercase tracking-wider" style={{ color: item.won ? '#0b9981' : '#f23546' }}>
                    {item.won ? 'WON' : 'LOST'}
                  </span>
                  <span className="text-[11px] text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                    ${item.lower}–{item.upper}
                  </span>
                  <span className="text-[11px] text-text-quaternary">
                    Bet: ${item.cost.toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-[11px] text-text-quaternary">{fmtTime(item.epochEnd)}</span>
                  <span
                    className="text-[15px] font-semibold"
                    style={{ fontFamily: 'var(--font-mono)', color: item.won ? '#0b9981' : '#f23546' }}
                  >
                    {item.won ? '+' : '−'}${Math.abs(item.pnl).toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Payoff diagram ── */}
      {s.payoffPoints.length > 0 && (
        <div className="h-52 shrink-0 border-t border-border-subtle">
          <PayoffChart s={s} />
        </div>
      )}
    </div>
  );
}
