import { useState } from 'react'
import { IconX, IconChevronUp, IconChevronDown } from '@tabler/icons-react'
import { useCombo } from './combo-context'

// ── Math ─────────────────────────────────────────────────────────────────────

const BASE_EDGE = 0.06
const comboEdge = (n: number) => Math.max(0.01, BASE_EDGE - (n - 1) * 0.015)

function calcCombo(legs: { prob: number }[], stake: number) {
  if (legs.length < 2) return null
  const pCombo = legs.reduce((acc, l) => acc * l.prob, 1)
  const mCombo = (1 - comboEdge(legs.length)) / pCombo
  return { pCombo, mCombo, payout: stake * mCombo }
}

function calcParlay(legs: { multiplier: number }[], stake: number) {
  const multi  = legs.reduce((acc, l) => acc * l.multiplier, 1)
  return { multi, payout: stake * multi }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DIR_COLOR: Record<string, string> = {
  yes:   '#0b9981',
  no:    '#f23546',
  range: '#807dfe',
}

// ── Tray ─────────────────────────────────────────────────────────────────────

export default function ComboTray() {
  const [stake, setStake] = useState(10)
  const { legs, open, mode, removeLeg, clear, setOpen, setMode } = useCombo()
  const [expanded, setExpanded] = useState(false)

  if (!open && legs.length === 0) return null

  const combo  = mode === 'combo'  ? calcCombo(legs, stake)  : null
  const parlay = mode === 'parlay' ? calcParlay(legs, stake) : null
  const multi  = combo?.mCombo ?? parlay?.multi ?? 0
  const payout = combo?.payout ?? parlay?.payout ?? 0
  const prob   = combo?.pCombo ?? legs.reduce((a, l) => a * l.prob, 1)
  const canPlace = legs.length >= 2

  return (
    <div className="absolute bottom-4 right-4 z-50 flex flex-col items-end gap-0" style={{ pointerEvents: 'none' }}>
      <div
        className="rounded-[14px] border border-border-default shadow-2xl overflow-hidden"
        style={{
          background:    'var(--color-surface-primary)',
          width:         expanded ? 300 : 'auto',
          pointerEvents: 'auto',
        }}
      >
        {/* Header pill — always visible */}
        <div
          className="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none"
          onClick={() => setExpanded(e => !e)}
        >
          <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#807dfe' }}>
            Combo
          </span>

          {legs.length === 0 ? (
            <span className="text-[10px] text-text-quaternary">no legs yet</span>
          ) : (
            <>
              <span className="text-[10px] text-text-tertiary">{legs.length} leg{legs.length !== 1 ? 's' : ''}</span>
              {canPlace && (
                <span className="text-[10px] font-semibold" style={{ color: '#807dfe', fontFamily: 'var(--font-mono)' }}>
                  {multi.toFixed(1)}×
                </span>
              )}
            </>
          )}

          <div className="flex items-center gap-1.5 ml-auto">
            {legs.length > 0 && (
              <button
                onClick={e => { e.stopPropagation(); clear(); setExpanded(false) }}
                className="text-text-quaternary hover:text-bearish-red transition-colors"
              >
                <IconX size={11} stroke={2} />
              </button>
            )}
            <span className="text-text-quaternary">
              {expanded ? <IconChevronDown size={11} stroke={2} /> : <IconChevronUp size={11} stroke={2} />}
            </span>
          </div>
        </div>

        {/* Expanded body */}
        {expanded && (
          <div className="border-t border-border-subtle px-3 py-2.5 flex flex-col gap-3">

            {/* Mode toggle */}
            <div className="flex items-center gap-1">
              {(['combo', 'parlay'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className="flex-1 py-1 text-[9px] font-semibold uppercase tracking-widest rounded-[6px] transition-colors"
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

            {/* Legs */}
            {legs.length === 0 ? (
              <p className="text-[10px] text-text-quaternary text-center py-2">
                Add legs from Trade or Range widgets
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {legs.map((leg, i) => (
                  <div key={leg.id}>
                    <div
                      className="flex items-center justify-between px-2 py-1.5 rounded-[7px]"
                      style={{ background: 'var(--color-surface-card)', border: '1px solid var(--color-border-subtle)' }}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="text-[9px] font-bold px-1.5 py-0.5 rounded-[4px] shrink-0 uppercase"
                          style={{ background: `${DIR_COLOR[leg.direction]}18`, color: DIR_COLOR[leg.direction] }}
                        >
                          {leg.direction}
                        </span>
                        <span className="text-[10px] text-text-secondary truncate">{leg.label}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-[9px] text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                          {leg.multiplier.toFixed(1)}×
                        </span>
                        <button onClick={() => removeLeg(leg.id)} className="text-text-quaternary hover:text-bearish-red transition-colors">
                          <IconX size={10} stroke={2} />
                        </button>
                      </div>
                    </div>
                    {i < legs.length - 1 && (
                      <div className="flex justify-center my-0.5 text-[10px] text-text-quaternary">
                        {mode === 'combo' ? '×' : '→'}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Math */}
            {canPlace && (
              <div className="flex items-center justify-between text-[10px] pt-1 border-t border-border-subtle">
                <span className="text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                  {(prob * 100).toFixed(2)}% · {multi.toFixed(1)}×
                </span>
                <span className="font-semibold text-bullish-green" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${payout.toFixed(2)}
                </span>
              </div>
            )}

            {/* Stake + Place */}
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-surface-card rounded-[7px] px-2 py-1 border border-border-subtle gap-1 flex-1">
                <span className="text-text-quaternary text-[10px]">$</span>
                <input
                  type="number" min={1} value={stake}
                  onChange={e => setStake(Math.max(1, parseFloat(e.target.value) || 1))}
                  className="w-full bg-transparent text-[12px] font-medium text-text-primary outline-none"
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <button
                disabled={!canPlace}
                className="px-3 py-1.5 text-[11px] font-semibold rounded-[8px] shrink-0 transition-all"
                style={{
                  background: canPlace ? '#807dfe' : 'var(--color-surface-hover)',
                  color:      canPlace ? '#fff'     : 'var(--color-text-quaternary)',
                  cursor:     canPlace ? 'pointer'  : 'not-allowed',
                  opacity:    canPlace ? 1          : 0.5,
                }}
              >
                Place
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Dismiss when no legs */}
      {open && legs.length === 0 && (
        <button
          onClick={() => setOpen(false)}
          className="mt-1 text-[9px] text-text-quaternary hover:text-text-secondary transition-colors"
          style={{ pointerEvents: 'auto' }}
        >
          dismiss
        </button>
      )}
    </div>
  )
}
