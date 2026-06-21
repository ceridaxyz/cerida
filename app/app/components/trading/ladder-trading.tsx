import { useState, useEffect, useMemo } from 'react'
import { motion } from 'framer-motion'

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
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2))
const sigmaFor = (hrs: number, step: number) => step * 2 * Math.sqrt(Math.max(hrs, 0.01))

const fmtK = (p: number) =>
  p >= 1000 ? `${(p / 1000).toFixed(1)}k` : String(Math.round(p))

const RUNGS = [3, 5, 7, 9] as const

export default function LadderTrading({
  currentPrice = 66612,
  oracleExpiry,
  underlying = 'BTC',
}: {
  currentPrice?: number
  oracleExpiry?: number
  underlying?: string
}) {
  const expiry   = useMemo(() => oracleExpiry ?? Date.now() + 60 * 60_000, [oracleExpiry])
  const STEP     = useMemo(() => niceStep(currentPrice), [currentPrice])
  const [numRungs, setNumRungs] = useState<number>(5)
  const [stake,    setStake]    = useState('25')

  const [price, setPrice] = useState(currentPrice)
  const [now,   setNow]   = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setPrice(p => p + (currentPrice - p) * 0.05 + (Math.random() - 0.5) * STEP * 0.4)
      setNow(Date.now())
    }, 700)
    return () => clearInterval(id)
  }, [currentPrice, STEP])

  const secsLeft = Math.max(1, (expiry - now) / 1000)
  const sigma    = sigmaFor(secsLeft / 3600, STEP)
  const expStr   = new Date(expiry).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const center = Math.round(price / STEP) * STEP
  const half   = Math.floor(numRungs / 2)

  const rungs = useMemo(() => {
    return Array.from({ length: numRungs }, (_, i) => {
      const lower = center + (i - half) * STEP
      const upper = lower + STEP
      const prob  = normCdf((upper - price) / sigma) - normCdf((lower - price) / sigma)
      const ask   = Math.max(MIN_ASK, Math.min(MAX_ASK, prob + SPREAD))
      return { lower, upper, prob, ask }
    })
  }, [center, numRungs, half, STEP, price, sigma])

  const maxProb      = Math.max(...rungs.map(r => r.prob), 0.001)
  const totalStake   = parseFloat(stake) || 0
  const stakeEach    = totalStake / numRungs
  const winProb      = rungs.reduce((s, r) => s + r.prob, 0)
  const avgPayout    = stakeEach > 0
    ? rungs.reduce((s, r) => s + r.prob * (stakeEach / r.ask), 0) / winProb
    : 0

  // visual domain
  const domainLo = rungs[0]!.lower - STEP
  const domainHi = rungs[rungs.length - 1]!.upper + STEP
  const span     = domainHi - domainLo
  const pctOf    = (p: number) => ((p - domainLo) / span) * 100

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px]">
      <div className="flex flex-col gap-3 px-3 py-3 flex-1 overflow-y-auto no-scrollbar">

        {/* Market */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-semibold text-text-primary">{underlying} · {expStr}</span>
          <span className="text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
            {Math.floor(secsLeft / 60)}m left
          </span>
        </div>

        {/* Bars */}
        <div className="select-none">
          {/* price label */}
          <div className="relative h-5">
            <motion.div
              className="absolute -translate-x-1/2"
              animate={{ left: `${pctOf(price)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            >
              <span className="px-1.5 py-0.5 rounded-[3px] text-[10px] font-bold text-white whitespace-nowrap"
                style={{ background: '#0b9981', fontFamily: 'var(--font-mono)' }}>
                ${fmtK(price)}
              </span>
            </motion.div>
          </div>

          {/* rung bars */}
          <div className="relative flex h-10" style={{ gap: 3 }}>
            <div style={{ flex: pctOf(rungs[0]!.lower), flexShrink: 0 }} />
            {rungs.map((r, i) => {
              const active = price >= r.lower && price < r.upper
              const t = r.prob / maxProb
              const bg = active
                ? '#0b9981'
                : `rgba(${Math.round(96 + t * 159)},${Math.round(92 + t * 96)},${Math.round(255 - t * 225)},${(0.06 + t * 0.55).toFixed(2)})`
              return (
                <div
                  key={i}
                  className="relative flex-1 rounded-[4px] flex items-center justify-center"
                  style={{ background: bg, outline: active ? '1.5px solid rgba(255,255,255,0.6)' : 'none', outlineOffset: -1.5 }}
                >
                  <span className="text-[8px] font-bold" style={{ color: 'rgba(255,255,255,0.7)', fontFamily: 'var(--font-mono)' }}>
                    {(r.prob * 100).toFixed(0)}%
                  </span>
                </div>
              )
            })}
            <div style={{ flex: 100 - pctOf(rungs[rungs.length - 1]!.upper) }} />

            {/* price needle */}
            <motion.div className="absolute top-0 bottom-0 w-px pointer-events-none"
              style={{ background: 'rgba(255,255,255,0.8)' }}
              animate={{ left: `${pctOf(price)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>

          {/* strike labels */}
          <div className="flex mt-1" style={{ gap: 3 }}>
            <div style={{ flex: pctOf(rungs[0]!.lower), flexShrink: 0 }} />
            {rungs.map((r, i) => (
              <div key={i} className="flex-1 text-center">
                <span className="text-[9px] text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                  {fmtK(r.lower)}
                </span>
              </div>
            ))}
            <div style={{ flex: 100 - pctOf(rungs[rungs.length - 1]!.upper) }} />
          </div>
        </div>

        {/* Rung count */}
        <div className="flex gap-1.5">
          {RUNGS.map(n => (
            <button key={n} onClick={() => setNumRungs(n)}
              className="flex-1 py-1 rounded-[5px] text-[11px] font-semibold transition-colors"
              style={{
                background: numRungs === n ? 'rgba(128,125,254,0.14)' : 'var(--color-surface-card)',
                color:      numRungs === n ? '#807dfe' : 'var(--color-text-tertiary)',
                border:     `1px solid ${numRungs === n ? 'rgba(128,125,254,0.3)' : 'var(--color-border-subtle)'}`,
              }}>
              {n}
            </button>
          ))}
        </div>

        {/* Stake */}
        <div className="flex items-center bg-surface-card rounded-[6px] px-2.5 py-1.5 border border-border-subtle gap-1">
          <span className="text-text-quaternary">$</span>
          <input
            type="number" min={0} value={stake} placeholder="25"
            onChange={e => setStake(e.target.value)}
            className="flex-1 bg-transparent text-[13px] font-medium text-text-primary outline-none w-0"
            style={{ fontFamily: 'var(--font-mono)' }}
          />
        </div>
        <div className="flex gap-1">
          {[10, 25, 50, 100].map(v => (
            <button key={v} onClick={() => setStake(String(v))}
              className="flex-1 py-1 rounded-[5px] text-[10px] font-medium transition-colors"
              style={{
                background: totalStake === v ? 'var(--color-surface-hover)' : 'var(--color-surface-card)',
                color:      totalStake === v ? 'var(--color-text-primary)'   : 'var(--color-text-tertiary)',
                border:     `1px solid ${totalStake === v ? 'var(--color-border-default)' : 'var(--color-border-subtle)'}`,
              }}>
              ${v}
            </button>
          ))}
        </div>

        {/* Summary */}
        {totalStake > 0 && (
          <div className="flex items-center justify-between rounded-[7px] bg-surface-card border border-border-subtle px-3 py-2">
            <div className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-text-quaternary">Win chance</span>
              <span className="text-[13px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                {(winProb * 100).toFixed(0)}%
              </span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-[9px] uppercase tracking-wider text-text-quaternary">Per rung</span>
              <span className="text-[13px] font-bold text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                ${stakeEach.toFixed(2)}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[9px] uppercase tracking-wider text-text-quaternary">Avg win</span>
              <span className="text-[13px] font-bold" style={{ fontFamily: 'var(--font-mono)', color: '#0b9981' }}>
                ${avgPayout.toFixed(2)}
              </span>
            </div>
          </div>
        )}

      </div>

      {/* CTA */}
      <div className="px-3 pb-3 pt-1 shrink-0">
        <button
          disabled={totalStake <= 0}
          className="w-full py-2 text-[12px] font-semibold rounded-[7px] transition-opacity"
          style={{
            background: totalStake > 0 ? '#807dfe' : 'var(--color-surface-hover)',
            color:      totalStake > 0 ? '#fff'    : 'var(--color-text-quaternary)',
            cursor:     totalStake > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          Place {numRungs}-rung Ladder · ${totalStake > 0 ? totalStake.toFixed(0) : '0'}
        </button>
      </div>
    </div>
  )
}
