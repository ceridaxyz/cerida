'use client'
import { useEffect, useRef, useState } from 'react'

// ── Math ─────────────────────────────────────────────────────────────────────

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const r = 1 - p * Math.exp(-x * x)
  return x >= 0 ? r : -r
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))
const normPdf = (z: number, s: number) =>
  Math.exp(-0.5 * (z / s) ** 2) / (s * Math.sqrt(2 * Math.PI))

// ── Config ────────────────────────────────────────────────────────────────────

const NUM_LAYERS    = 22
const SAMPLES       = 220
const X_MIN         = -5.5
const X_MAX         = 3.8
const PDF_SCALE     = 160
const LAYER_SPACING = 13
const LAYER_DX      = 1.1

const sigmaFor = (i: number, ivBoost: number) =>
  (0.28 + (i / (NUM_LAYERS - 1)) * 2.9) * (1 + ivBoost * 0.6)

// ── Component ─────────────────────────────────────────────────────────────────

interface Props { price?: number }

export default function StrikeLandscape({ price: initPrice = 104311 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const rafRef = useRef<number>(0)
  const t0     = useRef(Date.now())

  const [price,   setPrice]   = useState(initPrice)
  const [iv,      setIv]      = useState(0.162)
  const [tick,    setTick]    = useState(0)
  const [strikeZ, setStrikeZ] = useState(1.62)
  const [hoverZ,  setHoverZ]  = useState<number | null>(null)
  const [entered, setEntered] = useState(false)
  const dragging = useRef(false)

  useEffect(() => { const id = setTimeout(() => setEntered(true), 50); return () => clearTimeout(id) }, [])

  useEffect(() => {
    const id = setInterval(() => {
      setPrice(p => p + (Math.random() - 0.49) * 60)
      setIv(v => Math.max(0.07, Math.min(0.42, v + (Math.random() - 0.5) * 0.005)))
    }, 700)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const loop = () => { setTick(Date.now() - t0.current); rafRef.current = requestAnimationFrame(loop) }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  useEffect(() => {
    const up = () => { dragging.current = false }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  const W  = 720
  const H  = 230
  const PL = 8
  const PR = 8
  const PT = 8
  const PB = 26
  const CW = W - PL - PR
  const chartBottom = H - PB

  const xToSvg = (z: number) => PL + ((z - X_MIN) / (X_MAX - X_MIN)) * CW

  function svgZFromClient(clientX: number) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return strikeZ
    const svgX = ((clientX - rect.left) / rect.width) * W
    return Math.max(X_MIN, Math.min(X_MAX, X_MIN + ((svgX - PL) / CW) * (X_MAX - X_MIN)))
  }

  function buildPath(sigma: number, baseY: number, dx: number, fromZ?: number): string {
    const x0  = fromZ ?? X_MIN
    const xs  = Array.from({ length: SAMPLES }, (_, k) => x0 + (k / (SAMPLES - 1)) * (X_MAX - x0))
    const pts = xs.map(x =>
      `${(xToSvg(x) + dx).toFixed(1)},${(baseY - normPdf(x, sigma) * PDF_SCALE).toFixed(1)}`,
    )
    if (fromZ !== undefined) {
      const sx = (xToSvg(fromZ) + dx).toFixed(1)
      const sy = (baseY - normPdf(fromZ, sigma) * PDF_SCALE).toFixed(1)
      const ex = (xToSvg(X_MAX) + dx).toFixed(1)
      return `M${sx},${baseY.toFixed(1)} L${sx},${sy} L${pts.join(' L')} L${ex},${baseY.toFixed(1)} Z`
    }
    return `M${(xToSvg(X_MIN) + dx).toFixed(1)},${baseY.toFixed(1)} L${pts.join(' L')} L${(xToSvg(X_MAX) + dx).toFixed(1)},${baseY.toFixed(1)} Z`
  }

  const ivBoost      = iv - 0.162
  const strikeProb   = (1 - normCdf(strikeZ)) * 100
  const impliedPayout = Math.round(1 / (strikeProb / 100))
  const hoverProb    = hoverZ !== null ? (1 - normCdf(hoverZ)) * 100 : null

  const peakPts = Array.from({ length: NUM_LAYERS }, (_, i) => {
    const breathe = Math.sin(tick / 2000 + i * 0.4) * 0.018
    const sigma   = sigmaFor(i, ivBoost) * (1 + breathe)
    const baseY   = chartBottom - i * LAYER_SPACING
    const dx      = i * LAYER_DX
    return `${(xToSvg(0) + dx).toFixed(1)},${(baseY - normPdf(0, sigma) * PDF_SCALE).toFixed(1)}`
  }).join(' ')

  // Stroke per layer: front = brand-violet hint, back = subtle border
  const strokeFor = (i: number) => {
    const t = i / (NUM_LAYERS - 1)
    // front layers: violet-tinted; back layers: dim border color
    return i < 3
      ? `rgba(128,125,254,${0.45 - i * 0.1})`
      : `rgba(255,255,255,${0.06 + (1 - t) * 0.08})`
  }

  const xTicks = [-4, -3, -2, -1, 0, 1, 2, 3]

  return (
    <div
      className="flex flex-col h-full overflow-hidden select-none"
      style={{ background: 'var(--color-surface-primary)', fontFamily: 'var(--font-mono)' }}
    >
      <style>{`
        @keyframes layerSlideIn {
          from { opacity: 0; transform: translateY(5px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes strikePulse {
          0%,100% { opacity: 0.45; } 50% { opacity: 0.9; }
        }
      `}</style>

      {/* Header */}
      <div
        className="flex items-center justify-between px-3 shrink-0"
        style={{ borderBottom: '1px solid var(--color-border-default)', paddingTop: 7, paddingBottom: 6 }}
      >
        <span style={{ fontSize: 8.5, letterSpacing: '0.18em', color: 'var(--color-text-quaternary)', textTransform: 'uppercase' }}>
          [Price-Target Density · Crypto Targets
        </span>
        <div className="flex items-center gap-4">
          <div style={{
            background: 'var(--color-surface-card)',
            border: '1px solid var(--color-border-default)',
            color: 'var(--color-text-primary)',
            fontSize: 9, fontWeight: 700,
            padding: '2px 8px', letterSpacing: '0.1em',
          }}>
            STRIKE {price.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </div>
          <span style={{ fontSize: 8.5, letterSpacing: '0.12em', color: 'var(--color-text-quaternary)', textTransform: 'uppercase' }}>
            Tail Zone · Payout <span style={{ color: 'var(--color-bearish-red)' }}>+{impliedPayout}×</span>]
          </span>
        </div>
      </div>

      {/* SVG */}
      <div className="flex-1 min-h-0">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-full"
          style={{ cursor: 'crosshair', display: 'block' }}
          onMouseMove={e => {
            const z = svgZFromClient(e.clientX)
            if (dragging.current) setStrikeZ(Math.max(-1, Math.min(X_MAX - 0.1, z)))
            setHoverZ(z)
          }}
          onMouseLeave={() => setHoverZ(null)}
          onPointerDown={e => {
            dragging.current = true
            setStrikeZ(Math.max(-1, Math.min(X_MAX - 0.1, svgZFromClient(e.clientX))))
          }}
        >
          <defs>
            <clipPath id="sl-clip">
              <rect x={PL} y={PT} width={CW} height={H - PT - PB + 4} />
            </clipPath>
            <linearGradient id="sl-tail" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#f23546" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#f23546" stopOpacity="0.06" />
            </linearGradient>
            <linearGradient id="sl-hover-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#807dfe" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#807dfe" stopOpacity="0.03" />
            </linearGradient>
          </defs>

          {/* Layers back → front */}
          <g clipPath="url(#sl-clip)">
            {Array.from({ length: NUM_LAYERS }, (_, ri) => {
              const i       = NUM_LAYERS - 1 - ri
              const breathe = Math.sin(tick / 2000 + i * 0.4) * 0.018
              const sigma   = sigmaFor(i, ivBoost) * (1 + breathe)
              const baseY   = chartBottom - i * LAYER_SPACING
              const dx      = i * LAYER_DX
              const full    = buildPath(sigma, baseY, dx)
              const tail    = buildPath(sigma, baseY, dx, strikeZ)
              return (
                <g
                  key={i}
                  style={entered ? undefined : {
                    animation: `layerSlideIn 0.4s cubic-bezier(0.22,1,0.36,1) ${(NUM_LAYERS - i) * 22}ms both`,
                  }}
                >
                  <path d={full} fill="var(--color-surface-primary)" />
                  <path d={full} fill="none" stroke={strokeFor(i)} strokeWidth={i < 3 ? '1' : '0.75'} />
                  <path d={tail} fill="url(#sl-tail)" />
                </g>
              )
            })}
          </g>

          {/* Peak connector */}
          <polyline
            points={peakPts}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="0.9"
            strokeDasharray="3.5 3"
            clipPath="url(#sl-clip)"
          />

          {/* Strike dashes per layer */}
          {Array.from({ length: NUM_LAYERS }, (_, i) => {
            const breathe = Math.sin(tick / 2000 + i * 0.4) * 0.018
            const sigma   = sigmaFor(i, ivBoost) * (1 + breathe)
            const baseY   = chartBottom - i * LAYER_SPACING
            const dx      = i * LAYER_DX
            const px      = xToSvg(strikeZ) + dx
            const curveY  = baseY - normPdf(strikeZ, sigma) * PDF_SCALE
            return (
              <line key={i}
                x1={px} y1={baseY} x2={px} y2={Math.max(curveY, PT)}
                stroke="var(--color-bearish-red)"
                strokeWidth="0.65"
                strokeDasharray="2.5 2"
                style={{ animation: 'strikePulse 2.2s ease-in-out infinite' }}
              />
            )
          })}

          {/* Live price dot on front layer peak */}
          {(() => {
            const i      = 2
            const sigma  = sigmaFor(i, ivBoost)
            const baseY  = chartBottom - i * LAYER_SPACING
            const dx     = i * LAYER_DX
            return (
              <circle
                cx={xToSvg(0) + dx}
                cy={baseY - normPdf(0, sigma) * PDF_SCALE}
                r="3"
                fill="var(--color-bearish-red)"
              />
            )
          })()}

          {/* Hover hairline */}
          {hoverZ !== null && (
            <line
              x1={xToSvg(hoverZ)} y1={PT}
              x2={xToSvg(hoverZ) + (NUM_LAYERS - 1) * LAYER_DX} y2={chartBottom}
              stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" strokeDasharray="2 2"
            />
          )}

          {/* Tooltip */}
          {hoverZ !== null && (() => {
            const tipX = Math.min(xToSvg(hoverZ) + 12, W - 130)
            const tipY = PT + 28
            return (
              <g>
                <rect x={tipX} y={tipY} width={122} height={66} rx="3"
                  fill="#0d0f1a" stroke="#1a1b2e" strokeWidth="0.8" />
                <text x={tipX + 9} y={tipY + 16} fontSize="8" fill="#6b7280">
                  P(&gt;STRIKE) {(hoverProb ?? 0).toFixed(2)}%
                </text>
                <text x={tipX + 9} y={tipY + 35} fontSize="13" fontWeight="700" fill="#f23546">
                  IMPLIED +{Math.round(1 / Math.max(0.001, (hoverProb ?? 1) / 100))}.0
                </text>
                <text x={tipX + 9} y={tipY + 52} fontSize="8" fill="#6b7280">
                  IV {(iv * 100).toFixed(1)}%
                </text>
                <text x={tipX + 9} y={tipY + 63} fontSize="7.5" fill="#3a3c50">
                  SESSION z={hoverZ.toFixed(3)}
                </text>
              </g>
            )
          })()}

          {/* X-axis */}
          {xTicks.map(z => (
            <g key={z}>
              <line x1={xToSvg(z)} y1={chartBottom + 1} x2={xToSvg(z)} y2={chartBottom + 4}
                stroke="#1a1b2e" strokeWidth="0.8" />
              <text x={xToSvg(z)} y={chartBottom + 15}
                textAnchor="middle" fontSize="8" fill="#3a3c50">
                {z === 0 ? '0' : `${z > 0 ? '+' : ''}${z}σ`}
              </text>
            </g>
          ))}

          <line x1={PL} y1={chartBottom} x2={W - PR} y2={chartBottom}
            stroke="#1a1b2e" strokeWidth="0.8" />
        </svg>
      </div>
    </div>
  )
}
