import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { IconPlus } from '@tabler/icons-react'
import { useComboDispatch } from '../market/combo-context'

// ── On-chain mapping ────────────────────────────────────────────────────────────
// A range bet is predict::mint_range over RangeKey(oracle_id, expiry,
// lower_strike, higher_strike) with lower < higher. You mint `quantity` range
// tokens and win `quantity` quote if price settles in [lower, higher] at expiry.
// Cost = quantity × ask, where ask = SVI fair price + spread, bounded by
// ask_bounds. Strikes live on the oracle's tick grid; all values are 1e9-scaled.

const PRICE_SCALE = 1_000_000_000
const DUSDC_SCALE = 1_000_000
const toChainPrice = (p: number) => Math.round(p * PRICE_SCALE)
const toChainDusdc = (usd: number) => Math.round(usd * DUSDC_SCALE)

// The oracle quotes strikes on a $1 tick (tick_size 1e9) from min_strike $50k.
// For a ~$66k asset that's far too fine to display, so the UI groups ticks into
// a coarse "nice" strike step scaled to the price magnitude.
const NUM_BANDS = 12
const HEAT = 1.3 // fixed probability-heat intensity (drama)
const niceStep = (price: number) => {
  const target = price * 0.0035 // ≈ band every 0.35% of spot
  const pow = 10 ** Math.floor(Math.log10(target))
  const mult = [1, 2, 2.5, 5, 10].find((m) => m * pow >= target) ?? 10
  return mult * pow // e.g. $250 at $66k, $5 at $1.7k
}

// Spread applied over the SVI fair price (mirrors pricing_config.base_spread),
// and the post-spread ask bounds (pricing_config min/max ask).
const SPREAD = 0.025
const MIN_ASK = 0.01
const MAX_ASK = 0.99

// σ grows ~√t with time-to-expiry, so near-dated markets tighten the
// distribution (theta-like) and far-dated ones spread it across more strikes.
const sigmaFor = (hrs: number, step: number) => step * 2 * Math.sqrt(Math.max(hrs, 0.01))

// Normal CDF (Abramowitz–Stegun erf) for SVI-style range probabilities.
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x))
  return x >= 0 ? y : -y
}
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2))

// Dramatic probability heat: cold indigo tails → blazing amber near the money.
// `t01` is the band's probability relative to the hottest band; `intensity`
// (≈0.4–2.5) scales the drama.
function heatColor(t01: number, intensity: number) {
  const t = Math.pow(Math.min(1, t01), 0.6)
  const a = Math.min(0.95, (0.03 + t * 0.62) * intensity)
  const r = Math.round(96 + t * 159) // 96 → 255
  const g = Math.round(92 + t * 96) // 92 → 188
  const b = Math.round(255 - t * 225) // 255 → 30
  return `rgba(${r},${g},${b},${a.toFixed(3)})`
}

// Thousands-separated strike, e.g. 66500 → "66,500".
const fmtStrike = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: 0 })

interface Band {
  idx: number
  lower: number
  upper: number
}

interface Props {
  currentPrice?: number
  oracleId?: string
  // Expiry is a property of the selected oracle (from GET /oracles), not a user
  // choice. Defaults to ~1h out for the standalone demo.
  oracleExpiry?: number
  underlying?: string
  onSubmit?: (params: {
    oracleId: string; expiry: number
    lower: number; higher: number; qty: number; maxCost: number
  }) => void
}

