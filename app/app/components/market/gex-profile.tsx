import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getChartOracle, getLatestPrice, getLatestSvi, SCALE } from '../../lib/predict-api'
import { yesNo, impliedVol } from '../../lib/svi'

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

// Deterministic pseudo-random per strike — stable OI shape, no flicker
function srng(strike: number, idx: number) {
  const x = Math.sin(strike * 0.00127 + idx * 311.7) * 43758.5453
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

interface GexInput {
  spot:      number
  forward:   number
  svi:       import('../../lib/svi').Svi
  minStrike: number // raw 1e9-scaled
  tickSize:  number // raw 1e9-scaled
  expiry:    number // ms
}

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

function buildRows(input: GexInput): Row[] {
  const { spot, forward, svi, minStrike, tickSize, expiry } = input
  const step = tickSize / SCALE
  const min  = minStrike / SCALE

  // Center the visible window around spot
  const centerIdx = Math.round((spot - min) / step)
  const startIdx  = Math.max(0, centerIdx - Math.floor(NUM_STRIKES / 2))

  const tYears = Math.max((expiry - Date.now()) / (365.25 * 24 * 3600 * 1000), 1 / 365)
  // 1σ expected move from ATM vol
  const atmVol  = impliedVol(svi, forward, forward, tYears)
  const sig     = atmVol * Math.sqrt(tYears)
  const expUp   = spot * Math.exp( sig)
  const expDown = spot * Math.exp(-sig)

  const raw = Array.from({ length: NUM_STRIKES }, (_, i) => {
    const strike = min + (startIdx + i) * step
    // Real per-strike vol → real gamma
    const vol     = impliedVol(svi, forward, strike, tYears)
    const volT    = Math.max(vol * Math.sqrt(tYears), 1e-9)
    const d1      = Math.log(forward / strike) / volT + 0.5 * volT
    const gamma   = normPdf(d1) / (strike * volT)
    // Real yes/no probabilities from SVI
    const { yes } = yesNo(svi, forward, strike)
    const prob    = yes
    // Stable pseudo-random OI shape (seeded by strike, not time)
    const dStep   = Math.abs(strike - spot) / step
    const oiBase  = 12_000_000 * Math.exp(-0.32 * dStep * dStep)
    const oi      = oiBase * (0.6 + srng(strike, 3) * 0.8)
    // YES buyers cluster above spot (they need price to stay high), NO buyers below
    const yFrac   = prob  // real probability drives the YES/NO OI split
    const gexUnit = gamma * strike * strike * 0.01
    const yesGex  = yFrac       * oi * gexUnit * (0.85 + srng(strike, 11) * 0.3)
    const noGex   = (1 - yFrac) * oi * gexUnit * (0.85 + srng(strike, 13) * 0.3)
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

const LABEL_THEME: Record<string, { bg: string; border: string; text: string; hex: string }> = {
  'YES Wall': { bg: 'bg-surface-card',  border: 'border-bullish-green/50',  text: 'text-bullish-green', hex: '#0b9981' },
  'NO Wall':  { bg: 'bg-surface-card',   border: 'border-bearish-red/50',   text: 'text-bearish-red',  hex: '#f23546' },
  'Pin Risk': { bg: 'bg-surface-card', border: 'border-brand-violet/50', text: 'text-brand-violet', hex: '#807dfe' },
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GexProfile() {
  const [hover, setHover] = useState<number | null>(null)
  const [mode, setMode]   = useState<'net' | 'split'>('net')

  const { data: oracle } = useQuery({
    queryKey: ['gex-oracle'],
    queryFn: getChartOracle,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const { data: priceData } = useQuery({
    queryKey: ['gex-price', oracle?.oracle_id],
    queryFn: () => getLatestPrice(oracle!.oracle_id),
    enabled: !!oracle,
    refetchInterval: 5_000,
  })

  const { data: sviData } = useQuery({
    queryKey: ['gex-svi', oracle?.oracle_id],
    queryFn: () => getLatestSvi(oracle!.oracle_id),
    enabled: !!oracle,
    refetchInterval: 10_000,
  })

  const spot    = priceData?.spot    ?? 0
  const forward = priceData?.forward ?? spot
  const atmVol  = sviData
    ? impliedVol(sviData, forward || spot, forward || spot, Math.max((oracle!.expiry - Date.now()) / (365.25 * 24 * 3600 * 1000), 1 / 365))
    : 0

  const rows = useMemo(() => {
    if (!oracle || !priceData || !sviData) return []
    return buildRows({
      spot:      priceData.spot,
      forward:   priceData.forward,
      svi:       sviData,
      minStrike: oracle.min_strike,
      tickSize:  oracle.tick_size,
      expiry:    oracle.expiry,
    })
  }, [oracle, priceData, sviData])

  const maxAbs = useMemo(() => Math.max(...rows.map(r => Math.abs(r.net)), 1), [rows])

  const yesWall = rows.find(r => r.label === 'YES Wall')
  const noWall  = rows.find(r => r.label === 'NO Wall')
  const pinRisk = rows.find(r => r.label === 'Pin Risk')

  if (!oracle || !priceData || !sviData) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[11px] text-text-quaternary">Loading…</span>
      </div>
    )
  }

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
            { label: 'YES Wall', val: yesWall?.strike, theme: LABEL_THEME['YES Wall'] },
            { label: 'NO Wall',  val: noWall?.strike,  theme: LABEL_THEME['NO Wall'] },
            { label: 'Pin Risk', val: pinRisk?.strike, theme: LABEL_THEME['Pin Risk'] },
          ].map(({ label, val, theme }) => val != null && (
            <div
              key={label}
              className={`flex items-center gap-1.5 text-[10px] px-1.5 py-px rounded-[6px] border-[1.5px] ${theme.bg} ${theme.border}`}
            >
              <span className={`font-semibold ${theme.text}`}>{label}</span>
              <span className="text-text-tertiary">${fmtK(val)}</span>
            </div>
          ))}
          <div className="ml-auto text-[10px] text-text-quaternary">
            IV <span style={{ color: 'var(--color-text-secondary)' }}>{(atmVol * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>

      {/* ── Chart — each row is flex-1 so they share the available height ── */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col px-2 py-px">
        {rows.map((row, i) => {
          const frac    = Math.abs(row.net) / maxAbs
          const isPos   = row.net >= 0
          const hovered = hover === i

          return (
            <div key={row.strike} className="flex-1 flex flex-col min-h-0 justify-center">

              {/* Spot hairline — sits in the flex column of the row that brackets spot */}
              {row.spotLine && (
                <div className="flex items-center gap-1 shrink-0 mb-px">
                  <div className="w-[68px] shrink-0" />
                  <div className="flex-1 flex items-center gap-1">
                    <div className="flex-1 border-t border-dashed border-brand-violet/35" />
                    <span className="text-[9px] font-semibold px-1.5 py-px rounded-[6px] shrink-0 bg-surface-card text-brand-violet border-[1.5px] border-brand-violet/40">
                      ${fmtK(spot)}
                    </span>
                    <div className="flex-1 border-t border-dashed border-brand-violet/35" />
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
                  <div className="absolute inset-0 rounded-[4px] bg-white/3" />
                )}
                {row.inExpMove && (
                  <div className="absolute inset-y-0 left-[68px] right-[48px] rounded-sm pointer-events-none bg-brand-violet/4" />
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
                      className={`absolute rounded-[2px] transition-all duration-500 ${
                        isPos
                          ? (hovered ? 'bg-bullish-green/90' : 'bg-bullish-green/65')
                          : (hovered ? 'bg-bearish-red/90' : 'bg-bearish-red/65')
                      }`}
                      style={{
                        height:    hovered ? 9 : 7,
                        top: '50%', transform: 'translateY(-50%)',
                        ...(isPos
                          ? { left: '50%',  width: `${frac * 47}%` }
                          : { right: '50%', width: `${frac * 47}%` }),
                      }}
                    />
                  ) : (
                    <>
                      <div className={`absolute rounded-[2px] transition-all duration-500 ${hovered ? 'bg-bullish-green/85' : 'bg-bullish-green/60'}`}
                        style={{
                          height: 4, top: '50%', transform: 'translateY(-140%)',
                          left: '50%',
                          width: `${(row.yesGex / (maxAbs * 2)) * 94}%`,
                        }}
                      />
                      <div className={`absolute rounded-[2px] transition-all duration-500 ${hovered ? 'bg-bearish-red/85' : 'bg-bearish-red/60'}`}
                        style={{
                          height: 4, top: '50%', transform: 'translateY(40%)',
                          right: '50%',
                          width: `${(row.noGex / (maxAbs * 2)) * 94}%`,
                        }}
                      />
                    </>
                  )}

                  {/* Key level badge */}
                  {row.label && (
                    <div
                      className={`absolute text-[9px] font-bold px-1.5 py-px rounded-[6px] whitespace-nowrap z-10 border-[1.5px] ${LABEL_THEME[row.label].bg} ${LABEL_THEME[row.label].text} ${LABEL_THEME[row.label].border}`}
                      style={{
                        top: '50%', transform: 'translateY(-50%)',
                        ...(isPos || row.label === 'Pin Risk'
                          ? { left:  `calc(50% + ${frac * 47}% + 4px)` }
                          : { right: `calc(50% + ${frac * 47}% + 4px)` }),
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
                    className="absolute z-50 rounded-[7px] border border-border-default shadow-xl"
                    style={{
                      left:       'calc(68px + 4px)',
                      top:        '50%',
                      transform:  'translateY(-50%)',
                      background: 'var(--color-surface-card)',
                      minWidth:   156,
                      padding:    '6px 10px',
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-bold text-text-primary">${fmtK(row.strike)}</span>
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-px rounded-[6px] border-[1.5px] ${
                          row.prob > 0.5 ? 'bg-surface-primary border-bullish-green/30 text-bullish-green' : 'bg-surface-primary border-bearish-red/30 text-bearish-red'
                        }`}
                      >
                        YES {(row.prob * 100).toFixed(1)}%
                      </span>
                    </div>
                    {[
                      ['Net GEX',   fmtM(row.net),    isPos ? '#0b9981' : '#f23546'],
                      ['YES Γ',     fmtM(row.yesGex), '#0b9981'],
                      ['NO Γ',      fmtM(row.noGex),  '#f23546'],
                      ['OI',        fmtM(row.oi),     'var(--color-text-secondary)'],
                    ].map(([label, val, color]) => (
                      <div key={label as string} className="flex items-center justify-between gap-4">
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

      {/* ── Footer ── */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-t border-border-subtle">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-[2px] bg-bullish-green/70" />
          <span className="text-[10px] text-text-quaternary">YES Γ</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-[2px] bg-bearish-red/70" />
          <span className="text-[10px] text-text-quaternary">NO Γ</span>
        </div>
        <div className="flex items-center gap-1.5 ml-1">
          <span className="w-2 h-2 rounded-[2px] bg-brand-violet/18 border border-brand-violet/30" />
          <span className="text-[10px] text-text-quaternary">1σ move</span>
        </div>
        <div className="ml-auto text-[11px] font-semibold text-text-primary">
          ${fmtK(priceData.spot)}
        </div>
      </div>
    </div>
  )
}
