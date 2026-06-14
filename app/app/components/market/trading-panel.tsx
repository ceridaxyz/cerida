import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence, useMotionValue, animate } from 'framer-motion'
import { IconChevronDown } from '@tabler/icons-react'
import RangeTrading from '../trading/range-trading'

const MIN_LEV = 2, MAX_LEV = 50, STEPS = MAX_LEV - MIN_LEV
const LABEL_MARKS = [2, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]
const barH = (step: number) => 6 + (step / STEPS) * 44  // 6px → 50px

function LeverageSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbX = useMotionValue(0)
  const dragging = useRef(false)
  const [showHandle, setShowHandle] = useState(false)

  const getW = () => trackRef.current?.clientWidth ?? 0
  const levToX = (lev: number) => ((lev - MIN_LEV) / STEPS) * getW()
  const xToLev = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x / (getW() || 1))) * STEPS) + MIN_LEV

  useEffect(() => {
    if (!dragging.current) thumbX.set(levToX(value))
  })

  const springTo = useCallback((lev: number) => {
    onChange(lev)
    animate(thumbX, levToX(lev), { type: 'spring', stiffness: 600, damping: 38, mass: 0.4 })
  }, [onChange]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleThumbDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    dragging.current = true
    setShowHandle(true)
    const origin = { clientX: e.clientX, x: thumbX.get() }

    const onMove = (e: PointerEvent) => {
      const nx = Math.max(0, Math.min(getW(), origin.x + e.clientX - origin.clientX))
      thumbX.set(nx)
      onChange(xToLev(nx))
    }
    const onUp = (e: PointerEvent) => {
      dragging.current = false
      setShowHandle(false)
      const nx = Math.max(0, Math.min(getW(), origin.x + e.clientX - origin.clientX))
      springTo(xToLev(nx))
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Major bars sit at each LABEL_MARK position
  const majors = LABEL_MARKS.map((mark, i) => ({
    pos: (mark - MIN_LEV) / STEPS,
    h: barH((mark - MIN_LEV)),
    active: mark <= value,
    step: i,
  }))

  // 3 minor bars evenly spaced between each pair of major bars
  const minors: { pos: number; h: number }[] = []
  for (let i = 0; i < LABEL_MARKS.length - 1; i++) {
    const aStep = (LABEL_MARKS[i] ?? MIN_LEV) - MIN_LEV
    const bStep = (LABEL_MARKS[i + 1] ?? MAX_LEV) - MIN_LEV
    for (let j = 1; j <= 3; j++) {
      const frac = j / 4
      const step = aStep + frac * (bStep - aStep)
      minors.push({ pos: step / STEPS, h: barH(aStep) + frac * (barH(bStep) - barH(aStep)) })
    }
  }

  return (
    <div>
      <div className="flex items-baseline gap-1 mb-1.5">
        <p className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest">Leverage</p>
        <motion.span
          key={value}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="ml-1.5 text-[20px] font-semibold text-text-primary leading-none"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {value}
        </motion.span>
        <span className="text-[13px] font-light text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>x</span>
      </div>

      <div
        ref={trackRef}
        className="relative select-none"
        style={{ height: 80, cursor: 'pointer' }}
        onPointerEnter={() => setShowHandle(true)}
        onPointerLeave={() => { if (!dragging.current) setShowHandle(false) }}
        onClick={(e) => {
          const rect = trackRef.current!.getBoundingClientRect()
          springTo(xToLev(e.clientX - rect.left))
        }}
      >
        {/* Bar + tick zone */}
        <div style={{ position: 'absolute', inset: '0 0 18px 0' }}>

          {/* Major bars */}
          {majors.map(({ pos, h, active }, i) => (
            <div key={`mj${i}`} style={{
              position: 'absolute', left: `${pos * 100}%`, bottom: 6,
              width: 2, height: h, transform: 'translateX(-1px)',
              backgroundColor: active ? '#9998ff' : 'rgba(255,255,255,0.08)',
              pointerEvents: 'none', transition: 'background-color 0.1s',
            }} />
          ))}

          {/* Minor bars */}
          {minors.map(({ pos, h }, i) => (
            <div key={`mn${i}`} style={{
              position: 'absolute', left: `${pos * 100}%`, bottom: 6,
              width: 1.5, height: h, transform: 'translateX(-0.75px)',
              backgroundColor: 'rgba(255,255,255,0.08)', opacity: 0.5,
              pointerEvents: 'none',
            }} />
          ))}

          {/* Major ticks */}
          {majors.map(({ pos, active }, i) => (
            <div key={`tmj${i}`} style={{
              position: 'absolute', left: `${pos * 100}%`, bottom: 0,
              width: 1.5, height: 5, transform: 'translateX(-0.75px)',
              backgroundColor: active ? '#9998ff' : 'rgba(255,255,255,0.8)',
              opacity: active ? 0.7 : 0.8, pointerEvents: 'none',
            }} />
          ))}

          {/* Minor ticks */}
          {minors.map(({ pos }, i) => (
            <div key={`tmn${i}`} style={{
              position: 'absolute', left: `${pos * 100}%`, bottom: 0,
              width: 1.5, height: 5, transform: 'translateX(-0.75px)',
              backgroundColor: 'rgba(255,255,255,0.08)', opacity: 0.4,
              pointerEvents: 'none',
            }} />
          ))}

          {/* Draggable thumb */}
          <motion.div
            onPointerDown={handleThumbDown}
            style={{
              position: 'absolute', left: 0, bottom: 6,
              x: thumbX,
              width: 12, height: 50,
              translateX: '-6px',
              backgroundColor: 'transparent',
              cursor: 'grab',
              zIndex: 10,
            }}
          >
            <div style={{
              position: 'absolute', left: '50%', top: 0, bottom: 0,
              width: 2, transform: 'translateX(-1px)',
              backgroundColor: '#9998ff',
            }} />
          </motion.div>

          {/* Drag handle grip — appears on drag */}
          <AnimatePresence>
            {showHandle && (
              <motion.div
                initial={{ opacity: 0, scale: 0.7, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.7, y: 6 }}
                transition={{ type: 'spring', stiffness: 500, damping: 28, mass: 0.4 }}
                style={{
                  position: 'absolute', left: 0, top: 0,
                  x: thumbX,
                  translateX: '-50%',
                  pointerEvents: 'none',
                  zIndex: 20,
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                }}
              >
                <div style={{
                  width: 22, height: 28,
                  backgroundColor: 'rgb(201,200,255)',
                  borderRadius: 6,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 4px)',
                  gridTemplateRows: 'repeat(3, 4px)',
                  gap: 2,
                  placeContent: 'center',
                  boxShadow: 'rgba(153,152,255,0.3) 0px 2px 10px, rgba(0,0,0,0.1) 0px 1px 3px',
                }}>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} style={{
                      width: 4, height: 4, borderRadius: '50%',
                      backgroundColor: 'rgb(153,152,255)', opacity: 0.7,
                    }} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Snap labels */}
        <div style={{ position: 'absolute', bottom: 0, left: 4, right: 4, height: 18 }}>
          {LABEL_MARKS.map((lev) => (
            <button
              key={lev}
              onClick={(e) => { e.stopPropagation(); springTo(lev) }}
              style={{
                position: 'absolute', left: `${((lev - MIN_LEV) / STEPS) * 100}%`,
                transform: 'translateX(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 10,
                fontWeight: lev === value ? 600 : 500,
                color: lev === value ? '#9998ff' : 'rgba(255,255,255,0.35)',
                padding: 0, lineHeight: 1, transition: 'color 0.15s',
              }}
            >
              {lev}x
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}


const TradingPanel = () => {
  const [direction, setDirection] = useState<'long' | 'short'>('long')
  const [orderType, setOrderType] = useState<'market' | 'limit' | 'pro'>('market')
  const [pctSelected, setPctSelected] = useState<number | null>(null)
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(false)
  const [leverage, setLeverage] = useState(2)

  const pctOptions = [10, 25, 50, 75]

  return (
    <div className="flex flex-col bg-surface-primary h-full min-w-0">
      {/* LONG / SHORT toggle */}
      <div className="flex border-b border-border-subtle shrink-0">
        <button
          onClick={() => setDirection('long')}
          className={`flex-1 py-2 text-[13px] font-semibold tracking-wide transition-colors ${
            direction === 'long'
              ? 'bg-surface-hover text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          LONG
        </button>
        <button
          onClick={() => setDirection('short')}
          className={`flex-1 py-2 text-[13px] font-semibold tracking-wide transition-colors ${
            direction === 'short'
              ? 'bg-surface-hover text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          SHORT
        </button>
      </div>

      {/* Order type tabs */}
      <div className="flex items-center gap-0 px-3 pt-2 pb-1.5 border-b border-border-subtle shrink-0">
        {(['market', 'limit', 'pro'] as const).map((type) => (
          <button
            key={type}
            onClick={() => setOrderType(type)}
            className={`relative flex items-center gap-1 px-3 py-1.5 text-[14px] font-medium rounded-[5px] transition-colors ${
              orderType === type
                ? 'text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {type.charAt(0).toUpperCase() + type.slice(1)}
            {type === 'limit' && (
              <span className="px-1 py-0.5 text-[10px] font-semibold bg-brand-violet/20 text-brand-violet rounded-[3px] leading-none">
                NEW
              </span>
            )}
            {orderType === type && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-text-primary rounded-full" />
            )}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 text-[14px] text-text-tertiary cursor-pointer hover:text-text-secondary">
          Pro
          <IconChevronDown size={12} stroke={2.5} />
        </div>
      </div>

      <div className="flex flex-col gap-3 px-3 py-3 flex-1 overflow-hidden">
        {/* Margin row */}
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-text-secondary">Margin</span>
          <span className="text-[13px] text-text-tertiary">
            Bal. <span className="text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>$8</span>
          </span>
        </div>

        {/* Amount input */}
        <div className="flex items-center bg-surface-primary rounded-[8px] px-3 py-2 border border-border-subtle gap-2">
          <span className="text-[22px] font-medium text-text-primary tracking-tight" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '-0.3px' }}>
            $0<span className="text-text-tertiary">.00</span>
          </span>
          <span className="ml-auto flex items-center justify-center px-2 py-0.5 rounded-[3px] text-[13px] font-semibold bg-brand-violet/20 text-brand-violet border border-brand-violet/30">
            {leverage}X
          </span>
        </div>

        {/* Percentage buttons */}
        <div className="flex items-center gap-1.5">
          {pctOptions.map((pct) => (
            <button
              key={pct}
              onClick={() => setPctSelected(pct === pctSelected ? null : pct)}
              className={`flex-1 py-1.5 text-[13px] font-medium rounded-[5px] transition-colors ${
                pctSelected === pct
                  ? 'bg-surface-hover text-text-primary'
                  : 'bg-surface-primary text-text-tertiary hover:text-text-secondary hover:bg-surface-hover/60'
              }`}
            >
              {pct}%
            </button>
          ))}
          <button
            onClick={() => setPctSelected(100)}
            className={`flex-1 py-1.5 text-[13px] font-medium rounded-[5px] transition-colors ${
              pctSelected === 100
                ? 'bg-surface-hover text-text-primary'
                : 'bg-surface-primary text-text-tertiary hover:text-text-secondary hover:bg-surface-hover/60'
            }`}
          >
            MAX
          </button>
        </div>

        {/* Leverage slider */}
        <LeverageSlider value={leverage} onChange={setLeverage} />

        {/* Take profit / Stop loss */}
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-text-secondary">Take profit / Stop loss</span>
          <button
            onClick={() => setTakeProfitEnabled(!takeProfitEnabled)}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              takeProfitEnabled ? 'bg-brand-violet' : 'bg-surface-hover'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                takeProfitEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Range section */}
        <div className="border-t border-border-subtle pt-2 -mx-3">
          <p className="px-3 pb-1 text-[11px] font-medium text-text-tertiary uppercase tracking-widest">Range</p>
          <RangeTrading />
        </div>
      </div>

      {/* Sign in CTA */}
      <div className="px-3 pb-3 shrink-0">
        <button className="w-full py-2.5 bg-bullish-green text-[#1a1a1a] text-[13px] font-semibold rounded-[8px] hover:opacity-90 transition-opacity">
          Sign in
        </button>
      </div>
    </div>
  )
}

export default TradingPanel
