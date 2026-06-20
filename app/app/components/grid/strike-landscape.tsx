'use client'
import { useMemo, useRef, useState } from 'react'
// ── Math ─────────────────────────────────────────────────────────────────────

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const r = 1 - p * Math.exp(-x * x)
  return x >= 0 ? r : -r
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))
const normPdf = (z: number, sigma: number) =>
  Math.exp(-0.5 * (z / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI))

// ── Config ────────────────────────────────────────────────────────────────────

const NUM_LAYERS    = 16
const SAMPLES       = 200
const X_MIN         = -4.8
const X_MAX         = 4.0
const PDF_SCALE     = 105   // px height of the front (narrowest) layer peak
const LAYER_SPACING = 16    // px between layer baselines
const LAYER_DX      = 1.4   // px horizontal shift per layer (perspective)

// ── Component ─────────────────────────────────────────────────────────────────

interface Props { price?: number }

export default function StrikeLandscape({ price = 104311 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoverZ, setHoverZ] = useState<number | null>(null)

  // Strike defaults to +1.55σ (≈6% tail probability)
  const strikeZ = 1.55

  // Layers: index 0 = front/bottom (narrow sigma), last = back/top (wide sigma)
  const layers = useMemo(() =>
    Array.from({ length: NUM_LAYERS }, (_, i) => ({
      i,
      sigma: 0.52 + (i / (NUM_LAYERS - 1)) * 1.7,
    })),
  [])

  // ViewBox dimensions
  const W = 560
  const H = 260
  const PL = 44  // left pad (y-axis)
  const PR = 16
  const PT = 16
  const PB = 32  // bottom pad (x-axis)
  const CW = W - PL - PR
  const chartBottom = H - PB

  const xToSvg = (z: number) => PL + ((z - X_MIN) / (X_MAX - X_MIN)) * CW

  // Build SVG path for one layer.
  // Each layer has its own baseline at layerBaseY.
  function buildPath(sigma: number, baseY: number, dxShift: number, tailOnly: boolean): string {
    const xs = Array.from({ length: SAMPLES }, (_, k) =>
      X_MIN + (k / (SAMPLES - 1)) * (X_MAX - X_MIN),
    )

    if (tailOnly) {
      // Area right of strike: start at (strikeX, baseY), trace curve, close
      const strikePx = xToSvg(strikeZ) + dxShift
      const strikePy = baseY - normPdf(strikeZ, sigma) * PDF_SCALE
      const tailPts = xs
        .filter(x => x >= strikeZ)
        .map(x => `${(xToSvg(x) + dxShift).toFixed(1)},${(baseY - normPdf(x, sigma) * PDF_SCALE).toFixed(1)}`)
      const endPx = xToSvg(X_MAX) + dxShift
      return `M${strikePx.toFixed(1)},${baseY.toFixed(1)} L${strikePx.toFixed(1)},${strikePy.toFixed(1)} L${tailPts.join(' L')} L${endPx.toFixed(1)},${baseY.toFixed(1)} Z`
    }

    const pts = xs.map(x =>
      `${(xToSvg(x) + dxShift).toFixed(1)},${(baseY - normPdf(x, sigma) * PDF_SCALE).toFixed(1)}`,
    )
    const x0 = xToSvg(X_MIN) + dxShift
    const x1 = xToSvg(X_MAX) + dxShift
    return `M${x0.toFixed(1)},${baseY.toFixed(1)} L${pts.join(' L')} L${x1.toFixed(1)},${baseY.toFixed(1)} Z`
  }

  // Dashed peak connector
  const peakLine = layers
    .map(({ i, sigma }) => {
      const baseY = chartBottom - i * LAYER_SPACING
      const dxShift = i * LAYER_DX
      const py = baseY - normPdf(0, sigma) * PDF_SCALE
      return `${(xToSvg(0) + dxShift).toFixed(1)},${py.toFixed(1)}`
    })
    .join(' ')

  // Hover and strike probs (using front-layer sigma)
  const frontSigma = layers[0]!.sigma
  const strikeProb = (1 - normCdf(strikeZ / frontSigma)) * 100
  const hoverProb  = hoverZ !== null ? (1 - normCdf(hoverZ / frontSigma)) * 100 : null

  // X labels
  const xTicks = [-4, -3, -2, -1, 0, 1, 2, 3]

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const svgX = ((e.clientX - rect.left) / rect.width) * W
    const z = X_MIN + ((svgX - PL) / CW) * (X_MAX - X_MIN)
    setHoverZ(Math.max(X_MIN, Math.min(X_MAX, z)))
  }

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1 shrink-0">
        <span className="text-[8.5px] tracking-[0.18em] text-[#444] uppercase" style={{ fontFamily: 'var(--font-mono)' }}>
          Price-Target Density · Strike Landscape
        </span>
        <div className="flex items-center gap-3">
          <div className="px-2 py-0.5 bg-[#181818] border border-[#2c2c2c] rounded text-[9px] text-white" style={{ fontFamily: 'var(--font-mono)' }}>
            Strike&nbsp;
            <span className="text-[#e07070] font-bold">+{strikeZ.toFixed(2)}σ</span>
          </div>
          <span className="text-[8.5px] text-[#444] uppercase tracking-widest">
            Tail&nbsp;<span className="text-[#e07070]">+16×</span>
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0 px-1">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-full"
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHoverZ(null)}
        >
          <defs>
            <linearGradient id="sl-tail" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#c84040" stopOpacity="0.75" />
              <stop offset="100%" stopColor="#c84040" stopOpacity="0.18" />
            </linearGradient>
            <linearGradient id="sl-hover" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#807dfe" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#807dfe" stopOpacity="0.1" />
            </linearGradient>
          </defs>

          {/* Draw back → front so front layers cover back ones */}
          {[...layers].reverse().map(({ i, sigma }) => {
            const baseY   = chartBottom - i * LAYER_SPACING
            const dxShift = i * LAYER_DX
            const fullPath = buildPath(sigma, baseY, dxShift, false)
            const tailPath = buildPath(sigma, baseY, dxShift, true)
            return (
              <g key={i}>
                {/* Opaque fill covers layers behind — creates depth */}
                <path d={fullPath} fill="#0d0d0d" />
                {/* Curve outline */}
                <path d={fullPath} fill="none" stroke="#2e2e2e" strokeWidth="0.85" />
                {/* Tail zone */}
                <path d={tailPath} fill="url(#sl-tail)" />
              </g>
            )
          })}

          {/* Dashed peak connector */}
          <polyline
            points={peakLine}
            fill="none"
            stroke="#3a3a3a"
            strokeWidth="0.9"
            strokeDasharray="3.5 3"
          />

          {/* Strike dotted vertical through each layer */}
          {layers.map(({ i, sigma }) => {
            const baseY   = chartBottom - i * LAYER_SPACING
            const dxShift = i * LAYER_DX
            const px  = xToSvg(strikeZ) + dxShift
            const curveY = baseY - normPdf(strikeZ, sigma) * PDF_SCALE
            return (
              <line key={i}
                x1={px} y1={baseY}
                x2={px} y2={curveY}
                stroke="#c84040"
                strokeWidth="0.6"
                strokeDasharray="2 2"
                opacity="0.45"
              />
            )
          })}

          {/* Hover crosshair */}
          {hoverZ !== null && (() => {
            const px = xToSvg(hoverZ)
            const tipX = Math.min(px + 10, W - 118)
            const isRight = hoverZ > strikeZ
            return (
              <g>
                <line x1={px} y1={PT} x2={px + (NUM_LAYERS - 1) * LAYER_DX} y2={chartBottom}
                  stroke="#555" strokeWidth="0.6" strokeDasharray="2.5 2.5" />
                {isRight && layers.map(({ i, sigma }) => {
                  const baseY   = chartBottom - i * LAYER_SPACING
                  const dxShift = i * LAYER_DX
                  const lpx = xToSvg(hoverZ) + dxShift
                  const lpy = baseY - normPdf(hoverZ, sigma) * PDF_SCALE
                  return <circle key={i} cx={lpx} cy={lpy} r="1.5" fill="#807dfe" opacity="0.7" />
                })}
                {/* Tooltip */}
                <rect x={tipX} y={PT + 8} width={108} height={64} rx="4"
                  fill="#161616" stroke="#2a2a2a" strokeWidth="0.8" />
                <text x={tipX + 9} y={PT + 22} fontSize="7.5" fill="#555" fontFamily="var(--font-mono)" textAnchor="start">
                  P(&gt;STRIKE)
                </text>
                <text x={tipX + 9} y={PT + 36} fontSize="11" fontWeight="bold" fill="#e07070" fontFamily="var(--font-mono)">
                  {(hoverProb ?? 0).toFixed(2)}%
                </text>
                <text x={tipX + 9} y={PT + 50} fontSize="7.5" fill="#555" fontFamily="var(--font-mono)">
                  IMPLIED IV
                </text>
                <text x={tipX + 9} y={PT + 63} fontSize="9" fill="#888" fontFamily="var(--font-mono)">
                  {(Math.abs(hoverZ) * 8 + 12).toFixed(1)}%
                </text>
              </g>
            )
          })()}

          {/* X-axis ticks */}
          {xTicks.map(z => (
            <g key={z}>
              <line x1={xToSvg(z)} y1={chartBottom + 2} x2={xToSvg(z)} y2={chartBottom + 5}
                stroke="#2e2e2e" strokeWidth="0.8" />
              <text x={xToSvg(z)} y={chartBottom + 16}
                textAnchor="middle" fontSize="8" fill="#383838" fontFamily="var(--font-mono)">
                {z === 0 ? '0' : `${z > 0 ? '+' : ''}${z}σ`}
              </text>
            </g>
          ))}

          {/* Zero-line (current price) */}
          <line x1={xToSvg(0)} y1={chartBottom} x2={xToSvg(0) + (NUM_LAYERS - 1) * LAYER_DX} y2={chartBottom - (NUM_LAYERS - 1) * LAYER_SPACING}
            stroke="#2e2e2e" strokeWidth="0.6" />
        </svg>
      </div>

      {/* Footer stats */}
      <div className="flex items-center gap-5 px-4 pb-2.5 shrink-0 border-t border-[#181818] pt-2">
        <div>
          <div className="text-[7.5px] tracking-wider text-[#383838] uppercase" style={{ fontFamily: 'var(--font-mono)' }}>P(tail)</div>
          <div className="text-[11px] font-bold text-[#e07070]" style={{ fontFamily: 'var(--font-mono)' }}>
            {strikeProb.toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-[7.5px] tracking-wider text-[#383838] uppercase" style={{ fontFamily: 'var(--font-mono)' }}>Strike</div>
          <div className="text-[11px] font-bold text-[#ccc]" style={{ fontFamily: 'var(--font-mono)' }}>
            +{strikeZ.toFixed(2)}σ
          </div>
        </div>
        <div>
          <div className="text-[7.5px] tracking-wider text-[#383838] uppercase" style={{ fontFamily: 'var(--font-mono)' }}>Layers</div>
          <div className="text-[11px] font-bold text-[#ccc]" style={{ fontFamily: 'var(--font-mono)' }}>
            {NUM_LAYERS} epochs
          </div>
        </div>
        <div className="ml-auto">
          <div className="text-[7.5px] tracking-wider text-[#383838] uppercase" style={{ fontFamily: 'var(--font-mono)' }}>Live price</div>
          <div className="text-[11px] font-bold text-[#ccc]" style={{ fontFamily: 'var(--font-mono)' }}>
            ${price.toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  )
}
