import { useState, useEffect, useRef } from 'react';
import type { GridState } from './use-grid-state';
import { computeAnalytics } from './analytics';

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] uppercase tracking-wider text-text-quaternary">{label}</span>
      <span
        className="text-[12px] font-semibold"
        style={{ fontFamily: 'var(--font-mono)', color: color ?? 'var(--color-text-primary)' }}
      >
        {value}
      </span>
    </div>
  );
}

function LegRow({
  legKey,
  lower,
  upper,
  cost,
  multiplier,
  onCostChange,
  onRemove,
}: {
  legKey: string
  lower: number
  upper: number
  cost: number
  multiplier: number
  onCostChange: (key: string, v: number) => void
  onRemove: (key: string) => void
}) {
  const [raw, setRaw] = useState(String(cost))
  const focused = useRef(false)

  // Sync display when cost changes externally, but never interrupt active typing
  useEffect(() => {
    if (!focused.current) setRaw(String(cost))
  }, [cost])

  const commit = () => {
    focused.current = false
    const n = parseFloat(raw)
    if (!isNaN(n) && n >= 0) onCostChange(legKey, n)
    else setRaw(String(cost))
  }

  const payout = cost * multiplier

  return (
    <div className="flex items-center gap-2 py-1 border-b border-border-subtle/40 last:border-0">
      {/* Band range */}
      <span
        className="flex-1 text-[10px] text-text-tertiary truncate"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        ${lower}–{upper}
      </span>

      {/* Cost input */}
      <div className="flex items-center bg-surface-card rounded-[5px] px-1.5 py-0.5 border border-border-subtle gap-0.5 w-16 shrink-0">
        <span className="text-text-quaternary text-[10px]">$</span>
        <input
          type="number"
          min={0}
          value={raw}
          onChange={e => setRaw(e.target.value)}
          onBlur={commit}
          onFocus={e => { focused.current = true; e.target.select() }}
          onKeyDown={e => e.key === 'Enter' && commit()}
          className="flex-1 bg-transparent text-[11px] font-medium text-text-primary outline-none w-0"
          style={{ fontFamily: 'var(--font-mono)' }}
        />
      </div>

      {/* Payout */}
      <span
        className="text-[10px] text-bullish-green w-14 text-right shrink-0"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        ${payout.toFixed(2)}
      </span>

      {/* Remove */}
      <button
        onClick={() => onRemove(legKey)}
        className="text-[11px] text-text-quaternary hover:text-bearish-red transition-colors shrink-0 leading-none"
      >
        ×
      </button>
    </div>
  )
}

