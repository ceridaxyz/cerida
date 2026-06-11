import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence, useMotionValue, animate } from 'framer-motion'

const PRICE_SCALE = 1_000_000_000
const DUSDC_SCALE = 1_000_000

function toChainPrice(pct: number) { return Math.round((pct / 100) * PRICE_SCALE) }
function toChainDusdc(usd: number)  { return Math.round(usd * DUSDC_SCALE) }

const EXPIRY_OPTIONS = [
  { label: '1h',  ms: 60 * 60 * 1_000 },
  { label: '6h',  ms: 6  * 60 * 60 * 1_000 },
  { label: '1d',  ms: 24 * 60 * 60 * 1_000 },
  { label: '7d',  ms: 7  * 24 * 60 * 60 * 1_000 },
]

interface Props {
  currentPrice?: number
  oracleId?: string
  onSubmit?: (params: {
    oracleId: string; expiry: number
    lower: number; higher: number; qty: number; maxCost: number
  }) => void
}

export default function RangeTrading({ currentPrice = 0.235, oracleId = '', onSubmit }: Props) {
  const [lower,      setLower]     = useState(20)
  const [higher,     setHigher]    = useState(40)
  const [expiryIdx,  setExpiryIdx] = useState(2)
  const [qty,        setQty]       = useState('1')
  const [maxCostRaw, setMaxCost]   = useState('')

  const qtyNum  = parseInt(qty)          || 0
  const maxCost = parseFloat(maxCostRaw) || 0
  const width   = Math.max(0, higher - lower)

  const prob    = width / 100
  const estCost = Math.max(0.01, prob) * qtyNum
  const profit  = qtyNum - estCost
  const canSubmit = qtyNum > 0 && maxCost > 0 && lower >= 0 && higher <= 100 && lower < higher

  function handleSubmit() {
    if (!canSubmit || !onSubmit) return
    onSubmit({
      oracleId,
      expiry:  Date.now() + EXPIRY_OPTIONS[expiryIdx]!.ms,
      lower:   toChainPrice(lower),
      higher:  toChainPrice(higher),
      qty:     qtyNum,
      maxCost: toChainDusdc(maxCost),
    })
  }

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px]">
      <div className="flex flex-col gap-2 px-3 py-2.5 flex-1 overflow-hidden">

        {/* Range slider */}
        <Row label={`Range · ${lower}¢ – ${higher}¢ · ${width}% wide`}>
          <RangeSlider
            lower={lower} higher={higher}
            currentPrice={currentPrice * 100}
            onLowerChange={setLower}
            onHigherChange={setHigher}
          />
          <div className="flex gap-2 mt-1">
            <BoundInput label="Lower" value={lower} onChange={setLower} />
            <BoundInput label="Upper" value={higher} onChange={setHigher} />
          </div>
        </Row>

        {/* Expiry */}
        <Row label="Expiry">
          <div className="flex gap-1">
            {EXPIRY_OPTIONS.map((opt, i) => (
              <button
                key={opt.label}
                onClick={() => setExpiryIdx(i)}
                className="flex-1 py-1 rounded-[5px] text-[11px] font-medium transition-colors"
                style={{
                  background: expiryIdx === i ? 'var(--color-surface-hover)' : 'var(--color-surface-card)',
                  color:      expiryIdx === i ? 'var(--color-text-primary)'  : 'var(--color-text-tertiary)',
                  border:     `1px solid ${expiryIdx === i ? 'var(--color-border-default)' : 'var(--color-border-subtle)'}`,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Row>

        {/* Qty + Max cost */}
        <Row label="Qty">
          <CompactInput value={qty} onChange={setQty} suffix="x" placeholder="1" />
        </Row>
        <Row label="Max cost">
          <CompactInput value={maxCostRaw} onChange={setMaxCost} prefix="$" placeholder="0.00" />
        </Row>

        {/* Summary */}
        <AnimatePresence>
          {qtyNum > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-[7px] border border-border-subtle bg-surface-card px-2.5 py-2 flex flex-col gap-1"
            >
              <SummaryRow label="Est. cost"  value={`~$${estCost.toFixed(3)}`} />
              <SummaryRow label="Max payout" value={`$${qtyNum.toFixed(2)}`} accent />
              <SummaryRow label="Profit"     value={`~$${profit.toFixed(3)}`} accent />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Submit */}
        <button
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="mt-auto w-full py-2 text-[12px] font-semibold rounded-[7px] transition-opacity shrink-0"
          style={{
            backgroundColor: canSubmit ? 'var(--color-brand-violet)' : 'var(--color-surface-hover)',
            color:  canSubmit ? '#fff' : 'var(--color-text-quaternary)',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          Enter Range · {lower}¢ – {higher}¢
        </button>
      </div>
    </div>
  )
}

// ── Range Slider ───────────────────────────────────────────────────────────────

function RangeSlider({
  lower, higher, currentPrice,
  onLowerChange, onHigherChange,
}: {
  lower: number; higher: number; currentPrice: number
  onLowerChange: (v: number) => void
  onHigherChange: (v: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const lowerX   = useMotionValue(0)
  const higherX  = useMotionValue(0)

  const getW   = () => trackRef.current?.clientWidth ?? 1
  const pctToX = (pct: number) => (pct / 100) * getW()
  const xToPct = (x: number)   => Math.round(Math.max(0, Math.min(100, (x / getW()) * 100)))

  const makeDrag = useCallback((which: 'lower' | 'higher') => (e: React.PointerEvent) => {
    e.stopPropagation()
    const mv     = which === 'lower' ? lowerX : higherX
    const origin = { clientX: e.clientX, x: mv.get() }

    const onMove = (ev: PointerEvent) => {
      const nx  = Math.max(0, Math.min(getW(), origin.x + ev.clientX - origin.clientX))
      const pct = xToPct(nx)
      if (which === 'lower'  && pct < higher) { mv.set(nx); onLowerChange(pct) }
      if (which === 'higher' && pct > lower)  { mv.set(nx); onHigherChange(pct) }
    }
    const onUp = (ev: PointerEvent) => {
      const nx  = Math.max(0, Math.min(getW(), origin.x + ev.clientX - origin.clientX))
      const pct = xToPct(nx)
      if (which === 'lower')  { animate(lowerX,  pctToX(Math.min(pct, higher - 1)), { type: 'spring', stiffness: 600, damping: 40 }); onLowerChange(Math.min(pct, higher - 1)) }
      if (which === 'higher') { animate(higherX, pctToX(Math.max(pct, lower + 1)),  { type: 'spring', stiffness: 600, damping: 40 }); onHigherChange(Math.max(pct, lower + 1)) }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
  }, [lower, higher, lowerX, higherX, onLowerChange, onHigherChange]) // eslint-disable-line react-hooks/exhaustive-deps

  const lowerPx  = (lower  / 100) * (trackRef.current?.clientWidth ?? 0)
  const higherPx = (higher / 100) * (trackRef.current?.clientWidth ?? 0)

  return (
    <div ref={trackRef} className="relative select-none shrink-0" style={{ height: 28 }}>
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-surface-card border border-border-subtle" />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full"
        style={{ left: `${lower}%`, width: `${Math.max(0, higher - lower)}%`, backgroundColor: 'var(--color-brand-violet)', opacity: 0.6 }}
      />
      <div
        className="absolute top-0 bottom-0 w-px"
        style={{ left: `${currentPrice}%`, backgroundColor: 'rgba(255,255,255,0.2)' }}
      />
      <Handle x={lowerPx}  onPointerDown={makeDrag('lower')} />
      <Handle x={higherPx} onPointerDown={makeDrag('higher')} />
    </div>
  )
}

function Handle({ x, onPointerDown }: { x: number; onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group"
      style={{ left: x, cursor: 'grab', zIndex: 10 }}
    >
      <div
        className="w-3.5 h-3.5 rounded-full border-2 transition-transform group-hover:scale-125"
        style={{ backgroundColor: 'var(--color-surface-primary)', borderColor: 'var(--color-brand-violet)', boxShadow: '0 0 0 3px rgba(94,106,210,0.2)' }}
      />
    </div>
  )
}

// ── helpers ────────────────────────────────────────────────────────────────────

function BoundInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 bg-surface-card rounded-[6px] px-2 py-1.5 border border-border-subtle flex-1">
      <span className="text-[10px] text-text-quaternary uppercase tracking-wider shrink-0">{label}</span>
      <input
        type="number" min={0} max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 bg-transparent text-[12px] font-medium text-text-primary outline-none w-0"
        style={{ fontFamily: 'var(--font-mono)' }}
      />
      <span className="text-[10px] text-text-quaternary">¢</span>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 shrink-0">
      <span className="text-[10px] font-medium text-text-quaternary uppercase tracking-widest">{label}</span>
      {children}
    </div>
  )
}

function CompactInput({ value, onChange, prefix, suffix, placeholder }: {
  value: string; onChange: (v: string) => void
  prefix?: string; suffix?: string; placeholder?: string
}) {
  return (
    <div className="flex items-center bg-surface-card rounded-[6px] px-2.5 py-1.5 border border-border-subtle gap-1">
      {prefix && <span className="text-text-quaternary text-[12px]">{prefix}</span>}
      <input
        type="number" min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-[13px] font-medium text-text-primary outline-none placeholder:text-text-quaternary"
        style={{ fontFamily: 'var(--font-mono)' }}
      />
      {suffix && <span className="text-text-quaternary text-[11px]">{suffix}</span>}
    </div>
  )
}

function SummaryRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-text-tertiary">{label}</span>
      <span className="text-[11px] font-medium" style={{ fontFamily: 'var(--font-mono)', color: accent ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
        {value}
      </span>
    </div>
  )
}
