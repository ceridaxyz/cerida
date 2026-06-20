'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

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
const SAMPLES       = 180
const X_MIN         = -4.8
const X_MAX         = 4.0
const PDF_SCALE     = 108
const LAYER_SPACING = 15
const LAYER_DX      = 1.3

// ── Component ─────────────────────────────────────────────────────────────────

interface Props { price?: number }

export default function StrikeLandscape({ price: initPrice = 104311 }: Props) {
  const svgRef   = useRef<SVGSVGElement>(null)
  const rafRef   = useRef<number>(0)
  const t0       = useRef(Date.now())

  // Live simulated state
  const [price, setPrice] = useState(initPrice)
  const [iv,    setIv]    = useState(0.162)
  const [tick,  setTick]  = useState(0)     // drives breathing animation

  // Draggable strike (in sigma units)
  const [strikeZ,   setStrikeZ]   = useState(1.55)
  const [dragging,  setDragging]  = useState(false)
  const draggingRef = useRef(false)

  // Entrance: layers fade+slide in one by one
  const [entered, setEntered] = useState(false)
  useEffect(() => { const id = setTimeout(() => setEntered(true), 60); return () => clearTimeout(id) }, [])

  // Random walk: price + IV
  useEffect(() => {
    const id = setInterval(() => {
      setPrice(p  => p  + (Math.random() - 0.49) * 55)
      setIv   (v  => Math.max(0.08, Math.min(0.38, v + (Math.random() - 0.5) * 0.004)))
    }, 650)
    return () => clearInterval(id)
  }, [])

  // rAF breathing loop
  useEffect(() => {
    const loop = () => {
      setTick(Date.now() - t0.current)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // ViewBox
  const W  = 560
  const H  = 258
  const PL = 12
  const PR = 12
  const PT = 18
  const PB = 30
  const CW = W - PL - PR
  const chartBottom = H - PB

  const xToSvg = (z: number) => PL + ((z - X_MIN) / (X_MAX - X_MIN)) * CW

  // Layers: index 0 = front/bottom
  const layers = useMemo(() =>
    Array.from({ length: NUM_LAYERS }, (_, i) => ({
      i,
      baseSigma: 0.5 + (i / (NUM_LAYERS - 1)) * 1.75,
    })),
  [])

  // Build SVG path, accepting a sigma with breathing applied externally
  function buildPath(sigma: number, baseY: number, dxShift: number, tailOnly: boolean): string {
    const xs = Array.from({ length: SAMPLES }, (_, k) =>
      X_MIN + (k / (SAMPLES - 1)) * (X_MAX - X_MIN),
    )

    if (tailOnly) {
      const sx  = xToSvg(strikeZ) + dxShift
      const sy  = baseY - normPdf(strikeZ, sigma) * PDF_SCALE
      const pts = xs
        .filter(x => x >= strikeZ)
        .map(x => `${(xToSvg(x) + dxShift).toFixed(1)},${(baseY - normPdf(x, sigma) * PDF_SCALE).toFixed(1)}`)
      return `M${sx.toFixed(1)},${baseY.toFixed(1)} L${sx.toFixed(1)},${sy.toFixed(1)} L${pts.join(' L')} L${(xToSvg(X_MAX) + dxShift).toFixed(1)},${baseY.toFixed(1)} Z`
    }

    const pts = xs.map(x =>
      `${(xToSvg(x) + dxShift).toFixed(1)},${(baseY - normPdf(x, sigma) * PDF_SCALE).toFixed(1)}`,
    )
    return `M${(xToSvg(X_MIN) + dxShift).toFixed(1)},${baseY.toFixed(1)} L${pts.join(' L')} L${(xToSvg(X_MAX) + dxShift).toFixed(1)},${baseY.toFixed(1)} Z`
  }

  // Hover state
  const [hoverZ, setHoverZ] = useState<number | null>(null)
  const strikeProb = (1 - normCdf(strikeZ)) * 100
  const hoverProb  = hoverZ !== null ? (1 - normCdf(hoverZ)) * 100 : null

  // Drag strike
  function svgZFromClientX(clientX: number) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return strikeZ
    const svgX = ((clientX - rect.left) / rect.width) * W
    return Math.max(X_MIN + 0.2, Math.min(X_MAX - 0.2, X_MIN + ((svgX - PL) / CW) * (X_MAX - X_MIN)))
  }

  function onSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const z = svgZFromClientX(e.clientX)
    if (draggingRef.current) setStrikeZ(z)
    setHoverZ(Math.max(X_MIN, Math.min(X_MAX, z)))
  }

  useEffect(() => {
    const onUp = () => { draggingRef.current = false; setDragging(false) }
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [])

  const xTicks = [-4, -3, -2, -1, 0, 1, 2, 3]

  // Dashed peak connector (peak positions per layer, using live sigma)
  const peakPoints = layers.map(({ i, baseSigma }) => {
    const breathe = Math.sin(tick / 1800 + i * 0.45) * 0.025
    const sigma   = baseSigma * (1 + breathe) * (1 + iv * 0.8)
    const baseY   = chartBottom - i * LAYER_SPACING
    const dxShift = i * LAYER_DX
    const py      = baseY - normPdf(0, sigma) * PDF_SCALE
    return `${(xToSvg(0) + dxShift).toFixed(1)},${py.toFixed(1)}`
  }).join(' ')

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: '#0b0b0b' }}>
      <style>{`
        @keyframes layerIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes strikeGlow {
          0%,100% { opacity: 0.38; } 50% { opacity: 0.7; }
        }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1 shrink-0">
        <span className="text-[8px] tracking-[0.2em] uppercase" style={{ color: '#333', fontFamily: 'var(--font-mono)' }}>
          Price-Target Density
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[8px] uppercase tracking-widest" style={{ color: '#333', fontFamily: 'var(--font-mono)' }}>
            IV&nbsp;<span style={{ color: '#e07070' }}>{(iv * 100).toFixed(1)}%</span>
          </span>
          <div className="px-1.5 py-0.5 rounded text-[8px]" style={{ background: '#181818', border: '1px solid #222', fontFamily: 'var(--font-mono)', color: '#888' }}>
            Strike&nbsp;<span style={{ color: '#e07070', fontWeight: 700 }}>{strikeZ > 0 ? '+' : ''}{strikeZ.toFixed(2)}σ</span>
          </div>
          <span className="text-[8px]" style={{ color: '#333', fontFamily: 'var(--font-mono)' }}>
            Tail&nbsp;<span style={{ color: '#e07070' }}>+{Math.round(1 / (strikeProb / 100))}×</span>
          </span>
        </div>
      </div>

      {/* SVG */}
      <div className="flex-1 min-h-0 px-1">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-full"
          style={{ cursor: dragging ? 'ew-resize' : 'crosshair', overflow: 'visible' }}
          onMouseMove={onSvgMouseMove}
          onMouseLeave={() => setHoverZ(null)}
          onPointerDown={(e) => {
            draggingRef.current = true
            setDragging(true)
            setStrikeZ(svgZFromClientX(e.clientX))
          }}
        >
          <defs>
            <linearGradient id="sl-tail" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#c84040" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#c84040" stopOpacity="0.12" />
            </linearGradient>
            <linearGradient id="sl-hover" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#807dfe" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#807dfe" stopOpacity="0.05" />
            </linearGradient>
          </defs>

          {/* Layers back → front */}
          {[...layers].reverse().map(({ i, baseSigma }) => {
            const breathe   = Math.sin(tick / 1800 + i * 0.45) * 0.025
            const sigma     = baseSigma * (1 + breathe) * (1 + iv * 0.8)
            const baseY     = chartBottom - i * LAYER_SPACING
            const dxShift   = i * LAYER_DX
            const fullPath  = buildPath(sigma, baseY, dxShift, false)
            const tailPath  = buildPath(sigma, baseY, dxShift, true)
            const delay     = entered ? 0 : `${(NUM_LAYERS - i) * 28}ms`
            return (
              <g
                key={i}
                style={entered ? undefined : {
                  animation: `layerIn 0.35s cubic-bezier(0.22,1,0.36,1) ${delay} both`,
                }}
              >
                <path d={fullPath} fill="#0b0b0b" />
                <path d={fullPath} fill="none" stroke="#252525" strokeWidth="0.9" />
                <path d={tailPath} fill="url(#sl-tail)" />
              </g>
            )
          })}

          {/* Dashed peak connector */}
          <polyline
            points={peakPoints}
            fill="none"
            stroke="#2e2e2e"
            strokeWidth="0.85"
            strokeDasharray="3 3"
          />

          {/* Strike line through each layer */}
          {layers.map(({ i, baseSigma }) => {
            const breathe  = Math.sin(tick / 1800 + i * 0.45) * 0.025
            const sigma    = baseSigma * (1 + breathe) * (1 + iv * 0.8)
            const baseY    = chartBottom - i * LAYER_SPACING
            const dxShift  = i * LAYER_DX
            const px       = xToSvg(strikeZ) + dxShift
            const curveY   = baseY - normPdf(strikeZ, sigma) * PDF_SCALE
            return (
              <line key={i}
                x1={px} y1={baseY} x2={px} y2={curveY}
                stroke="#c84040" strokeWidth="0.7"
                strokeDasharray="2 2"
                style={{ animation: 'strikeGlow 2s ease-in-out infinite' }}
              />
            )
          })}

          {/* Hover fill zone */}
          {hoverZ !== null && hoverZ > strikeZ && layers.map(({ i, baseSigma }) => {
            const breathe = Math.sin(tick / 1800 + i * 0.45) * 0.025
            const sigma   = baseSigma * (1 + breathe) * (1 + iv * 0.8)
            const baseY   = chartBottom - i * LAYER_SPACING
            const dxShift = i * LAYER_DX
            const hpx     = xToSvg(hoverZ) + dxShift
            const hpy     = baseY - normPdf(hoverZ, sigma) * PDF_SCALE
            const spx     = xToSvg(strikeZ) + dxShift
            // mini fill between strike and hover
            const pts = Array.from({ length: 40 }, (_, k) => {
              const x  = strikeZ + (k / 39) * (hoverZ - strikeZ)
              const px = xToSvg(x) + dxShift
              const py = baseY - normPdf(x, sigma) * PDF_SCALE
              return `${px.toFixed(1)},${py.toFixed(1)}`
            })
            return (
              <path key={i}
                d={`M${spx.toFixed(1)},${baseY.toFixed(1)} L${pts.join(' L')} L${hpx.toFixed(1)},${baseY.toFixed(1)} Z`}
                fill="url(#sl-hover)"
                opacity="0.5"
              />
            )
          })}

          {/* Hover vertical */}
          {hoverZ !== null && (
            <line
              x1={xToSvg(hoverZ)} y1={PT}
              x2={xToSvg(hoverZ) + (NUM_LAYERS - 1) * LAYER_DX} y2={chartBottom}
              stroke="#555" strokeWidth="0.5" strokeDasharray="2 2"
            />
          )}

          {/* X-axis ticks */}
          {xTicks.map(z => (
            <g key={z}>
              <line x1={xToSvg(z)} y1={chartBottom + 2} x2={xToSvg(z)} y2={chartBottom + 5}
                stroke="#222" strokeWidth="0.8" />
              <text x={xToSvg(z)} y={chartBottom + 16}
                textAnchor="middle" fontSize="7.5" fill="#2e2e2e" fontFamily="var(--font-mono)">
                {z === 0 ? '0' : `${z > 0 ? '+' : ''}${z}σ`}
              </text>
            </g>
          ))}

          {/* Hover tooltip */}
          {hoverZ !== null && (() => {
            const tipX = Math.min(xToSvg(hoverZ) + 10, W - 112)
            return (
              <g>
                <rect x={tipX} y={PT + 6} width={106} height={58} rx="4"
                  fill="#141414" stroke="#222" strokeWidth="0.8" />
                <text x={tipX + 8} y={PT + 20} fontSize="7" fill="#444" fontFamily="var(--font-mono)">P(&gt;STRIKE)</text>
                <text x={tipX + 8} y={PT + 34} fontSize="12" fontWeight="bold" fill="#e07070" fontFamily="var(--font-mono)">
                  {(hoverProb ?? 0).toFixed(2)}%
                </text>
                <text x={tipX + 8} y={PT + 46} fontSize="7" fill="#444" fontFamily="var(--font-mono)">IMPLIED IV</text>
                <text x={tipX + 8} y={PT + 58} fontSize="9" fill="#666" fontFamily="var(--font-mono)">
                  {(iv * 100).toFixed(1)}%
                </text>
              </g>
            )
          })()}
        </svg>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-5 px-3 pb-2.5 pt-1.5 shrink-0" style={{ borderTop: '1px solid #141414' }}>
        <div>
          <div className="text-[7px] uppercase tracking-wider" style={{ color: '#2e2e2e', fontFamily: 'var(--font-mono)' }}>P(tail)</div>
          <div className="text-[11px] font-bold" style={{ color: '#e07070', fontFamily: 'var(--font-mono)' }}>
            {strikeProb.toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-[7px] uppercase tracking-wider" style={{ color: '#2e2e2e', fontFamily: 'var(--font-mono)' }}>Strike</div>
          <div className="text-[11px] font-bold" style={{ color: '#aaa', fontFamily: 'var(--font-mono)' }}>
            {strikeZ > 0 ? '+' : ''}{strikeZ.toFixed(2)}σ
          </div>
        </div>
        <div>
          <div className="text-[7px] uppercase tracking-wider" style={{ color: '#2e2e2e', fontFamily: 'var(--font-mono)' }}>IV</div>
          <div className="text-[11px] font-bold" style={{ color: '#aaa', fontFamily: 'var(--font-mono)' }}>
            {(iv * 100).toFixed(1)}%
          </div>
        </div>
        <div className="ml-auto">
          <div className="text-[7px] uppercase tracking-wider" style={{ color: '#2e2e2e', fontFamily: 'var(--font-mono)' }}>Price</div>
          <div className="text-[11px] font-bold tabular-nums" style={{ color: '#aaa', fontFamily: 'var(--font-mono)' }}>
            ${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </div>
        </div>
      </div>
    </div>
  )
}
