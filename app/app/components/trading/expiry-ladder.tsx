import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { getActiveLadder } from '../../lib/cerida-api'

// ── SVI helpers ──────────────────────────────────────────────────────────────
const SPREAD  = 0.025
const MIN_ASK = 0.01
const MAX_ASK = 0.99

const niceStep = (price: number) => {
  const target = price * 0.0035
  const pow = 10 ** Math.floor(Math.log10(target))
  const mult = [1, 2, 2.5, 5, 10].find((m) => m * pow >= target) ?? 10
  return mult * pow
}
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x))
  return x >= 0 ? y : -y
}
const normCdf  = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2))
const sigmaFor = (hrs: number, step: number) => step * 2 * Math.sqrt(Math.max(hrs, 0.01))

const fmtStrike = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: 0 })

function heatColor(t: number) {
  const a = Math.min(0.9, 0.06 + t * 0.5)
  return `rgba(${Math.round(96 + t * 159)},${Math.round(92 + t * 96)},${Math.round(255 - t * 225)},${a.toFixed(2)})`
}


interface Props {
  currentPrice?: number
  underlying?: string
  markets?: { label: string; expiry: number; oracleId: string }[]
}

export default function ExpiryLadder({
  currentPrice = 66612,
  underlying = 'BTC',
  markets,
}: Props) {
  type Expiry = { label: string; expiry: number; oracleId: string }

  const { data: ladder } = useQuery({
    queryKey: ['activeLadder'],
    queryFn: getActiveLadder,
    staleTime: 30_000,
    enabled: !markets,
  })
  const expiries = useMemo<Expiry[]>(() => {
    if (markets) return markets
    if (!ladder) return []
    return ladder.map(m => ({
      label: new Date(m.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      expiry: m.expiry,
      oracleId: m.oracleId,
    }))
  }, [markets, ladder])

  const STEP = useMemo(() => niceStep(currentPrice), [currentPrice])
  const NUM  = 12

  // live price
  const [price, setPrice] = useState(currentPrice)
  const [now,   setNow]   = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setPrice(p => p + (currentPrice - p) * 0.05 + (Math.random() - 0.5) * STEP * 0.5)
      setNow(Date.now())
    }, 700)
    return () => clearInterval(id)
  }, [currentPrice, STEP])

  // strike ladder
  const strikes = useMemo(() => {
    const base = Math.round(price / STEP) * STEP - (NUM / 2) * STEP
    return Array.from({ length: NUM + 1 }, (_, i) => base + i * STEP)
  }, [price, STEP])
  const bands = useMemo(
    () => strikes.slice(0, -1).map((lo, i) => ({ lower: lo, upper: strikes[i + 1]! })),
    [strikes],
  )
  const domainLo = strikes[0]!
  const domainHi = strikes[strikes.length - 1]!
  const span     = domainHi - domainLo
  const pctOf    = (p: number) => ((p - domainLo) / span) * 100

  // range selection (same drag mechanic as range-trading)
  const snap0  = Math.round(price / STEP) * STEP
  const [selLo, setSelLo] = useState(snap0 - STEP)
  const [selHi, setSelHi] = useState(snap0 + 2 * STEP)
  const dragging = useRef(false)
  const anchor   = useRef({ lo: selLo, hi: selHi })
  const lower  = Math.min(selLo, selHi)
  const higher = Math.max(selLo, selHi)

  useEffect(() => {
    const up = () => { dragging.current = false }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])
  const onDown = useCallback((b: { lower: number; upper: number }) => {
    dragging.current = true
    anchor.current   = { lo: b.lower, hi: b.upper }
    setSelLo(b.lower); setSelHi(b.upper)
  }, [])
  const onEnter = useCallback((b: { lower: number; upper: number }) => {
    if (!dragging.current) return
    setSelLo(Math.min(anchor.current.lo, b.lower))
    setSelHi(Math.max(anchor.current.hi, b.upper))
  }, [])

  // probability for each expiry at the selected range
  const probFor = (expiry: number) => {
    const secs  = Math.max(60, (expiry - now) / 1000)
    const sigma = sigmaFor(secs / 3600, STEP)
    const p     = normCdf((higher - price) / sigma) - normCdf((lower - price) / sigma)
    return { prob: p, ask: Math.max(MIN_ASK, Math.min(MAX_ASK, p + SPREAD)) }
  }

  // selected expiries
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(expiries.slice(0, 3).map(e => e.oracleId)),
  )
  const toggle = (id: string) =>
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const [stake, setStake] = useState('10')
  const stakeNum  = parseFloat(stake) || 0
  const selCount  = selected.size
  const totalCost = stakeNum * selCount

  const maxBandProb = useMemo(() => {
    if (expiries.length === 0) return 0.001
    const midExpiry = expiries[Math.floor(expiries.length / 2)]!.expiry
    const secs  = Math.max(60, (midExpiry - now) / 1000)
    const sigma = sigmaFor(secs / 3600, STEP)
    return Math.max(...bands.map(b => normCdf((b.upper - price) / sigma) - normCdf((b.lower - price) / sigma)), 0.001)
  }, [bands, expiries, now, STEP, price])

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px]">
      <div className="flex flex-col gap-3 px-3 py-3 flex-1 overflow-y-auto no-scrollbar">

        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-semibold text-text-primary">Expiry Ladder</span>
          <span className="text-[10px] text-text-quaternary">{underlying} · same range, multiple expiries</span>
        </div>

        {/* Range picker */}
        <div className="select-none">
          <div className="text-[10px] uppercase tracking-wider text-text-quaternary mb-1.5">
            Range ·{' '}
            <span className="text-text-secondary font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
              ${fmtStrike(lower)} – ${fmtStrike(higher)}
            </span>
          </div>

          {/* price label */}
          <div className="relative h-5">
            <motion.div
              className="absolute -translate-x-1/2"
              animate={{ left: `${pctOf(price)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            >
              <span className="px-1 rounded-[3px] text-[10px] font-bold text-white whitespace-nowrap"
                style={{ background: '#0b9981', fontFamily: 'var(--font-mono)' }}>
                ${fmtStrike(price)}
              </span>
            </motion.div>
          </div>

          {/* heatmap bar */}
          <div className="relative flex gap-[2px] h-7" onPointerLeave={() => {}}>
            {bands.map((b, i) => {
              const midEx = expiries[Math.floor(expiries.length / 2)]
              const sigma = midEx ? sigmaFor(Math.max(60, (midEx.expiry - now) / 1000) / 3600, STEP) : STEP
              const t     = Math.min(1, (normCdf((b.upper - price) / sigma) - normCdf((b.lower - price) / sigma)) / maxBandProb)
              const sel   = b.lower >= lower && b.upper <= higher
              return (
                <button
                  key={i}
                  onPointerDown={() => onDown(b)}
                  onPointerEnter={() => onEnter(b)}
                  className="flex-1 h-full rounded-[3px] transition-all"
                  style={{
                    background: sel ? 'rgba(128,125,254,0.9)' : heatColor(t),
                    outline:    sel ? '1.5px solid rgba(255,255,255,0.8)' : 'none',
                    outlineOffset: -1.5,
                  }}
                />
              )
            })}
            <motion.div
              className="absolute top-0 bottom-0 w-px pointer-events-none"
              style={{ background: 'rgba(255,255,255,0.85)' }}
              animate={{ left: `${pctOf(price)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
        </div>

        {/* Expiry list */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Expiries</span>
            <button
              onClick={() => setSelected(
                selected.size === expiries.length
                  ? new Set()
                  : new Set(expiries.map(e => e.oracleId))
              )}
              className="text-[10px] text-text-quaternary hover:text-text-secondary transition-colors"
            >
              {selected.size === expiries.length ? 'deselect all' : 'select all'}
            </button>
          </div>

          {expiries.map(e => {
            const { prob, ask } = probFor(e.expiry)
            const on   = selected.has(e.oracleId)
            const win  = stakeNum > 0 ? stakeNum / ask : 0
            const minsLeft = Math.round((e.expiry - now) / 60_000)
            return (
              <button
                key={e.oracleId}
                onClick={() => toggle(e.oracleId)}
                className="flex items-center gap-2 rounded-[7px] px-2.5 py-2 transition-all text-left"
                style={{
                  background: on ? 'rgba(128,125,254,0.08)' : 'var(--color-surface-card)',
                  border:     `1px solid ${on ? 'rgba(128,125,254,0.3)' : 'var(--color-border-subtle)'}`,
                }}
              >
                {/* checkbox dot */}
                <div
                  className="w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 transition-all"
                  style={{
                    borderColor: on ? '#807dfe' : 'var(--color-border-default)',
                    background:  on ? '#807dfe' : 'transparent',
                  }}
                >
                  {on && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>

                {/* expiry time */}
                <span className="font-semibold text-[12px]"
                  style={{ fontFamily: 'var(--font-mono)', color: on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
                  {e.label}
                </span>

                {/* mins left */}
                <span className="text-[10px] text-text-quaternary">
                  {minsLeft < 60 ? `${minsLeft}m` : `${Math.floor(minsLeft / 60)}h`}
                </span>

                {/* prob bar */}
                <div className="flex-1 mx-1 h-1 rounded-full bg-surface-hover overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${Math.min(100, prob * 200)}%`, background: '#807dfe', opacity: on ? 0.8 : 0.3 }}
                  />
                </div>

                {/* prob + payout */}
                <div className="flex flex-col items-end shrink-0">
                  <span className="text-[10px] font-semibold"
                    style={{ fontFamily: 'var(--font-mono)', color: on ? '#807dfe' : 'var(--color-text-quaternary)' }}>
                    {(prob * 100).toFixed(0)}%
                  </span>
                  {stakeNum > 0 && (
                    <span className="text-[9px] text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                      → ${win.toFixed(2)}
                    </span>
                  )}
                </div>
              </button>
            )
          })}

          {expiries.length === 0 && (
            <div className="text-[11px] text-text-quaternary text-center py-4">
              No upcoming expiries today
            </div>
          )}
        </div>

        {/* Stake per expiry */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Stake per expiry</span>
          <div className="flex items-center bg-surface-card rounded-[6px] px-2.5 py-1.5 border border-border-subtle gap-1">
            <span className="text-text-quaternary">$</span>
            <input
              type="number" min={0} value={stake} placeholder="10"
              onChange={e => setStake(e.target.value)}
              className="flex-1 bg-transparent text-[13px] font-medium text-text-primary outline-none w-0"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>
          <div className="flex gap-1">
            {[5, 10, 25, 50].map(v => (
              <button key={v} onClick={() => setStake(String(v))}
                className="flex-1 py-1 rounded-[5px] text-[10px] font-medium transition-colors"
                style={{
                  background: stakeNum === v ? 'var(--color-surface-hover)' : 'var(--color-surface-card)',
                  color:      stakeNum === v ? 'var(--color-text-primary)'   : 'var(--color-text-tertiary)',
                  border:     `1px solid ${stakeNum === v ? 'var(--color-border-default)' : 'var(--color-border-subtle)'}`,
                }}>
                ${v}
              </button>
            ))}
          </div>
        </div>

      </div>

      {/* Footer */}
      <div className="px-3 pb-3 pt-1 shrink-0 flex flex-col gap-1.5">
        {selCount > 0 && stakeNum > 0 && (
          <div className="flex items-center justify-between text-[11px] px-1">
            <span className="text-text-quaternary">{selCount} expir{selCount === 1 ? 'y' : 'ies'}</span>
            <span className="font-semibold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
              ${totalCost.toFixed(2)} total
            </span>
          </div>
        )}
        <button
          disabled={selCount === 0 || stakeNum <= 0}
          className="w-full py-2 text-[12px] font-semibold rounded-[7px] transition-opacity"
          style={{
            background: selCount > 0 && stakeNum > 0 ? '#807dfe' : 'var(--color-surface-hover)',
            color:      selCount > 0 && stakeNum > 0 ? '#fff'    : 'var(--color-text-quaternary)',
            cursor:     selCount > 0 && stakeNum > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          {selCount > 0
            ? `Place across ${selCount} expir${selCount === 1 ? 'y' : 'ies'} · $${totalCost > 0 ? totalCost.toFixed(0) : '0'}`
            : 'Select at least one expiry'}
        </button>
      </div>
    </div>
  )
}
