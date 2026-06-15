import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const PRICE_SCALE = 1_000_000_000
const DUSDC_SCALE = 1_000_000

function toChainPrice(p: number) { return Math.round(p * PRICE_SCALE) }
function toChainDusdc(usd: number) { return Math.round(usd * DUSDC_SCALE) }

const EXPIRY_OPTIONS = [
  { label: '1h', ms: 60 * 60 * 1_000 },
  { label: '6h', ms: 6 * 60 * 60 * 1_000 },
  { label: '1d', ms: 24 * 60 * 60 * 1_000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1_000 },
]

// ── Zone taxonomy ───────────────────────────────────────────────────────────────

type Category = 'buy' | 'structure' | 'bear' | 'regulatory' | 'breakout'

const CATEGORIES: Record<Category, { label: string; color: string }> = {
  buy: { label: 'Buy zones', color: '#34a877' },
  structure: { label: 'Structure', color: '#565d68' },
  bear: { label: 'Bear scenarios', color: '#c2912f' },
  regulatory: { label: 'Regulatory tail', color: '#c25555' },
  breakout: { label: 'Breakout', color: '#807dfe' },
}

// Proportional zone map (fractions of the price domain), left→right.
const ZONE_PLAN: { frac: number; cat: Category }[] = [
  { frac: 0.15, cat: 'regulatory' },
  { frac: 0.10, cat: 'bear' },
  { frac: 0.10, cat: 'buy' },
  { frac: 0.07, cat: 'structure' },
  { frac: 0.08, cat: 'buy' },
  { frac: 0.10, cat: 'structure' },
  { frac: 0.10, cat: 'buy' },
  { frac: 0.11, cat: 'structure' },
  { frac: 0.10, cat: 'structure' },
  { frac: 0.09, cat: 'breakout' },
]

interface Zone {
  idx: number
  lo: number
  hi: number
  cat: Category
}

interface Props {
  currentPrice?: number
  oracleId?: string
  onSubmit?: (params: {
    oracleId: string; expiry: number
    lower: number; higher: number; qty: number; maxCost: number
  }) => void
}

