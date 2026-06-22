import { useState } from 'react'
import { IconX, IconChevronUp, IconChevronDown, IconArrowLeft } from '@tabler/icons-react'
import { useCombo } from './combo-context'

// ── Strategy definitions ──────────────────────────────────────────────────────

const STRATEGIES = [
  {
    kind:    0,
    name:    'Spread',
    tagline: 'Bet on a range',
    desc:    'YES at a low strike + NO at a high strike. Pays if spot lands between.',
    legs:    [
      { dir: 'yes', label: 'YES K₁' },
      { dir: 'no',  label: 'NO K₂'  },
    ],
    connector: '×',
    color: '#0b9981',
  },
  {
    kind:    1,
    name:    'Condor',
    tagline: 'Collect premium',
    desc:    'Four legs bracketing spot. Max profit when price stays range-bound.',
    legs:    [
      { dir: 'yes', label: 'YES K₁' },
      { dir: 'no',  label: 'NO K₂'  },
      { dir: 'no',  label: 'NO K₃'  },
      { dir: 'yes', label: 'YES K₄' },
    ],
    connector: '+',
    color: '#807dfe',
  },
  {
    kind:    2,
    name:    'Ladder',
    tagline: 'Time steps',
    desc:    'Same strike across multiple 0DTE expiries. Profits compound as each window closes.',
    legs:    [
      { dir: 'yes', label: 'T₁' },
      { dir: 'yes', label: 'T₂' },
      { dir: 'yes', label: 'T₃' },
    ],
    connector: '→',
    color: '#f5a623',
  },
  {
    kind:    3,
    name:    'Diagonal',
    tagline: 'Strike + time edge',
    desc:    'Different strike AND different expiry. Captures both directional and term-structure skew.',
    legs:    [
      { dir: 'yes', label: 'K₁ T₁' },
      { dir: 'no',  label: 'K₂ T₂' },
    ],
    connector: '×',
    color: '#e86c4f',
  },
  {
    kind:    5,
    name:    'Temporal Condor',
    tagline: 'Range across time',
    desc:    'Inner strikes at near expiry, outer strikes at far expiry. Benefits from term-structure flattening.',
    legs:    [
      { dir: 'no',  label: 'NO T₁' },
      { dir: 'yes', label: 'YES T₁' },
      { dir: 'yes', label: 'YES T₂' },
      { dir: 'no',  label: 'NO T₂'  },
    ],
    connector: '+',
    color: '#a78bfa',
  },
  {
    kind:    6,
    name:    'Custom',
    tagline: 'Free-form',
    desc:    'Add any legs manually from the Trade or Range widgets. No preset structure.',
    legs:    [
      { dir: 'yes', label: '?' },
      { dir: 'no',  label: '?' },
    ],
    connector: '+',
    color: '#6b7280',
  },
] as const

type Strategy = typeof STRATEGIES[number]

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
  const multi = legs.reduce((acc, l) => acc * l.multiplier, 1)
  return { multi, payout: stake * multi }
}

// ── Colour map ────────────────────────────────────────────────────────────────

const DIR_COLOR: Record<string, string> = {
  yes:   '#0b9981',
  no:    '#f23546',
  range: '#807dfe',
}

// ── Strategy picker card ──────────────────────────────────────────────────────

function StrategyCard({ s, onSelect }: { s: Strategy; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="flex flex-col gap-1.5 p-2.5 rounded-[10px] text-left border border-border-subtle bg-surface-card hover:bg-surface-hover hover:border-text-quaternary transition-all hover:scale-[1.01] cursor-pointer"
    >
      {/* Name + tagline */}
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
        <span className="text-[11px] font-bold text-text-primary">
          {s.name}
        </span>
        <span className="text-[9px] text-text-quaternary">{s.tagline}</span>
      </div>

      {/* Leg diagram */}
      <div className="flex items-center gap-1 flex-wrap">
        {s.legs.map((leg, i) => (
          <span key={i} className="flex items-center gap-1">
            <span
              className={`text-[8px] font-bold px-1.5 py-0.5 rounded-[6px] border-[1.5px] bg-surface-primary ${
                leg.dir === 'yes'
                  ? 'text-bullish-green border-bullish-green/20'
                  : leg.dir === 'no'
                  ? 'text-bearish-red border-bearish-red/20'
                  : 'text-brand-violet border-brand-violet/20'
              }`}
            >
              {leg.label}
            </span>
            {i < s.legs.length - 1 && (
              <span className="text-[8px] text-text-quaternary">{s.connector}</span>
            )}
          </span>
        ))}
      </div>

      {/* Description */}
      <p className="text-[8.5px] text-text-quaternary leading-[1.4]">{s.desc}</p>
    </button>
  )
}

