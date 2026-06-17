import { useState } from 'react';
import type { GridState } from './use-grid-state';
import { computeAnalytics } from './analytics';

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
  const [legsOpen, setLegsOpen] = useState(false);
  // Manual stake per band ($ you pay for each leg). Win → stake × multiplier.
  // Global (in GridState) so it reprices cells, payoff and analytics too.
  const stake = s.stake;
  const stakeRaw = String(stake);
  const setStake = (v: string) => s.setStake(Math.max(0, parseFloat(v) || 0));

  const a = computeAnalytics(s);
  const hasLegs = legsArr.length > 0;
  const breakevenStr =
    stats.breakevens.length > 0
      ? stats.breakevens.map((b) => `$${b.toFixed(0)}`).join(' / ')
      : '—';

  // Group legs by band range so a 25-leg basket collapses to a few rows.
  // Cost/payout use the manual stake: each leg costs `stake`, wins stake×mult.
  const grouped = new Map<
    string,
    { lower: number; upper: number; count: number; cost: number; payout: number }
  >();
  for (const l of legsArr) {
    const k = `${l.lower}-${l.upper}`;
    const g =
      grouped.get(k) ?? { lower: l.lower, upper: l.upper, count: 0, cost: 0, payout: 0 };
    g.count += 1;
    g.cost += stake;
    g.payout += stake * l.multiplier;
    grouped.set(k, g);
  }
  const groups = [...grouped.values()].sort((x, y) => y.lower - x.lower);
  const totalCost = stake * legsArr.length;
  // Best-case payout: one band wins per epoch → the richest band's stake×mult.
  const bestPayout = legsArr.reduce((m, l) => Math.max(m, stake * l.multiplier), 0);

  return (
    <div className="flex flex-col h-full text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <span className="text-text-secondary font-semibold">Order Summary</span>
        <span className="text-text-quaternary">
          {stats.legCount} leg{stats.legCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2.5 flex-1 overflow-auto">
        {/* manual stake per band */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Stake / band</span>
          <div className="flex items-center bg-surface-card rounded-[6px] px-2 py-1 border border-border-subtle gap-1 w-24">
            <span className="text-text-quaternary text-[11px]">$</span>
            <input
              type="number"
              min={0}
              value={stakeRaw}
              onChange={(e) => setStake(e.target.value)}
              className="flex-1 bg-transparent text-[12px] font-medium text-text-primary outline-none w-0"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>
        </div>
        <div className="flex gap-1">
          {[5, 10, 25, 50].map((v) => (
            <button
              key={v}
              onClick={() => setStake(String(v))}
              className="flex-1 py-1 rounded-[5px] text-[10px] font-medium transition-colors"
              style={{
                background: stake === v ? 'var(--color-surface-hover)' : 'var(--color-surface-card)',
                color: stake === v ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                border: `1px solid ${stake === v ? 'var(--color-border-default)' : 'var(--color-border-subtle)'}`,
              }}
            >
              ${v}
            </button>
          ))}
        </div>

        {/* prominent EV + win probability */}
        {hasLegs && (
          <div className="grid grid-cols-2 gap-2 mb-1">
            <div className="flex flex-col gap-0.5 bg-surface-card/40 rounded-[8px] px-2.5 py-1.5">
              <span className="text-[9px] uppercase tracking-wider text-text-quaternary">Exp. value</span>
              <span
                className="text-[13px] font-bold"
                style={{ fontFamily: 'var(--font-mono)', color: a.ev >= 0 ? '#0b9981' : '#f23546' }}
              >
                {a.ev >= 0 ? '+$' : '−$'}{Math.abs(a.ev).toFixed(2)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 bg-surface-card/40 rounded-[8px] px-2.5 py-1.5">
              <span className="text-[9px] uppercase tracking-wider text-text-quaternary">Win prob</span>
              <span className="text-[13px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                {(a.winProb * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        )}

        <Stat label="Total cost" value={`$${totalCost.toFixed(2)}`} />
        <Stat label="Best payout" value={`$${bestPayout.toFixed(2)}`} color="#0b9981" />
        <Stat label="Max loss" value={`-$${totalCost.toFixed(2)}`} color="#f23546" />
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

        {/* grouped leg breakdown (collapsible) */}
        {hasLegs && (
          <div className="border-t border-border-subtle pt-2 mt-1 flex flex-col gap-1">
            <button
              onClick={() => setLegsOpen((o) => !o)}
              className="flex items-center justify-between text-[10px] text-text-quaternary hover:text-text-tertiary transition-colors"
            >
              <span className="uppercase tracking-wider">
                {groups.length} band{groups.length === 1 ? '' : 's'} · {legsArr.length} leg
                {legsArr.length === 1 ? '' : 's'}
              </span>
              <span>{legsOpen ? 'Hide' : 'Show'}</span>
            </button>

            {/* always show the grouped summary; expand for per-band detail */}
            {groups.map((g) => (
              <div
                key={`${g.lower}-${g.upper}`}
                className="flex items-center justify-between text-[10px]"
              >
                <span className="text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${g.lower}–{g.upper}
                  {g.count > 1 && <span className="text-text-quaternary"> ×{g.count}</span>}
                </span>
                <span className="text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${g.cost.toFixed(2)} → ${g.payout.toFixed(2)}
                </span>
              </div>
            ))}

            {legsOpen && legsArr.length > groups.length && (
              <div className="flex flex-col gap-0.5 mt-1 pl-2 border-l border-border-subtle">
                {legsArr.map((l) => (
                  <div key={l.key} className="flex items-center justify-between text-[9px] text-text-quaternary">
                    <span style={{ fontFamily: 'var(--font-mono)' }}>${l.lower}–{l.upper}</span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>
                      ${stake.toFixed(2)} → ${(stake * l.multiplier).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
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