export default function OrderSummary({ s }: { s: GridState }) {
  const { legsArr } = s
  const [slipOpen, setSlipOpen] = useState(false)
  const [slip, setSlip] = useState('1.0')
  const [applyStake, setApplyStake] = useState(String(s.stake))

  const hasLegs = legsArr.length > 0
  const a = computeAnalytics(s)

  // Derive totals from per-leg costs
  const totalCost  = legsArr.reduce((sum, l) => sum + l.cost, 0)
  const bestPayout = legsArr.reduce((m, l) => Math.max(m, l.cost * l.multiplier), 0)

  const handleApplyAll = () => {
    const n = parseFloat(applyStake)
    if (!isNaN(n) && n >= 0) {
      s.updateAllLegCosts(n)
      s.setStake(n)
    }
  }

  return (
    <div className="flex flex-col h-full text-[11px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <span className="text-text-secondary font-semibold">Order</span>
        <span className="text-text-quaternary">{legsArr.length} leg{legsArr.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-2.5 flex-1 overflow-auto no-scrollbar">

        {/* Default size for new selections */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-quaternary shrink-0">Size</span>
          <div className="flex items-center bg-surface-card rounded-[6px] px-2 py-1 border border-border-subtle gap-1 flex-1">
            <span className="text-text-quaternary text-[11px]">$</span>
            <input
              type="number"
              min={0}
              value={applyStake}
              onChange={e => { setApplyStake(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n) && n >= 0) s.setStake(n) }}
              className="flex-1 bg-transparent text-[12px] font-medium text-text-primary outline-none w-0"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>
          <button
            onClick={handleApplyAll}
            title="Apply this size to all legs"
            className="shrink-0 px-2 py-1 text-[10px] font-semibold rounded-[5px] bg-surface-hover text-text-secondary hover:text-text-primary border border-border-subtle transition-colors"
          >
            All
          </button>
        </div>

        {/* Quick amounts — set default only, do not overwrite existing legs */}
        <div className="flex gap-1">
          {[5, 10, 25, 50].map(v => (
            <button
              key={v}
              onClick={() => { setApplyStake(String(v)); s.setStake(v) }}
              className="flex-1 py-1 rounded-[5px] text-[10px] font-medium transition-colors"
              style={{
                background: s.stake === v ? 'var(--color-surface-hover)' : 'var(--color-surface-card)',
                color:      s.stake === v ? 'var(--color-text-primary)'   : 'var(--color-text-tertiary)',
                border:     `1px solid ${s.stake === v ? 'var(--color-border-default)' : 'var(--color-border-subtle)'}`,
              }}
            >
              ${v}
            </button>
          ))}
        </div>

        {/* Stats */}
        {hasLegs && (
          <div className="grid grid-cols-2 gap-2">
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

        <Stat label="Total cost"  value={`$${totalCost.toFixed(2)}`} />
        <Stat label="Best payout" value={`$${bestPayout.toFixed(2)}`} color="#0b9981" />
        <Stat label="Max loss"    value={`-$${totalCost.toFixed(2)}`} color="#f23546" />

        {/* Slippage */}
        <button
          onClick={() => setSlipOpen(o => !o)}
          className="flex items-center justify-between text-[10px] text-text-quaternary hover:text-text-tertiary transition-colors mt-1"
        >
          <span className="uppercase tracking-wider">Slippage tolerance</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{slip}%</span>
        </button>
        {slipOpen && (
          <div className="flex items-center bg-surface-card rounded-[6px] px-2 py-1 border border-border-subtle">
            <input
              type="number" min={0} step={0.1} value={slip}
              onChange={e => setSlip(e.target.value)}
              className="flex-1 bg-transparent text-[12px] text-text-primary outline-none w-0"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
            <span className="text-text-quaternary text-[11px]">%</span>
          </div>
        )}

        {/* Per-leg breakdown */}
        {hasLegs && (
          <div className="border-t border-border-subtle pt-2 mt-1">
            {/* Column headers */}
            <div className="flex items-center gap-2 pb-1">
              <span className="flex-1 text-[9px] uppercase tracking-wider text-text-quaternary">Band</span>
              <span className="w-16 text-[9px] uppercase tracking-wider text-text-quaternary shrink-0">Cost</span>
              <span className="w-14 text-right text-[9px] uppercase tracking-wider text-text-quaternary shrink-0">Pays</span>
              <span className="w-3 shrink-0" />
            </div>
            {legsArr.map(leg => (
              <LegRow
                key={leg.key}
                legKey={leg.key}
                lower={leg.lower}
                upper={leg.upper}
                cost={leg.cost}
                multiplier={leg.multiplier}
                onCostChange={s.updateLegCost}
                onRemove={s.removeLeg}
              />
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
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
          className="w-full py-2 text-[12px] font-semibold rounded-[8px] transition-all"
          style={{
            background: hasLegs ? '#807dfe' : 'var(--color-surface-hover)',
            color:      hasLegs ? '#fff'    : 'var(--color-text-quaternary)',
            cursor:     hasLegs ? 'pointer' : 'not-allowed',
            opacity:    hasLegs ? 1         : 0.6,
          }}
        >
          Confirm Order
        </button>
      </div>
    </div>
  )
}
