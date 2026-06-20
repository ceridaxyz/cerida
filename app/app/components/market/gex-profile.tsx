import { useEffect, useMemo, useState } from 'react'

// ── Math ─────────────────────────────────────────────────────────────────────

function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const r = 1 - p * Math.exp(-x * x)
  return x >= 0 ? r : -r
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))
const normPdf = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)

function niceStep(price: number) {
  const target = Math.max(1, price * 0.004)
  const pow    = 10 ** Math.floor(Math.log10(target))
  const mult   = [1, 2, 2.5, 5, 10].find(m => m * pow >= target) ?? 10
  return mult * pow
}

function seededRng(seed: number, idx: number) {
  const x = Math.sin(seed * 127.1 + idx * 311.7) * 43758.5453
  return x - Math.floor(x)
}

function fmtCompact(v: number) {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return v.toFixed(0)
}

function fmtStrike(s: number) {
  return s >= 1000
    ? s.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : s.toFixed(2)
}

// ── GEX Computation ───────────────────────────────────────────────────────────

const NUM_STRIKES = 16

interface GexRow {
  strike:   number
  net:      number
  callGex:  number
  putGex:   number
  oi:       number
  prob:     number
  label?:   'CW' | 'PW' | 'MP'
  spotLine: boolean
}

function computeGex(spot: number, iv: number, seed: number): GexRow[] {
  const step = niceStep(spot)
  const base = Math.round(spot / step) * step

  const raw = Array.from({ length: NUM_STRIKES }, (_, i) => {
    const strike  = base + (i - Math.floor(NUM_STRIKES / 2)) * step
    const T       = 1 / 365 / 2          // ~12-hour binary, short gamma
    const sigma   = iv * Math.sqrt(T)
    const d       = Math.log(spot / strike) / sigma
    const gamma   = normPdf(d) / (spot * sigma)
    const prob    = normCdf(d)

    const dStep   = Math.abs(strike - spot) / step
    const oiBase  = 8_000_000 * Math.exp(-0.38 * dStep * dStep)
    const oiNoise = seededRng(seed, i * 3)
    const oi      = oiBase * (0.65 + oiNoise * 0.7)

    // Above spot → calls dominate; below → puts dominate; noise for realism
    const n1          = seededRng(seed + 1, i * 7)
    const n2          = seededRng(seed + 2, i * 11)
    const callFrac    = strike > spot
      ? 0.62 + n1 * 0.22
      : 0.22 + n1 * 0.18
    const putFrac     = 1 - callFrac

    const gexUnit = gamma * spot * spot * 0.01   // $ per 1% move
    const callGex = callFrac * oi * gexUnit * (1 + n2 * 0.25)
    const putGex  = putFrac  * oi * gexUnit * (1 + seededRng(seed + 3, i * 5) * 0.25)
    const net     = callGex - putGex

    return { strike, net, callGex, putGex, oi, prob, spotLine: false }
  }).reverse()   // highest strike first

  // Mark special levels
  const maxCall = Math.max(...raw.map(r => r.callGex))
  const maxPut  = Math.max(...raw.map(r => r.putGex))
  const minAbs  = raw.reduce((best, r) => Math.abs(r.net) < Math.abs(best.net) ? r : best, raw[0]!)

  // Mark the spot line: insert it between the two strikes that bracket spot
  const spotIdx = raw.findIndex(r => r.strike <= spot)

  return raw.map((r, i) => ({
    ...r,
    label: r.callGex === maxCall ? 'CW'
         : r.putGex  === maxPut  ? 'PW'
         : r === minAbs          ? 'MP'
         : undefined,
    spotLine: i === spotIdx,
  }))
}

// ── Component ─────────────────────────────────────────────────────────────────

type Mode = 'net' | 'split'