// ── Main tray ─────────────────────────────────────────────────────────────────

export default function ComboTray() {
  const [stake, setStake] = useState(10)
  const [expanded, setExpanded] = useState(false)
  const [phase, setPhase] = useState<'pick' | 'build'>('pick')
  const [selectedKind, setSelectedKind] = useState<number | null>(null)

  const {
    legs, open, mode, status, error, result,
    removeLeg, clear, setOpen, setMode, place,
  } = useCombo()

  if (!open && legs.length === 0) return null

  const strategy = STRATEGIES.find(s => s.kind === selectedKind)

  const combo  = mode === 'parlay'    ? calcCombo(legs, stake)  : null
  const parlay = mode === 'portfolio' ? calcParlay(legs, stake) : null
  const multi  = combo?.mCombo ?? parlay?.multi ?? 0
  const payout = combo?.payout ?? parlay?.payout ?? 0
  const prob   = combo?.pCombo ?? legs.reduce((a, l) => a * l.prob, 1)
  const canPlace = legs.length >= 2

  function handleSelectStrategy(s: Strategy) {
    setSelectedKind(s.kind)
    setPhase('build')
    // For non-custom strategies, we could pre-populate legs in the future;
    // for now move to build phase so the user adds legs from market widgets.
    if (s.kind !== 6) clear()
  }

  function handleBack() {
    setPhase('pick')
    setSelectedKind(null)
    clear()
  }

  const accentColor = strategy?.color ?? '#807dfe'

  return (
    <div
      className="absolute bottom-4 right-4 z-50 flex flex-col items-end gap-0"
      style={{ pointerEvents: 'none' }}
    >
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
          <span
            className="text-[10px] font-semibold uppercase tracking-widest"
            style={{ color: accentColor }}
          >
            {strategy ? strategy.name : 'Combo'}
          </span>

          {legs.length === 0 ? (
            <span className="text-[10px] text-text-quaternary">
              {phase === 'pick' ? 'pick a strategy' : 'add legs from widgets'}
            </span>
          ) : (
            <>
              <span className="text-[10px] text-text-tertiary">
                {legs.length} leg{legs.length !== 1 ? 's' : ''}
              </span>
              {canPlace && (
                <span
                  className="text-[10px] font-semibold"
                  style={{ color: accentColor, fontFamily: 'var(--font-mono)' }}
                >
                  {multi.toFixed(1)}×
                </span>
              )}
            </>
          )}

          <div className="flex items-center gap-1.5 ml-auto">
            {(legs.length > 0 || selectedKind !== null) && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  handleBack()
                  setExpanded(false)
                }}
                className="text-text-quaternary hover:text-bearish-red transition-colors"
              >
                <IconX size={11} stroke={2} />
              </button>
            )}
            <span className="text-text-quaternary">
              {expanded
                ? <IconChevronDown size={11} stroke={2} />
                : <IconChevronUp size={11} stroke={2} />
              }
            </span>
          </div>
        </div>

        {/* Expanded body */}
        {expanded && (
          <div className="border-t border-border-subtle">

            {/* ── Phase: strategy picker ── */}
            {phase === 'pick' && (
              <div className="px-3 py-2.5 flex flex-col gap-2">
                <p className="text-[9px] text-text-quaternary uppercase tracking-widest">
                  Choose strategy
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {STRATEGIES.map(s => (
                    <StrategyCard
                      key={s.kind}
                      s={s}
                      onSelect={() => handleSelectStrategy(s)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Phase: build / review ── */}
            {phase === 'build' && (
              <div className="px-3 py-2.5 flex flex-col gap-3">

                {/* Back + strategy label */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={e => { e.stopPropagation(); handleBack() }}
                    className="text-text-quaternary hover:text-text-secondary transition-colors"
                  >
                    <IconArrowLeft size={12} stroke={2} />
                  </button>
                  {strategy && (
                    <>
                      <span className="text-[10px] font-semibold" style={{ color: accentColor }}>
                        {strategy.name}
                      </span>
                      <span className="text-[9px] text-text-quaternary">{strategy.tagline}</span>
                    </>
                  )}
                </div>

                {/* Hint when no legs yet */}
                {legs.length === 0 && (
                  <div className="rounded-[8px] px-2.5 py-3 text-center border border-dashed border-border-subtle bg-surface-primary">
                    <p className="text-[9px] text-text-quaternary leading-relaxed">
                      {strategy?.kind === 6
                        ? 'Add any legs from the Trade or Range widgets'
                        : <>Add {strategy?.legs.length} legs from the market widgets.<br />
                            Expected shape:{' '}
                            {strategy?.legs.map(l => l.label).join(` ${strategy.connector} `)}</>
                      }
                    </p>
                  </div>
                )}

                {/* Mode toggle */}
                {legs.length > 0 && (
                  <div className="flex items-center gap-1">
                    {(['parlay', 'portfolio'] as const).map(m => (
                      <button
                        key={m}
                        onClick={() => setMode(m)}
                        className={`flex-1 py-1 text-[9px] font-semibold uppercase tracking-widest rounded-[6px] transition-colors border ${
                          mode === m
                            ? 'bg-surface-hover text-text-primary border-brand-violet'
                            : 'bg-surface-card text-text-quaternary border-border-subtle hover:text-text-secondary'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}

                {/* Leg list */}
                {legs.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {legs.map((leg, i) => (
                      <div key={leg.id}>
                        <div
                          className="flex items-center justify-between px-2 py-1.5 rounded-[7px]"
                          style={{
                            background: 'var(--color-surface-card)',
                            border: '1px solid var(--color-border-subtle)',
                          }}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`text-[9px] font-bold px-1.5 py-0.5 rounded-[6px] shrink-0 uppercase border-[1.5px] bg-surface-primary ${
                                leg.direction === 'yes'
                                  ? 'text-bullish-green border-bullish-green/20'
                                  : leg.direction === 'no'
                                  ? 'text-bearish-red border-bearish-red/20'
                                  : 'text-brand-violet border-brand-violet/20'
                              }`}
                            >
                              {leg.direction}
                            </span>
                            <span className="text-[10px] text-text-secondary truncate">
                              {leg.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <span
                              className="text-[9px] text-text-quaternary"
                              style={{ fontFamily: 'var(--font-mono)' }}
                            >
                              {leg.multiplier.toFixed(1)}×
                            </span>
                            <button
                              onClick={() => removeLeg(leg.id)}
                              className="text-text-quaternary hover:text-bearish-red transition-colors"
                            >
                              <IconX size={10} stroke={2} />
                            </button>
                          </div>
                        </div>
                        {i < legs.length - 1 && (
                          <div className="flex justify-center my-0.5 text-[10px] text-text-quaternary">
                            {strategy?.connector ?? (mode === 'parlay' ? '×' : '→')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Payout math */}
                {canPlace && (
                  <div
                    className="flex items-center justify-between text-[10px] pt-1 border-t border-border-subtle"
                  >
                    <span
                      className="text-text-quaternary"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {(prob * 100).toFixed(2)}% · {multi.toFixed(1)}×
                    </span>
                    <span
                      className="font-semibold text-bullish-green"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      ${payout.toFixed(2)}
                    </span>
                  </div>
                )}

                {/* Status banners */}
                {status === 'submitted' && result && (
                  <div className="text-[10px] rounded-[6px] px-2 py-1.5 text-left border border-border-subtle bg-surface-primary text-text-secondary flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-bullish-green shrink-0" />
                    <span>
                      Submitted ·{' '}
                      <span className="font-mono">{result.tx_digest.slice(0, 10)}…</span>
                    </span>
                  </div>
                )}
                {status === 'error' && error && (
                  <div className="text-[10px] rounded-[6px] px-2 py-1.5 text-left border border-border-subtle bg-surface-primary text-text-secondary flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-bearish-red shrink-0" />
                    <span className="truncate">{error}</span>
                  </div>
                )}

                {/* Stake + Place */}
                <div className="flex items-center gap-2">
                  <div
                    className="flex items-center rounded-[7px] px-2 py-1 border gap-1 flex-1"
                    style={{
                      background: 'var(--color-surface-card)',
                      border: '1px solid var(--color-border-subtle)',
                    }}
                  >
                    <span className="text-text-quaternary text-[10px]">$</span>
                    <input
                      type="number"
                      min={1}
                      value={stake}
                      onChange={e => setStake(Math.max(1, parseFloat(e.target.value) || 1))}
                      className="w-full bg-transparent text-[12px] font-medium text-text-primary outline-none"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    />
                  </div>
                  <button
                    disabled={!canPlace || status === 'submitting'}
                    onClick={() => place('', '')}
                    className="px-3 py-1.5 text-[11px] font-semibold rounded-[8px] shrink-0 transition-all"
                    style={{
                      background: canPlace && status !== 'submitting'
                        ? accentColor
                        : 'var(--color-surface-hover)',
                      color: canPlace && status !== 'submitting'
                        ? '#fff'
                        : 'var(--color-text-quaternary)',
                      cursor:  canPlace && status !== 'submitting' ? 'pointer' : 'not-allowed',
                      opacity: canPlace && status !== 'submitting' ? 1 : 0.5,
                    }}
                  >
                    {status === 'submitting' ? '…' : 'Place'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dismiss when no legs */}
      {open && legs.length === 0 && phase === 'pick' && (
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
