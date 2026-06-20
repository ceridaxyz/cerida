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
  const target = Math.max(1, price * 0.003)
  const pow    = 10 ** Math.floor(Math.log10(target))
  const mult   = [1, 2, 2.5, 5, 10].find(m => m * pow >= target) ?? 10
  return mult * pow
}

function srng(seed: number, idx: number) {
  const x = Math.sin(seed * 127.1 + idx * 311.7) * 43758.5453
  return x - Math.floor(x)
}

function fmtM(v: number) {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return v.toFixed(0)
}

function fmtK(s: number) {
  if (s >= 1000) return `${(s / 1000).toFixed(s % 1000 === 0 ? 0 : 1)}k`
  return s >= 100 ? s.toFixed(0) : s.toFixed(2)
}

// ── GEX model ─────────────────────────────────────────────────────────────────

const NUM_STRIKES = 22

interface Row {
  strike:    number
  net:       number
  yesGex:   number
  noGex:    number
  oi:        number
  prob:      number
  label?:    'YES Wall' | 'NO Wall' | 'Pin Risk'
  spotLine:  boolean
  inExpMove: boolean
}

function buildRows(spot: number, iv: number, seed: number): Row[] {
  const step = niceStep(spot)
  const base = Math.round(spot / step) * step
  const T    = 0.5 / 365
  const sig  = iv * Math.sqrt(T)
  const expUp   = spot * Math.exp( sig)
  const expDown = spot * Math.exp(-sig)

  const raw = Array.from({ length: NUM_STRIKES }, (_, i) => {
    const strike = base + (i - Math.floor(NUM_STRIKES / 2)) * step
    const d      = Math.log(spot / strike) / sig
    const gamma  = normPdf(d) / (spot * sig)
    const prob   = normCdf(d)
    const dStep  = Math.abs(strike - spot) / step
    const oiBase = 12_000_000 * Math.exp(-0.32 * dStep * dStep)
    const oi     = oiBase * (0.6 + srng(seed, i * 3) * 0.8)
    const yFrac  = strike > spot
      ? 0.60 + srng(seed + 1, i * 7) * 0.28
      : 0.24 + srng(seed + 2, i * 5) * 0.20
    const gexUnit = gamma * spot * spot * 0.01
    const yesGex  = yFrac       * oi * gexUnit * (0.85 + srng(seed + 3, i * 11) * 0.3)
    const noGex   = (1 - yFrac) * oi * gexUnit * (0.85 + srng(seed + 4, i * 13) * 0.3)
    return {
      strike, net: yesGex - noGex, yesGex, noGex, oi, prob,
      label: undefined as Row['label'],
      spotLine:  false,
      inExpMove: strike >= expDown && strike <= expUp,
    }
  }).reverse()

  const maxYes = Math.max(...raw.map(r => r.yesGex))
  const maxNo  = Math.max(...raw.map(r => r.noGex))
  const minAbs = raw.reduce((b, r) => Math.abs(r.net) < Math.abs(b.net) ? r : b, raw[0]!)
  const spotIdx = raw.findIndex(r => r.strike <= spot)

  return raw.map((r, i) => ({
    ...r,
    spotLine: i === spotIdx,
    label: r.yesGex === maxYes ? 'YES Wall'
         : r.noGex  === maxNo  ? 'NO Wall'
         : r         === minAbs ? 'Pin Risk'
         : undefined,
  }))
}

// ── Label styling ─────────────────────────────────────────────────────────────

