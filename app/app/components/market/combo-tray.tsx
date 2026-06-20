import { IconX, IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import { useCombo } from './combo-context'

// ── Math ─────────────────────────────────────────────────────────────────────

const BASE_EDGE  = 0.06
const comboEdge  = (n: number) => Math.max(0.01, BASE_EDGE - (n - 1) * 0.015)

function calcCombo(legs: { prob: number; multiplier: number }[], stake: number) {
  if (legs.length < 2) return null
  const pCombo  = legs.reduce((acc, l) => acc * l.prob, 1)
  const edge    = comboEdge(legs.length)
  const mCombo  = (1 - edge) / pCombo
  return { pCombo, mCombo, payout: stake * mCombo }
}

function calcParlay(legs: { multiplier: number }[], stake: number) {
  const payout = legs.reduce((acc, l) => acc * l.multiplier, stake)
  const multi  = legs.reduce((acc, l) => acc * l.multiplier, 1)
  return { multi, payout }
}

// ── Tray ─────────────────────────────────────────────────────────────────────

const DIRECTION_COLOR: Record<string, string> = {
  yes:   '#0b9981',
  no:    '#f23546',
  range: '#807dfe',
}

interface Props { stake: number; onStakeChange: (v: number) => void }

export default function ComboTray({ stake, onStakeChange }: Props) {
  const { legs, open, mode, removeLeg, clear, setOpen, setMode } = useCombo()

  if (!open && legs.length === 0) return null

  const combo  = mode === 'combo'  ? calcCombo(legs, stake)  : null
  const parlay = mode === 'parlay' ? calcParlay(legs, stake) : null
  const payout = combo?.payout ?? parlay?.payout ?? 0
  const multi  = combo?.mCombo ?? parlay?.multi ?? 0
  const prob   = combo?.pCombo ?? legs.reduce((a, l) => a * l.prob, 1)

  const canPlace = legs.length >= 2

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-40 border-t border-border-default"
      style={{ background: 'var(--color-surface-primary)' }}
    >
      {/* Collapsed bar — always visible when tray is open or has legs */}
      <div
        className="flex items-center gap-3 px-4 h-9 cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <span className="text-[10px] uppercase tracking-widest text-text-quaternary">Combo</span>
        {legs.length === 0 ? (
          <span className="text-[10px] text-text-quaternary opacity-50">Add legs from Trade or Range widgets</span>
        ) : (
          <div className="flex items-center gap-1.5">
            {legs.map(l => (
              <span
                key={l.id}
                className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-[5px]"
                style={{ background: `${DIRECTION_COLOR[l.direction]}18`, color: DIRECTION_COLOR[l.direction], border: `1px solid ${DIRECTION_COLOR[l.direction]}30` }}
              >
                {l.label}
              </span>
            ))}
            {legs.length >= 2 && (
              <span className="text-[11px] font-semibold ml-1" style={{ color: '#807dfe', fontFamily: 'var(--font-mono)' }}>
                {multi.toFixed(1)}×
              </span>
            )}
          </div>
        )}
        {legs.length > 0 && (
          <button
            onClick={e => { e.stopPropagation(); clear() }}
            className="ml-auto text-[10px] text-text-quaternary hover:text-bearish-red transition-colors"
          >
            Clear
          </button>
        )}
        <span className={`${legs.length > 0 ? '' : 'ml-auto'} text-text-quaternary`}>
          {open ? <IconChevronDown size={13} stroke={2} /> : <IconChevronUp size={13} stroke={2} />}
        </span>
      </div>

      {/* Expanded strip */}
      {open && (
        <div className="flex items-center gap-4 px-4 py-3 border-t border-border-subtle">

          {/* Mode toggle */}
          <div className="flex items-center gap-1 shrink-0">
            {(['combo', 'parlay'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest rounded-[7px] transition-colors"
                style={{
                  background: mode === m ? 'rgba(128,125,254,0.15)' : 'var(--color-surface-card)',
                  color:      mode === m ? '#807dfe' : 'var(--color-text-quaternary)',
                  border:     `1px solid ${mode === m ? 'rgba(128,125,254,0.3)' : 'var(--color-border-subtle)'}`,
                }}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Leg chips */}
          <div className="flex items-center gap-1.5 flex-1 overflow-x-auto no-scrollbar">
            {legs.map((leg, i) => (
              <div key={leg.id} className="flex items-center gap-1 shrink-0">
                {i > 0 && (
                  <span className="text-[11px] text-text-quaternary mx-0.5">
                    {mode === 'combo' ? '×' : '→'}
                  </span>
                )}
                <span
                  className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-[7px] shrink-0"
                  style={{
                    background: `${DIRECTION_COLOR[leg.direction]}15`,
                    color:      DIRECTION_COLOR[leg.direction],
                    border:     `1px solid ${DIRECTION_COLOR[leg.direction]}30`,
                  }}
                >
                  {leg.label}
                  <button
                    onClick={() => removeLeg(leg.id)}
                    className="opacity-60 hover:opacity-100 transition-opacity"
                  >
                    <IconX size={10} stroke={2.5} />
                  </button>
                </span>
              </div>
            ))}
          </div>

          {/* Math summary */}
          {canPlace && (
            <div className="flex items-center gap-3 shrink-0 text-[11px]" style={{ fontFamily: 'var(--font-mono)' }}>
              <span className="text-text-quaternary">{(prob * 100).toFixed(2)}%</span>
              <span style={{ color: '#807dfe' }}>{multi.toFixed(1)}×</span>
              <span className="text-bullish-green">${payout.toFixed(2)}</span>
            </div>
          )}

          {/* Stake */}
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="flex items-center bg-surface-card rounded-[7px] px-2 py-1 border border-border-subtle gap-1">
              <span className="text-text-quaternary text-[10px]">$</span>
              <input
                type="number" min={1} value={stake}
                onChange={e => onStakeChange(Math.max(1, parseFloat(e.target.value) || 1))}
                className="w-10 bg-transparent text-[12px] font-medium text-text-primary outline-none"
                style={{ fontFamily: 'var(--font-mono)' }}
              />
            </div>
          </div>

          {/* Place */}
          <button
            disabled={!canPlace}
            className="px-4 py-1.5 text-[11px] font-semibold rounded-[8px] shrink-0 transition-all"
            style={{
              background: canPlace ? '#807dfe' : 'var(--color-surface-hover)',
              color:      canPlace ? '#fff'     : 'var(--color-text-quaternary)',
              cursor:     canPlace ? 'pointer'  : 'not-allowed',
              opacity:    canPlace ? 1          : 0.6,
            }}
          >
            Place {mode === 'combo' ? 'Combo' : 'Parlay'}
          </button>
        </div>
      )}
    </div>
  )
}