export default function RangeTrading({
  currentPrice = 66612, // BTC spot from /oracles state (demo default)
  oracleId = '',
  oracleExpiry,
  underlying = 'BTC',
  onSubmit,
}: Props) {
  const { addLeg } = useComboDispatch()
  // The oracle's expiry timestamp (fixed by the market, not chosen here).
  const expiry = useMemo(() => oracleExpiry ?? Date.now() + 60 * 60_000, [oracleExpiry])
  // Display strike step scaled to the asset's price magnitude (BTC ~$66k → $250).
  const STRIKE_STEP = useMemo(() => niceStep(currentPrice), [currentPrice])
  // Visible strike count — scroll the bar to zoom the range in/out.
  const [numBands, setNumBands] = useState(NUM_BANDS)
  // Strike ladder around the current price (snapped to the display grid).
  const strikes = useMemo(() => {
    const base = Math.round(currentPrice / STRIKE_STEP) * STRIKE_STEP - (numBands / 2) * STRIKE_STEP
    return Array.from({ length: numBands + 1 }, (_, i) => base + i * STRIKE_STEP)
  }, [currentPrice, STRIKE_STEP, numBands])
  const bands = useMemo<Band[]>(
    () => strikes.slice(0, -1).map((lo, i) => ({ idx: i, lower: lo, upper: strikes[i + 1]! })),
    [strikes],
  )
  const domainLo = strikes[0]!
  const domainHi = strikes[strikes.length - 1]!
  const span = domainHi - domainLo

  // Live price — gentle mean-reverting walk inside the ladder.
  const [price, setPrice] = useState(currentPrice)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setPrice((p) => {
        const next = p + (currentPrice - p) * 0.05 + (Math.random() - 0.5) * STRIKE_STEP * 0.5
        return Math.max(domainLo + 0.5, Math.min(domainHi - 0.5, next))
      })
      setNow(Date.now())
    }, 700)
    return () => clearInterval(id)
  }, [currentPrice, domainLo, domainHi, STRIKE_STEP])

  // σ from the oracle's actual time-to-expiry.
  const secsToExpiry = Math.max(1, (expiry - now) / 1000)
  const sigma = sigmaFor(secsToExpiry / 3600, STRIKE_STEP)
  const mmss = `${Math.floor(secsToExpiry / 3600) > 0 ? Math.floor(secsToExpiry / 3600) + 'h ' : ''}${Math.floor((secsToExpiry % 3600) / 60)}m ${Math.floor(secsToExpiry % 60)}s`

  // Selection stored as price bounds (not band indices) so it survives zoom.
  const snap0 = Math.round(currentPrice / STRIKE_STEP) * STRIKE_STEP
  const [selLo, setSelLo] = useState(snap0)
  const [selHi, setSelHi] = useState(snap0 + STRIKE_STEP)
  const dragging = useRef(false)
  const anchor = useRef({ lo: selLo, hi: selHi })
  const lower = Math.min(selLo, selHi)
  const higher = Math.max(selLo, selHi)
  const selected = (band: Band) => band.lower >= lower && band.upper <= higher

  useEffect(() => {
    const up = () => (dragging.current = false)
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])
  const onDown = useCallback((band: Band) => {
    dragging.current = true
    anchor.current = { lo: band.lower, hi: band.upper }
    setSelLo(band.lower)
    setSelHi(band.upper)
  }, [])
  const onEnter = useCallback((band: Band) => {
    if (!dragging.current) return
    setSelLo(Math.min(anchor.current.lo, band.lower))
    setSelHi(Math.max(anchor.current.hi, band.upper))
  }, [])

  // Drag an edge handle to resize the range (snaps to the strike grid).
  const dragHandle = (which: 'lo' | 'hi') => (e: React.PointerEvent) => {
    e.stopPropagation()
    const rect = barRef.current!.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const snapped = Math.max(
        domainLo,
        Math.min(domainHi, Math.round((domainLo + frac * span) / STRIKE_STEP) * STRIKE_STEP),
      )
      if (which === 'lo') setSelLo(Math.min(snapped, higher - STRIKE_STEP))
      else setSelHi(Math.max(snapped, lower + STRIKE_STEP))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Per-band SVI probability (for the heat colouring).
  const bandProb = (band: Band) => normCdf((band.upper - price) / sigma) - normCdf((band.lower - price) / sigma)

  // ── Pricing — fair price + spread, bounded by ask_bounds ───────────────────
  const fair = normCdf((higher - price) / sigma) - normCdf((lower - price) / sigma)
  const askPerUnit = Math.max(MIN_ASK, Math.min(MAX_ASK, fair + SPREAD))
  const winProb = fair
  const priceInRange = price >= lower && price < higher

  // The user bets a dollar amount; quantity (units paying $1 each) is derived as
  // amount / ask. Payout = quantity, so you "bet $X to win $Y".
  const [hover, setHover] = useState<Band | null>(null)

  // Scroll the bar to zoom the visible strike range in/out. Accumulate the
  // wheel delta so trackpad momentum doesn't blast through the range.
  const barRef = useRef<HTMLDivElement>(null)
  const wheelAcc = useRef(0)
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const THRESHOLD = 140
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      wheelAcc.current += e.deltaY
      if (Math.abs(wheelAcc.current) < THRESHOLD) return
      const dir = wheelAcc.current > 0 ? 2 : -2
      wheelAcc.current = 0
      setNumBands((n) => Math.max(6, Math.min(30, n + dir)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const [amountRaw, setAmount] = useState('25')
  const amount = parseFloat(amountRaw) || 0
  const qtyNum = amount > 0 ? amount / askPerUnit : 0 // units of $1 payout
  const maxPayout = qtyNum // win → qty quote
  const multiple = amount > 0 ? maxPayout / amount : 0 // 1 / ask
  const canSubmit = amount > 0 && qtyNum > 0 && lower < higher

  function handleSubmit() {
    if (!canSubmit || !onSubmit) return
    onSubmit({
      oracleId,
      expiry,
      lower: toChainPrice(lower),
      higher: toChainPrice(higher),
      qty: Math.floor(qtyNum), // integer mint_range quantity
      maxCost: toChainDusdc(amount), // you never pay more than your stake
    })
  }

  const pctOf = (p: number) => ((p - domainLo) / span) * 100
  const maxBandProb = Math.max(...bands.map(bandProb), 0.01)

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px]">
      <div className="flex flex-col gap-3 px-3 py-3 flex-1 overflow-y-auto overflow-x-hidden no-scrollbar">

        {/* Lands-in header */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-tertiary">
            Lands in: <span className="text-text-secondary font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
              ${fmtStrike(lower)}–${fmtStrike(higher)}
            </span>
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-[4px] font-semibold"
            style={{
              background: priceInRange ? 'rgba(52,168,119,0.16)' : 'rgba(255,255,255,0.05)',
              color: priceInRange ? '#34a877' : 'var(--color-text-quaternary)',
            }}
          >
            {priceInRange ? 'IN RANGE' : 'OUT'}
          </span>
        </div>

        {/* Strike ladder — segments coloured by SVI probability */}
        <div className="select-none">
          <div className="relative h-5">
            <motion.div
              className="absolute -translate-x-1/2 flex flex-col items-center"
              animate={{ left: `${pctOf(price)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            >
              <span
                className="px-1 rounded-[3px] text-[10px] font-bold text-white whitespace-nowrap"
                style={{ background: '#0b9981', fontFamily: 'var(--font-mono)' }}
              >
                ${fmtStrike(price)}
              </span>
            </motion.div>
          </div>

          <div
            ref={barRef}
            className="relative flex gap-[2px] h-8"
            title="Scroll to zoom the range"
            onPointerLeave={() => setHover(null)}
          >
            {bands.map((band) => {
              const isSel = selected(band)
              const t = Math.min(1, bandProb(band) / maxBandProb)
              return (
                <button
                  key={band.idx}
                  onPointerDown={() => onDown(band)}
                  onPointerEnter={() => {
                    onEnter(band)
                    setHover(band)
                  }}
                  className="relative h-full rounded-[3px] transition-all"
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    background: isSel ? 'rgba(128,125,254,0.95)' : heatColor(t, HEAT),
                    outline: isSel ? '1.5px solid rgba(255,255,255,0.85)' : 'none',
                    outlineOffset: -1.5,
                    cursor: 'pointer',
                  }}
                />
              )
            })}
            {/* zoom readout (scroll the bar to change) */}
            <span
              className="absolute top-0.5 right-0.5 px-1 rounded-[3px] text-[8px] font-semibold pointer-events-none"
              style={{ background: 'rgba(0,0,0,0.35)', color: 'rgba(255,255,255,0.6)', fontFamily: 'var(--font-mono)' }}
            >
              {numBands} strikes
            </span>

            {/* hover tooltip — band range + win probability */}
            {hover && (
              <div
                className="absolute -translate-x-1/2 bottom-full mb-1.5 pointer-events-none z-20 rounded-[6px] border border-border-default bg-surface-card px-2 py-1 shadow-xl whitespace-nowrap"
                style={{ left: `${pctOf((hover.lower + hover.upper) / 2)}%` }}
              >
                <div className="text-[10px] font-semibold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${fmtStrike(hover.lower)}–${fmtStrike(hover.upper)}
                </div>
                <div className="text-[9px] text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                  {(bandProb(hover) * 100).toFixed(1)}% to land here
                </div>
              </div>
            )}
            <motion.div
              className="absolute top-0 bottom-0 w-px pointer-events-none"
              style={{ background: 'rgba(255,255,255,0.9)' }}
              animate={{ left: `${pctOf(price)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />

            {/* draggable range edge handles */}
            {([['lo', lower] as const, ['hi', higher] as const]).map(([which, p]) => (
              <div
                key={which}
                onPointerDown={dragHandle(which)}
                className="absolute top-0 bottom-0 z-10 flex items-center justify-center group"
                style={{ left: `${pctOf(p)}%`, width: 14, transform: 'translateX(-50%)', cursor: 'ew-resize' }}
              >
                <div
                  className="h-full w-[3px] rounded-full transition-transform group-hover:scale-x-150"
                  style={{ background: '#807dfe', boxShadow: '0 0 6px rgba(128,125,254,0.7)' }}
                />
                <div
                  className="absolute w-2.5 h-2.5 rounded-full border-2"
                  style={{ background: 'var(--color-surface-primary)', borderColor: '#807dfe' }}
                />
              </div>
            ))}
          </div>

          {/* strike ticks */}
          <div className="relative h-4 mt-1">
            {strikes.filter((_, i) => i % 2 === 0).map((p) => (
              <span
                key={p}
                className="absolute -translate-x-1/2 text-[9px] text-text-quaternary"
                style={{ left: `${pctOf(p)}%`, fontFamily: 'var(--font-mono)' }}
              >
                ${fmtStrike(p)}
              </span>
            ))}
          </div>
        </div>

        {/* Market — oracle + expiry are fixed by the selected market (GET /oracles) */}
        <div className="flex items-center justify-between rounded-[7px] px-2.5 py-2 bg-surface-card border border-border-subtle">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Market</span>
            <span className="text-[12px] font-semibold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
              {underlying} · {new Date(expiry).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Expires in</span>
            <span className="text-[12px] font-semibold" style={{ fontFamily: 'var(--font-mono)', color: secsToExpiry < 60 ? '#f23546' : '#a6a3ff' }}>
              {mmss}
            </span>
          </div>
        </div>

        {/* Bet amount */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium text-text-quaternary uppercase tracking-widest">You bet</span>
          <CompactInput value={amountRaw} onChange={setAmount} prefix="$" placeholder="25" />
          <div className="flex gap-1 mt-0.5">
            {[10, 25, 50, 100].map((v) => (
              <button
                key={v}
                onClick={() => setAmount(String(v))}
                className="flex-1 py-1 rounded-[5px] text-[11px] font-medium transition-colors"
                style={{
                  background: amount === v ? 'var(--color-surface-hover)' : 'var(--color-surface-card)',
                  color: amount === v ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                  border: `1px solid ${amount === v ? 'var(--color-border-default)' : 'var(--color-border-subtle)'}`,
                }}
              >
                ${v}
              </button>
            ))}
          </div>
        </div>

        {/* Bet → win summary */}
        <AnimatePresence>
          {amount > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-[8px] border border-border-subtle bg-surface-card px-3 py-2.5 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Bet</span>
                  <span className="text-[16px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                    ${amount.toFixed(2)}
                  </span>
                </div>
                <span className="text-[18px] text-text-quaternary">→</span>
                <div className="flex flex-col items-end">
                  <span className="text-[10px] uppercase tracking-wider text-text-quaternary">To win</span>
                  <span className="text-[16px] font-bold" style={{ fontFamily: 'var(--font-mono)', color: '#0b9981' }}>
                    ${maxPayout.toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-border-subtle pt-1.5">
                <span className="text-[10px] text-text-tertiary">
                  Win prob (SVI) <span className="text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>~{(winProb * 100).toFixed(0)}%</span>
                </span>
                <span className="text-[11px] font-semibold" style={{ fontFamily: 'var(--font-mono)', color: '#807dfe' }}>
                  {multiple.toFixed(2)}× payout
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Submit + Add to Combo */}
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
          Mint Range · ${fmtStrike(lower)}–${fmtStrike(higher)}
        </button>
        <button
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) return
            addLeg({
              id:        `range-${lower}-${higher}`,
              label:     `$${fmtStrike(lower)}–$${fmtStrike(higher)}`,
              direction: 'range',
              prob:      winProb,
              multiplier: multiple,
            })
          }}
          className="flex items-center justify-center gap-1.5 w-full py-1.5 text-[11px] font-medium rounded-[7px] shrink-0 transition-colors"
          style={{
            background: canSubmit ? 'rgba(128,125,254,0.08)' : 'var(--color-surface-card)',
            color:      canSubmit ? '#807dfe'                : 'var(--color-text-quaternary)',
            border:     `1px solid ${canSubmit ? 'rgba(128,125,254,0.2)' : 'var(--color-border-subtle)'}`,
            cursor:     canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          <IconPlus size={11} stroke={2.5} />
          Add to Combo
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