const LABEL_STYLE: Record<string, { bg: string; border: string; color: string }> = {
  'YES Wall': { bg: 'rgba(11,153,129,0.13)',  border: 'rgba(11,153,129,0.35)',  color: '#0b9981' },
  'NO Wall':  { bg: 'rgba(242,53,70,0.13)',   border: 'rgba(242,53,70,0.35)',   color: '#f23546' },
  'Pin Risk': { bg: 'rgba(128,125,254,0.13)', border: 'rgba(128,125,254,0.35)', color: '#807dfe' },
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GexProfile() {
  const [spot, setSpot]   = useState(66_500)
  const [iv,   setIv]     = useState(0.62)
  const [seed, setSeed]   = useState(() => Math.floor(Date.now() / 20_000))
  const [hover, setHover] = useState<number | null>(null)
  const [mode, setMode]   = useState<'net' | 'split'>('net')

  useEffect(() => {
    const id = setInterval(() => {
      setSpot(s => Math.max(10_000, s + (Math.random() - 0.49) * 140))
      setIv(v   => Math.max(0.25, Math.min(1.5, v + (Math.random() - 0.5) * 0.02)))
      setSeed(s => s + 1)
    }, 2500)
    return () => clearInterval(id)
  }, [])

  const rows   = useMemo(() => buildRows(spot, iv, seed), [spot, iv, seed])
  const maxAbs = useMemo(() => Math.max(...rows.map(r => Math.abs(r.net)), 1), [rows])

  const yesWall = rows.find(r => r.label === 'YES Wall')
  const noWall  = rows.find(r => r.label === 'NO Wall')
  const pinRisk = rows.find(r => r.label === 'Pin Risk')

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: 'var(--color-surface-primary)', fontFamily: 'var(--font-mono)' }}
    >
      {/* ── Header ── */}
      <div className="shrink-0 px-3 pt-2 pb-1.5 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-text-secondary">
              GEX Profile
            </span>
            <span className="text-[10px] text-text-quaternary">· net Γ / 1% move</span>
          </div>
          <div className="flex items-center gap-0.5">
            {(['net', 'split'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-[5px] transition-colors"
                style={{
                  background: mode === m ? 'var(--color-surface-card)' : 'transparent',
                  color:      mode === m ? 'var(--color-text-primary)'  : 'var(--color-text-quaternary)',
                  border:     mode === m ? '1px solid var(--color-border-subtle)' : '1px solid transparent',
                }}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Key levels summary */}
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { label: 'YES Wall', val: yesWall?.strike, color: '#0b9981' },
            { label: 'NO Wall',  val: noWall?.strike,  color: '#f23546' },
            { label: 'Pin Risk', val: pinRisk?.strike, color: '#807dfe' },
          ].map(({ label, val, color }) => val != null && (
            <div
              key={label}
              className="flex items-center gap-1.5 text-[10px] px-1.5 py-px rounded-[4px]"
              style={{ background: `${color}11`, border: `1px solid ${color}28` }}
            >
              <span style={{ color, fontWeight: 600 }}>{label}</span>
              <span style={{ color: 'var(--color-text-tertiary)' }}>${fmtK(val)}</span>
            </div>
          ))}
          <div className="ml-auto text-[10px] text-text-quaternary">
            IV <span style={{ color: 'var(--color-text-secondary)' }}>{(iv * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>

      {/* ── Chart — each row is flex-1 so they share the available height ── */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col px-2 py-px">
        {rows.map((row, i) => {
          const frac    = Math.abs(row.net) / maxAbs
          const isPos   = row.net >= 0
          const hovered = hover === i
          const ls      = row.label ? LABEL_STYLE[row.label] : null

          return (
            <div key={row.strike} className="flex-1 flex flex-col min-h-0 justify-center">

              {/* Spot hairline — sits in the flex column of the row that brackets spot */}
              {row.spotLine && (
                <div className="flex items-center gap-1 shrink-0 mb-px">
                  <div className="w-[68px] shrink-0" />
                  <div className="flex-1 flex items-center gap-1">
                    <div className="flex-1 border-t" style={{ borderColor: 'rgba(128,125,254,0.35)', borderStyle: 'dashed' }} />
                    <span
                      className="text-[9px] font-semibold px-1.5 py-px rounded-[3px] shrink-0"
                      style={{ background: 'rgba(128,125,254,0.15)', color: '#807dfe', border: '1px solid rgba(128,125,254,0.3)' }}
                    >
                      ${fmtK(spot)}
                    </span>
                    <div className="flex-1 border-t" style={{ borderColor: 'rgba(128,125,254,0.35)', borderStyle: 'dashed' }} />
                  </div>
                  <div className="w-[48px] shrink-0" />
                </div>
              )}

              {/* Data row */}
              <div
                className="relative flex items-center flex-1 min-h-0"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {hovered && (
                  <div className="absolute inset-0 rounded-[4px]"
                    style={{ background: 'rgba(255,255,255,0.03)' }} />
                )}
                {row.inExpMove && (
                  <div className="absolute inset-y-0 left-[68px] right-[48px] rounded-sm pointer-events-none"
                    style={{ background: 'rgba(128,125,254,0.04)' }} />
                )}

                {/* Strike label */}
                <div
                  className="w-[68px] shrink-0 text-right pr-2 leading-none select-none"
                  style={{
                    fontSize: 11,
                    color: hovered ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                    fontWeight: row.inExpMove ? 600 : 400,
                  }}
                >
                  {fmtK(row.strike)}
                </div>

                {/* Bar track */}
                <div className="flex-1 relative flex items-center" style={{ height: 10 }}>
                  {/* Zero axis */}
                  <div
                    className="absolute top-0 bottom-0 w-px"
                    style={{ left: '50%', background: 'var(--color-border-subtle)' }}
                  />

                  {mode === 'net' ? (
                    <div
                      className="absolute rounded-[2px] transition-all duration-500"
                      style={{
                        height:    hovered ? 9 : 7,
                        top: '50%', transform: 'translateY(-50%)',
                        ...(isPos
                          ? { left: '50%',  width: `${frac * 47}%` }
                          : { right: '50%', width: `${frac * 47}%` }),
                        background: isPos
                          ? `rgba(11,153,129,${hovered ? 0.9 : 0.65})`
                          : `rgba(242,53,70,${hovered  ? 0.9 : 0.65})`,
                      }}
                    />
                  ) : (
                    <>
                      <div className="absolute rounded-[2px] transition-all duration-500"
                        style={{
                          height: 4, top: '50%', transform: 'translateY(-140%)',
                          left: '50%',
                          width: `${(row.yesGex / (maxAbs * 2)) * 94}%`,
                          background: `rgba(11,153,129,${hovered ? 0.85 : 0.6})`,
                        }}
                      />
                      <div className="absolute rounded-[2px] transition-all duration-500"
                        style={{
                          height: 4, top: '50%', transform: 'translateY(40%)',
                          right: '50%',
                          width: `${(row.noGex / (maxAbs * 2)) * 94}%`,
                          background: `rgba(242,53,70,${hovered ? 0.85 : 0.6})`,
                        }}
                      />
                    </>
                  )}

                  {/* Key level badge */}
                  {ls && (
                    <div
                      className="absolute text-[9px] font-bold px-1.5 py-px rounded-[3px] whitespace-nowrap z-10"
                      style={{
                        top: '50%', transform: 'translateY(-50%)',
                        ...(isPos || row.label === 'Pin Risk'
                          ? { left:  `calc(50% + ${frac * 47}% + 4px)` }
                          : { right: `calc(50% + ${frac * 47}% + 4px)` }),
                        background: ls.bg, color: ls.color, border: `1px solid ${ls.border}`,
                      }}
                    >
                      {row.label}
                    </div>
                  )}
                </div>

                {/* Probability */}
                <div
                  className="w-[48px] shrink-0 text-right pr-1 leading-none"
                  style={{
                    fontSize: 10,
                    color:   row.prob > 0.5 ? '#0b9981' : '#f23546',
                    opacity: hovered ? 1 : 0.65,
                    fontWeight: hovered ? 600 : 400,
                  }}
                >
                  {(row.prob * 100).toFixed(0)}%
                </div>

                {/* Hover tooltip */}
                {hovered && (
                  <div
                    className="absolute z-50 rounded-[10px] border border-border-default shadow-2xl"
                    style={{
                      left:       'calc(68px + 4px)',
                      top:        '50%',
                      transform:  'translateY(-50%)',
                      background: 'var(--color-surface-card)',
                      minWidth:   192,
                      padding:    '10px 14px',
                    }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[12px] font-bold text-text-primary">${fmtK(row.strike)}</span>
                      <span
                        className="text-[11px] font-semibold px-2 py-0.5 rounded-[5px]"
                        style={{
                          background: row.prob > 0.5 ? 'rgba(11,153,129,0.15)' : 'rgba(242,53,70,0.15)',
                          color:      row.prob > 0.5 ? '#0b9981' : '#f23546',
                        }}
                      >
                        YES {(row.prob * 100).toFixed(1)}%
                      </span>
                    </div>
                    {[
                      ['Net GEX',   fmtM(row.net),    isPos ? '#0b9981' : '#f23546'],
                      ['YES Gamma', fmtM(row.yesGex), '#0b9981'],
                      ['NO Gamma',  fmtM(row.noGex),  '#f23546'],
                      ['Open Int',  fmtM(row.oi),     'var(--color-text-secondary)'],
                      ['Exp. Move', row.inExpMove ? '✓ inside 1σ' : '— outside', row.inExpMove ? '#807dfe' : 'var(--color-text-quaternary)'],
                    ].map(([label, val, color]) => (
                      <div key={label as string} className="flex items-center justify-between mt-1">
                        <span className="text-[10px] text-text-quaternary">{label}</span>
                        <span className="text-[10px] font-medium" style={{ color: color as string }}>{val}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Footer ── */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-t border-border-subtle">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-[2px]" style={{ background: 'rgba(11,153,129,0.7)' }} />
          <span className="text-[10px] text-text-quaternary">YES Γ</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-[2px]" style={{ background: 'rgba(242,53,70,0.7)' }} />
          <span className="text-[10px] text-text-quaternary">NO Γ</span>
        </div>
        <div className="flex items-center gap-1.5 ml-1">
          <span className="w-2 h-2 rounded-[2px]" style={{ background: 'rgba(128,125,254,0.18)', border: '1px solid rgba(128,125,254,0.3)' }} />
          <span className="text-[10px] text-text-quaternary">1σ move</span>
        </div>
        <div className="ml-auto text-[11px] font-semibold text-text-primary">
          ${fmtK(spot)}
        </div>
      </div>
    </div>
  )
}
