import { useState, useMemo, useEffect } from 'react'
import Plotly from 'plotly.js-dist-min'

// ── Math ──────────────────────────────────────────────────────────────────────
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x))
  return x >= 0 ? y : -y
}
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2))

const SPREAD = 0.025

function sigmaFor(hrsLeft: number, step: number) {
  return step * 2 * Math.sqrt(Math.max(hrsLeft, 0.01))
}

function binaryProb(price: number, strike: number, isUp: boolean, sigma: number) {
  return isUp ? 1 - normCdf((strike - price) / sigma) : normCdf((strike - price) / sigma)
}

function rangeProb(price: number, lower: number, higher: number, sigma: number) {
  return normCdf((higher - price) / sigma) - normCdf((lower - price) / sigma)
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Mode = 'range' | 'binary-up' | 'binary-down'

interface Props {
  currentPrice?: number
  underlying?: string
}

const PRICE_POINTS = 40
const TIME_POINTS  = 30

export default function PnlSurface({ currentPrice = 66612, underlying = 'BTC' }: Props) {
  const [mode,   setMode]   = useState<Mode>('range')
  const [cost,   setCost]   = useState('10')
  const [lower,  setLower]  = useState(() => Math.round(currentPrice * 0.985 / 250) * 250)
  const [higher, setHigher] = useState(() => Math.round(currentPrice * 1.015 / 250) * 250)
  const [strike, setStrike] = useState(() => Math.round(currentPrice / 250) * 250)
  const [hrsMax, setHrsMax] = useState(8)

  const step = useMemo(() => {
    const target = currentPrice * 0.0035
    const pow = 10 ** Math.floor(Math.log10(target))
    const mult = [1, 2, 2.5, 5, 10].find((m) => m * pow >= target) ?? 10
    return mult * pow
  }, [currentPrice])

  const costNum = parseFloat(cost) || 10

  const { prices, hours, z, zMin, zMax } = useMemo(() => {
    const halfSpan = (PRICE_POINTS / 2) * step
    const prices   = Array.from({ length: PRICE_POINTS }, (_, i) =>
      currentPrice - halfSpan + i * step,
    )
    const hours = Array.from({ length: TIME_POINTS }, (_, i) =>
      hrsMax * (1 - i / (TIME_POINTS - 1)),
    )

    const z: number[][] = hours.map((h) => {
      const sigma = sigmaFor(h, step)
      return prices.map((p) => {
        let prob: number
        if (mode === 'range') {
          prob = rangeProb(p, lower, higher, sigma)
        } else {
          prob = binaryProb(p, strike, mode === 'binary-up', sigma)
        }
        const ask    = Math.max(0.01, Math.min(0.99, prob + SPREAD))
        const payout = costNum / ask
        return prob * payout - costNum
      })
    })

    let zMin = Infinity, zMax = -Infinity
    for (const row of z) for (const v of row) { if (v < zMin) zMin = v; if (v > zMax) zMax = v }
    return { prices, hours, z, zMin, zMax }
  }, [mode, lower, higher, strike, costNum, hrsMax, currentPrice, step])

  // Custom red-zero-green colorscale
  const colorscale: [number, string][] = useMemo(() => {
    const span = zMax - zMin || 1
    const zeroFrac = (0 - zMin) / span
    return [
      [0,        'rgb(180,30,30)'],
      [Math.max(0, zeroFrac - 0.01), 'rgb(220,60,60)'],
      [zeroFrac, 'rgb(30,30,30)'],
      [Math.min(1, zeroFrac + 0.01), 'rgb(40,160,120)'],
      [1,        'rgb(20,210,140)'],
    ]
  }, [zMin, zMax])

  useEffect(() => {
    const el = document.getElementById('pnl-surface-plot')
    if (!el) return

    const surface: Partial<Plotly.Data> = {
      type: 'surface' as const,
      x: prices,
      y: hours,
      z,
      colorscale,
      cmin: zMin,
      cmax: zMax,
      showscale: false,
      contours: {
        z: { show: true, usecolormap: true, highlightcolor: 'rgba(255,255,255,0.3)', project: { z: false } },
      },
      hovertemplate: `Price: $%{x:.0f}<br>Hours left: %{y:.1f}h<br>P&L: $%{z:.2f}<extra></extra>`,
    } as Plotly.Data

    const layout: Partial<Plotly.Layout> = {
      paper_bgcolor: 'transparent',
      plot_bgcolor:  'transparent',
      margin: { l: 0, r: 0, t: 0, b: 0 },
      scene: {
        bgcolor: 'transparent',
        xaxis: {
          title: { text: `${underlying} Price`, font: { color: '#888', size: 10 } },
          tickfont:    { color: '#666', size: 9 },
          gridcolor:   'rgba(255,255,255,0.06)',
          showbackground: false,
          zerolinecolor: 'rgba(255,255,255,0.1)',
        },
        yaxis: {
          title: { text: 'Hours to expiry', font: { color: '#888', size: 10 } },
          tickfont:    { color: '#666', size: 9 },
          gridcolor:   'rgba(255,255,255,0.06)',
          showbackground: false,
        },
        zaxis: {
          title: { text: 'P&L ($)', font: { color: '#888', size: 10 } },
          tickfont:    { color: '#666', size: 9 },
          gridcolor:   'rgba(255,255,255,0.06)',
          showbackground: false,
          zerolinecolor: 'rgba(255,255,255,0.3)',
        },
        camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } },
      },
    }

    Plotly.react(el, [surface], layout, {
      displayModeBar: false,
      responsive: true,
    })
  }, [prices, hours, z, colorscale, zMin, zMax, underlying])

  const fmtPrice = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: 0 })

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px]">

      {/* Controls */}
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-semibold text-text-primary">P&L Surface</span>
          <span className="text-[10px] text-text-quaternary">{underlying} · theoretical value over price × time</span>
        </div>

        {/* Mode */}
        <div className="flex gap-1">
          {(['range', 'binary-up', 'binary-down'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="flex-1 py-1 rounded-[5px] text-[10px] font-semibold transition-colors"
              style={{
                background: mode === m ? 'rgba(128,125,254,0.14)' : 'var(--color-surface-card)',
                color:      mode === m ? '#807dfe' : 'var(--color-text-tertiary)',
                border:     `1px solid ${mode === m ? 'rgba(128,125,254,0.3)' : 'var(--color-border-subtle)'}`,
              }}
            >
              {m === 'range' ? 'Range' : m === 'binary-up' ? 'Binary ↑' : 'Binary ↓'}
            </button>
          ))}
        </div>

        {/* Params */}
        <div className="flex gap-2 items-end">
          {mode === 'range' ? (
            <>
              <label className="flex flex-col gap-0.5 flex-1">
                <span className="text-[9px] uppercase text-text-quaternary">Lower</span>
                <input
                  type="number" value={lower} onChange={e => setLower(Number(e.target.value))}
                  className="bg-surface-card border border-border-subtle rounded-[5px] px-2 py-1 text-[11px] text-text-primary outline-none w-full"
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </label>
              <label className="flex flex-col gap-0.5 flex-1">
                <span className="text-[9px] uppercase text-text-quaternary">Upper</span>
                <input
                  type="number" value={higher} onChange={e => setHigher(Number(e.target.value))}
                  className="bg-surface-card border border-border-subtle rounded-[5px] px-2 py-1 text-[11px] text-text-primary outline-none w-full"
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </label>
            </>
          ) : (
            <label className="flex flex-col gap-0.5 flex-1">
              <span className="text-[9px] uppercase text-text-quaternary">Strike</span>
              <input
                type="number" value={strike} onChange={e => setStrike(Number(e.target.value))}
                className="bg-surface-card border border-border-subtle rounded-[5px] px-2 py-1 text-[11px] text-text-primary outline-none w-full"
                style={{ fontFamily: 'var(--font-mono)' }}
              />
            </label>
          )}
          <label className="flex flex-col gap-0.5 w-16">
            <span className="text-[9px] uppercase text-text-quaternary">Cost $</span>
            <input
              type="number" value={cost} onChange={e => setCost(e.target.value)} min={1}
              className="bg-surface-card border border-border-subtle rounded-[5px] px-2 py-1 text-[11px] text-text-primary outline-none w-full"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </label>
          <label className="flex flex-col gap-0.5 w-16">
            <span className="text-[9px] uppercase text-text-quaternary">Hrs max</span>
            <input
              type="number" value={hrsMax} onChange={e => setHrsMax(Number(e.target.value))} min={1} max={48}
              className="bg-surface-card border border-border-subtle rounded-[5px] px-2 py-1 text-[11px] text-text-primary outline-none w-full"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </label>
        </div>

        {/* Summary chips */}
        <div className="flex gap-2 text-[10px]">
          <span className="text-text-quaternary">
            Max loss: <span className="text-red-400 font-mono">-${costNum.toFixed(0)}</span>
          </span>
          <span className="text-text-quaternary">
            Max gain: <span style={{ color: '#20d18c', fontFamily: 'var(--font-mono)' }}>${Math.max(0, zMax).toFixed(2)}</span>
          </span>
          {mode === 'range' && (
            <span className="text-text-quaternary">
              Range: <span className="text-text-secondary font-mono">${fmtPrice(lower)} – ${fmtPrice(higher)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Plot */}
      <div className="flex-1 min-h-0 px-1 pb-2">
        <div id="pnl-surface-plot" className="w-full h-full" />
      </div>
    </div>
  )
}
