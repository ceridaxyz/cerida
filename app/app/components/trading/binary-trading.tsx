import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const PRICE_SCALE = 1_000_000_000
const DUSDC_SCALE = 1_000_000

function toChainPrice(usd: number) { return Math.round(usd * PRICE_SCALE) }
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
    oracleId: string
    expiry: number
    strike: number
    isUp: boolean
    qty: number
    maxCost: number
  }) => void
}

export default function BinaryTrading({ currentPrice = 0.235, oracleId = '', onSubmit }: Props) {
  const [side,       setSide]      = useState<'up' | 'down'>('up')
  const [strikeRaw,  setStrikeRaw] = useState(String((currentPrice * 100).toFixed(1)))
  const [expiryIdx,  setExpiryIdx] = useState(2)
  const [qty,        setQty]       = useState('1')
  const [maxCostRaw, setMaxCost]   = useState('')

  const strike  = parseFloat(strikeRaw) || 0
  const qtyNum  = parseInt(qty)         || 0
  const maxCost = parseFloat(maxCostRaw) || 0

  const prob           = side === 'up' ? strike / 100 : 1 - strike / 100
  const estCost        = Math.max(0.01, prob) * qtyNum
  const profit         = qtyNum - estCost
  const canSubmit      = qtyNum > 0 && maxCost > 0 && strike > 0
  const upColor        = 'var(--color-bullish-green)'
  const downColor      = 'var(--color-bearish-red)'
  const accent         = side === 'up' ? upColor : downColor

  function handleSubmit() {
    if (!canSubmit || !onSubmit) return
    onSubmit({
      oracleId,
      expiry:  Date.now() + EXPIRY_OPTIONS[expiryIdx]!.ms,
      strike:  toChainPrice(strike / 100),
      isUp:    side === 'up',
      qty:     qtyNum,
      maxCost: toChainDusdc(maxCost),
    })
  }

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px]">

      {/* UP / DOWN tabs */}
      <div className="flex border-b border-border-subtle shrink-0">
        {(['up', 'down'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className="relative flex-1 py-1.5 text-[12px] font-semibold tracking-wide transition-colors"
            style={{
              color: side === s ? (s === 'up' ? upColor : downColor) : 'var(--color-text-tertiary)',
              background: side === s
                ? (s === 'up' ? 'rgba(39,166,68,0.07)' : 'rgba(235,87,87,0.07)')
                : 'transparent',
            }}
          >
            {s === 'up' ? '↑ UP' : '↓ DOWN'}
            {side === s && (
              <motion.span
                layoutId="binary-underline"
                className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full"
                style={{ backgroundColor: accent }}
              />
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 px-3 py-2.5 flex-1 overflow-hidden">

        {/* Strike */}
        <Row label="Strike">
          <CompactInput value={strikeRaw} onChange={setStrikeRaw} suffix="¢" placeholder={String((currentPrice * 100).toFixed(1))} />
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

        {/* Qty + Max cost inline */}
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
              <SummaryRow label="Est. cost"   value={`~$${estCost.toFixed(3)}`} />
              <SummaryRow label="Max payout"  value={`$${qtyNum.toFixed(2)}`} accent />
              <SummaryRow label="Profit"       value={`~$${profit.toFixed(3)}`} accent />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Submit */}
        <button
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="mt-auto w-full py-2 text-[12px] font-semibold rounded-[7px] transition-opacity shrink-0"
          style={{
            backgroundColor: canSubmit ? accent : 'var(--color-surface-hover)',
            color:  canSubmit ? '#fff' : 'var(--color-text-quaternary)',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {side === 'up' ? '↑' : '↓'} Buy {side.toUpperCase()} · {strike.toFixed(1)}¢
        </button>
      </div>
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