export default function GexProfile() {
  const [spot, setSpot]     = useState(66_500)
  const [iv,   setIv]       = useState(0.62)
  const [seed, setSeed]     = useState(() => Math.floor(Date.now() / 20_000))
  const [hover, setHover]   = useState<number | null>(null)
  const [mode, setMode]     = useState<Mode>('net')

  useEffect(() => {
    const id = setInterval(() => {
      setSpot(s => Math.max(10_000, s + (Math.random() - 0.49) * 150))
      setIv(v   => Math.max(0.25, Math.min(1.5, v + (Math.random() - 0.5) * 0.025)))
      setSeed(s => s + 1)
    }, 2500)
    return () => clearInterval(id)
  }, [])

  const rows   = useMemo(() => computeGex(spot, iv, seed), [spot, iv, seed])
  const maxAbs = useMemo(() => Math.max(...rows.map(r => Math.abs(r.net)), 1), [rows])

  const LABEL_COLOR: Record<string, { bg: string; border: string; text: string }> = {
    CW: { bg: 'rgba(11,153,129,0.12)',  border: 'rgba(11,153,129,0.3)',  text: '#0b9981' },
    PW: { bg: 'rgba(242,53,70,0.12)',   border: 'rgba(242,53,70,0.3)',   text: '#f23546' },
    MP: { bg: 'rgba(128,125,254,0.12)', border: 'rgba(128,125,254,0.3)', text: '#807dfe' },
  }

  return (
    <div
      className="flex flex-col h-full no-scrollbar"
      style={{ background: 'var(--color-surface-primary)', fontFamily: 'var(--font-mono)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">GEX Profile</span>
          <span className="text-[9px] text-text-quaternary opacity-40">·</span>
          <span className="text-[9px] text-text-quaternary">Net Γ / 1% move</span>
        </div>
        <div className="flex items-center gap-0.5">
          {(['net', 'split'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="text-[9px] uppercase tracking-widest px-2 py-0.5 rounded-[5px] transition-colors"
              style={{
                background: mode === m ? 'var(--color-surface-card)' : 'transparent',
                color:      mode === m ? 'var(--color-text-primary)' : 'var(--color-text-quaternary)',
                border:     mode === m ? '1px solid var(--color-border-subtle)' : '1px solid transparent',
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Chart body */}
      <div className="flex-1 min-h-0 flex flex-col px-2 py-1 justify-around overflow-hidden">
        {rows.map((row, i) => {
          const frac    = Math.abs(row.net) / maxAbs
          const isPos   = row.net >= 0
          const hovered = hover === i
          const lc      = row.label ? LABEL_COLOR[row.label] : null

          return (
            <div key={row.strike}>
              {/* Current spot hairline */}
              {row.spotLine && (
                <div className="flex items-center gap-2 my-0.5 select-none">
                  <div className="w-12 shrink-0" />
                  <div className="flex-1 border-t border-dashed"
                    style={{ borderColor: 'rgba(128,125,254,0.45)' }} />
                  <span
                    className="text-[8px] font-semibold px-1.5 py-0.5 rounded-[3px] shrink-0"
                    style={{ background: 'rgba(128,125,254,0.15)', color: '#807dfe', border: '1px solid rgba(128,125,254,0.3)' }}
                  >
                    ${fmtStrike(spot)}
                  </span>
                  <div className="flex-1 border-t border-dashed"
                    style={{ borderColor: 'rgba(128,125,254,0.45)' }} />
                  <div className="w-12 shrink-0" />
                </div>
              )}

              {/* Row */}
              <div
                className="relative flex items-center cursor-default"
                style={{ height: 20 }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {/* Subtle row highlight on hover */}
                {hovered && (
                  <div className="absolute inset-0 rounded-[4px]"
                    style={{ background: 'rgba(255,255,255,0.025)' }} />
                )}

                {/* Strike label */}
                <div className="w-12 text-right shrink-0 pr-2 text-[9px] text-text-quaternary select-none">
                  {fmtStrike(row.strike)}
                </div>

                {/* Bar track */}
                <div className="flex-1 relative flex items-center" style={{ height: 14 }}>
                  {/* Center zero line */}
                  <div
                    className="absolute top-0 bottom-0 w-px"
                    style={{ left: '50%', background: 'var(--color-border-default)' }}
                  />

                  {mode === 'net' ? (
                    <div
                      className="absolute rounded-sm transition-all duration-500"
                      style={{
                        height: hovered ? 10 : 8,
                        top:    '50%',
                        transform: 'translateY(-50%)',
                        ...(isPos
                          ? { left: '50%', width: `${frac * 48}%` }
                          : { right: '50%', width: `${frac * 48}%` }),
                        background: isPos
                          ? `rgba(11,153,129,${hovered ? 0.85 : 0.65})`
                          : `rgba(242,53,70,${hovered  ? 0.85 : 0.65})`,
                      }}
                    />
                  ) : (
                    <>
                      <div
                        className="absolute rounded-sm transition-all duration-500"
                        style={{
                          height: hovered ? 5 : 4, top: '50%', transform: 'translateY(-120%)',
                          left: '50%',
                          width: `${(row.callGex / (maxAbs * 2)) * 96}%`,
                          background: `rgba(11,153,129,${hovered ? 0.8 : 0.6})`,
                        }}
                      />
                      <div
                        className="absolute rounded-sm transition-all duration-500"
                        style={{
                          height: hovered ? 5 : 4, top: '50%', transform: 'translateY(20%)',
                          right: '50%',
                          width: `${(row.putGex / (maxAbs * 2)) * 96}%`,
                          background: `rgba(242,53,70,${hovered ? 0.8 : 0.6})`,
                        }}
                      />
                    </>
                  )}

                  {/* Key level badge */}
                  {lc && (
                    <div
                      className="absolute text-[8px] font-bold px-1.5 py-px rounded-[3px] shrink-0 whitespace-nowrap z-10"
                      style={{
                        ...(isPos || row.label === 'MP'
                          ? { left: `calc(50% + ${frac * 48}% + 3px)` }
                          : { right: `calc(50% + ${frac * 48}% + 3px)` }),
                        background: lc.bg, color: lc.text, border: `1px solid ${lc.border}`,
                        top: '50%', transform: 'translateY(-50%)',
                      }}
                    >
                      {row.label} {fmtStrike(row.strike)}
                    </div>
                  )}
                </div>

                {/* Net value */}
                <div
                  className="w-12 text-left pl-1 text-[9px] shrink-0 transition-opacity"
                  style={{
                    color:   isPos ? '#0b9981' : '#f23546',
                    opacity: hovered ? 1 : 0.55,
                  }}
                >
                  {isPos ? '+' : ''}{fmtCompact(row.net)}
                </div>

                {/* Hover tooltip */}
                {hovered && (
                  <div
                    className="absolute left-14 z-50 rounded-[9px] border border-border-default shadow-2xl"
                    style={{
                      top: '50%', transform: 'translateY(-50%)',
                      background: 'var(--color-surface-card)',
                      minWidth: 160, padding: '8px 12px',
                    }}
                  >
                    <div className="text-[10px] font-semibold text-text-primary mb-1.5">
                      ${fmtStrike(row.strike)}
                    </div>
                    {[
                      ['Net GEX',   fmtCompact(row.net),     isPos ? '#0b9981' : '#f23546'],
                      ['Call Γ',    fmtCompact(row.callGex),  '#0b9981'],
                      ['Put Γ',     fmtCompact(row.putGex),   '#f23546'],
                      ['Prob ≥',    `${(row.prob * 100).toFixed(1)}%`, 'var(--color-text-secondary)'],
                      ['Open Int',  fmtCompact(row.oi),       'var(--color-text-quaternary)'],
                    ].map(([label, val, color]) => (
                      <div key={label as string} className="flex items-center justify-between gap-4 mt-0.5">
                        <span className="text-[9px] text-text-quaternary">{label}</span>
                        <span className="text-[9px] font-medium" style={{ color: color as string }}>{val}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border-subtle shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: '#0b9981' }} />
          <span className="text-[8px] text-text-quaternary">Call Γ</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: '#f23546' }} />
          <span className="text-[8px] text-text-quaternary">Put Γ</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[9px] text-text-tertiary">
            ${fmtStrike(spot)}
          </span>
          <span className="text-[9px] text-text-quaternary">
            IV {(iv * 100).toFixed(0)}%
          </span>
        </div>
      </div>
    </div>
  )
}
