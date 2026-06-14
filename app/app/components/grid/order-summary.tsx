import { useState } from 'react';
import type { GridState } from './use-grid-state';

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] uppercase tracking-wider text-text-quaternary">
        {label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span
          className="text-[12px] font-semibold"
          style={{ fontFamily: 'var(--font-mono)', color: color ?? 'var(--color-text-primary)' }}
        >
          {value}
        </span>
        {sub && (
          <span className="text-[10px] text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
            {sub}
          </span>
        )}
      </span>
    </div>
  );
}

export default function OrderSummary({ s }: { s: GridState }) {
  const { stats, legsArr } = s;
  const [slipOpen, setSlipOpen] = useState(false);
  const [slip, setSlip] = useState('1.0');

  const hasLegs = legsArr.length > 0;
  const breakevenStr =
    stats.breakevens.length > 0
      ? stats.breakevens.map((b) => `$${b.toFixed(0)}`).join(' / ')
      : '—';

  return (
    <div className="flex flex-col h-full text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <span className="text-text-secondary font-semibold">Order Summary</span>
        <span className="text-text-quaternary">
          {stats.legCount} leg{stats.legCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2.5 flex-1 overflow-auto">
        <Stat label="Total cost" value={`$${stats.totalCost.toFixed(2)}`} />
        <Stat
          label="Max profit"
          value={`$${stats.maxProfit.toFixed(2)}`}
          sub={hasLegs ? `+${stats.maxProfitPct.toFixed(0)}%` : undefined}
          color="#0b9981"
        />
        <Stat label="Max loss" value={`-$${Math.abs(stats.maxLoss).toFixed(2)}`} color="#f23546" />
        <Stat label="Breakeven" value={breakevenStr} />

        {/* slippage (collapsible) */}
        <button
          onClick={() => setSlipOpen((o) => !o)}
          className="flex items-center justify-between text-[10px] text-text-quaternary hover:text-text-tertiary transition-colors mt-1"
        >
          <span className="uppercase tracking-wider">Slippage tolerance</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{slip}%</span>
        </button>
        {slipOpen && (
          <div className="flex items-center bg-surface-card rounded-[6px] px-2 py-1 border border-border-subtle">
            <input
              type="number"
              min={0}
              step={0.1}
              value={slip}
              onChange={(e) => setSlip(e.target.value)}
              className="flex-1 bg-transparent text-[12px] text-text-primary outline-none w-0"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
            <span className="text-text-quaternary text-[11px]">%</span>
          </div>
        )}

        {/* per-leg breakdown */}
        {hasLegs && (
          <div className="border-t border-border-subtle pt-2 mt-1 flex flex-col gap-1">
            {legsArr.map((l) => (
              <div key={l.key} className="flex items-center justify-between text-[10px]">
                <span className="text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${l.lower}–{l.upper}
                </span>
                <span className="text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${l.cost.toFixed(2)} → ${(l.cost * l.multiplier).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* actions */}
      <div className="px-3 pb-3 pt-1 shrink-0 flex flex-col gap-2">
        {hasLegs && (
          <button
            onClick={s.clearLegs}
            className="text-[10px] text-text-quaternary hover:text-bearish-red transition-colors self-end uppercase tracking-wider"
          >
            Clear all
          </button>
        )}
        <button
          disabled={!hasLegs}
          className="w-full py-2 text-[12px] font-semibold rounded-[8px] transition-opacity"
          style={{
            background: hasLegs ? '#807dfe' : 'var(--color-surface-hover)',
            color: hasLegs ? '#fff' : 'var(--color-text-quaternary)',
            cursor: hasLegs ? 'pointer' : 'not-allowed',
          }}
        >
          Confirm Order
        </button>
      </div>
    </div>
  );
}