export default function RangeTrading({ currentPrice = 55.4, oracleId = '', onSubmit }: Props) {
  // Fixed price domain + zones, anchored once so the map doesn't jitter.
  const center = currentPrice
  const domainLo = useMemo(() => center * 0.55, [center])
  const domainHi = useMemo(() => center * 1.38, [center])
  const span = domainHi - domainLo

  const zones = useMemo<Zone[]>(() => {
    let acc = domainLo
    return ZONE_PLAN.map((z, idx) => {
      const lo = acc
      const hi = acc + z.frac * span
      acc = hi
      return { idx, lo, hi, cat: z.cat }
    })
  }, [domainLo, span])

  // Live price — gentle random walk inside the domain.
  const [price, setPrice] = useState(center)
  useEffect(() => {
    const id = setInterval(() => {
      setPrice((p) => {
        const next = p + (Math.random() - 0.5) * span * 0.012
        return Math.max(domainLo + span * 0.02, Math.min(domainHi - span * 0.02, next))
      })
    }, 700)
    return () => clearInterval(id)
  }, [domainLo, domainHi, span])

  const priceZone = zones.find((z) => price >= z.lo && price < z.hi) ?? zones[0]!

  // ── Selection (contiguous zones) ───────────────────────────────────────────
  const startZone = useMemo(
    () => zones.find((z) => center >= z.lo && center < z.hi) ?? zones[Math.floor(zones.length / 2)]!,
    [zones, center],
  )
  const [sel, setSel] = useState<[number, number]>([startZone.idx, startZone.idx])
  const dragging = useRef(false)
  const [a, b] = [Math.min(sel[0], sel[1]), Math.max(sel[0], sel[1])]
  const lower = zones[a]!.lo
  const higher = zones[b]!.hi
  const selected = (i: number) => i >= a && i <= b

  useEffect(() => {
    const up = () => (dragging.current = false)
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  const onZoneDown = useCallback((i: number) => {
    dragging.current = true
    setSel([i, i])
  }, [])
  const onZoneEnter = useCallback((i: number) => {
    if (dragging.current) setSel((s) => [s[0], i])
  }, [])

  // ── Trade params ───────────────────────────────────────────────────────────
  const [expiryIdx, setExpiryIdx] = useState(2)
  const [qty, setQty] = useState('1')
  const [maxCostRaw, setMaxCost] = useState('')
  const qtyNum = parseInt(qty) || 0
  const maxCost = parseFloat(maxCostRaw) || 0

  const widthFrac = (higher - lower) / span
  const prob = Math.max(0.02, Math.min(0.95, widthFrac))
  const estCost = prob * qtyNum
  const profit = qtyNum - estCost
  const priceInRange = price >= lower && price < higher
  const canSubmit = qtyNum > 0 && lower < higher

  function handleSubmit() {
    if (!canSubmit || !onSubmit) return
    onSubmit({
      oracleId,
      expiry: Date.now() + EXPIRY_OPTIONS[expiryIdx]!.ms,
      lower: toChainPrice(lower),
      higher: toChainPrice(higher),
      qty: qtyNum,
      maxCost: toChainDusdc(maxCost),
    })
  }

  const pctOf = (p: number) => ((p - domainLo) / span) * 100

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px]">
      <div className="flex flex-col gap-3 px-3 py-3 flex-1 overflow-auto">

        {/* Lands-in header */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-tertiary">Lands in:</span>
          <span
            className="flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] font-semibold"
            style={{ background: 'var(--color-surface-card)', color: 'var(--color-text-primary)' }}
          >
            <span className="w-2 h-2 rounded-[2px]" style={{ background: CATEGORIES[priceZone.cat].color }} />
            {CATEGORIES[priceZone.cat].label}
            <span className="text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
              ${priceZone.lo.toFixed(0)}–{priceZone.hi.toFixed(0)}
            </span>
          </span>
        </div>

        {/* Zone bar */}
        <div className="select-none">
          {/* price marker label */}
          <div className="relative h-5">
            <motion.div
              className="absolute -translate-x-1/2 flex flex-col items-center"
              animate={{ left: `${pctOf(price)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            >
              <span
                className="px-1 rounded-[3px] text-[10px] font-bold text-white whitespace-nowrap"
                style={{ background: '#19181f', border: '1px solid var(--color-border-default)', fontFamily: 'var(--font-mono)' }}
              >
                ${price.toFixed(2)}
              </span>
            </motion.div>
          </div>

          {/* segments */}
          <div className="relative flex gap-[2px] h-8">
            {zones.map((z) => {
              const isSel = selected(z.idx)
              const col = CATEGORIES[z.cat].color
              return (
                <button
                  key={z.idx}
                  onPointerDown={() => onZoneDown(z.idx)}
                  onPointerEnter={() => onZoneEnter(z.idx)}
                  className="relative h-full rounded-[3px] transition-all"
                  style={{
                    flexGrow: z.hi - z.lo,
                    flexBasis: 0,
                    background: col,
                    opacity: isSel ? 1 : 0.42,
                    outline: isSel ? '1.5px solid rgba(255,255,255,0.85)' : 'none',
                    outlineOffset: -1.5,
                    cursor: 'pointer',
                  }}
                />
              )
            })}

            {/* live price line over the bar */}
            <motion.div
              className="absolute top-0 bottom-0 w-px pointer-events-none"
              style={{ background: 'rgba(255,255,255,0.9)' }}
              animate={{ left: `${pctOf(price)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>

          {/* axis ticks at zone boundaries */}
          <div className="relative h-4 mt-1">
            {zones.map((z) => (
              <span
                key={z.idx}
                className="absolute -translate-x-1/2 text-[9px] text-text-quaternary"
                style={{ left: `${pctOf(z.lo)}%`, fontFamily: 'var(--font-mono)' }}
              >
                ${z.lo.toFixed(0)}
              </span>
            ))}
            <span
              className="absolute -translate-x-1/2 text-[9px] text-text-quaternary"
              style={{ left: '100%', fontFamily: 'var(--font-mono)' }}
            >
              ${domainHi.toFixed(0)}
            </span>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {(Object.keys(CATEGORIES) as Category[]).map((c) => (
            <span key={c} className="flex items-center gap-1 text-[10px] text-text-tertiary">
              <span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: CATEGORIES[c].color }} />
              {CATEGORIES[c].label}
            </span>
          ))}
        </div>

        {/* Selected range chip */}
        <div
          className="flex items-center justify-between rounded-[7px] px-2.5 py-2"
          style={{ background: 'var(--color-surface-card)', border: '1px solid var(--color-border-subtle)' }}
        >
          <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Your range</span>
          <span className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
              ${lower.toFixed(0)} – ${higher.toFixed(0)}
            </span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-[4px] font-medium"
              style={{
                background: priceInRange ? 'rgba(52,168,119,0.16)' : 'rgba(255,255,255,0.05)',
                color: priceInRange ? '#34a877' : 'var(--color-text-quaternary)',
              }}
            >
              {priceInRange ? 'IN RANGE' : 'OUT'}
            </span>
          </span>
        </div>

        {/* Expiry */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium text-text-quaternary uppercase tracking-widest">Expiry</span>
          <div className="flex gap-1">
            {EXPIRY_OPTIONS.map((opt, i) => (
              <button
                key={opt.label}
                onClick={() => setExpiryIdx(i)}
                className="flex-1 py-1 rounded-[5px] text-[11px] font-medium transition-colors"
                style={{
                  background: expiryIdx === i ? 'var(--color-surface-hover)' : 'var(--color-surface-card)',
                  color: expiryIdx === i ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                  border: `1px solid ${expiryIdx === i ? 'var(--color-border-default)' : 'var(--color-border-subtle)'}`,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Qty + Max cost */}
        <div className="flex gap-2">
          <div className="flex flex-col gap-1 flex-1">
            <span className="text-[10px] font-medium text-text-quaternary uppercase tracking-widest">Qty</span>
            <CompactInput value={qty} onChange={setQty} suffix="x" placeholder="1" />
          </div>
          <div className="flex flex-col gap-1 flex-1">
            <span className="text-[10px] font-medium text-text-quaternary uppercase tracking-widest">Max cost</span>
            <CompactInput value={maxCostRaw} onChange={setMaxCost} prefix="$" placeholder="0.00" />
          </div>
        </div>

        {/* Summary */}
        <AnimatePresence>
          {qtyNum > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-[7px] border border-border-subtle bg-surface-card px-2.5 py-2 flex flex-col gap-1"
            >
              <SummaryRow label="Win prob" value={`~${(prob * 100).toFixed(0)}%`} />
              <SummaryRow label="Est. cost" value={`~$${estCost.toFixed(3)}`} />
              <SummaryRow label="Max payout" value={`$${qtyNum.toFixed(2)}`} accent />
              <SummaryRow label="Profit" value={`~$${profit.toFixed(3)}`} accent />
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
            color: canSubmit ? '#fff' : 'var(--color-text-quaternary)',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          Enter Range · ${lower.toFixed(0)}–${higher.toFixed(0)}
        </button>
      </div>
    </div>
  )
}

// ── helpers ────────────────────────────────────────────────────────────────────

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
        className="flex-1 bg-transparent text-[13px] font-medium text-text-primary outline-none placeholder:text-text-quaternary w-0"
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
