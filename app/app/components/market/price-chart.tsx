import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type IPriceLine,
} from 'lightweight-charts';
import { getActiveLadder, getHistory, type HistPoint } from '../../lib/cerida-api';
import { yesNo } from '../../lib/svi';

const POLL_MS       = 4000;
const TARGET_CANDLES = 48;
const UP   = '#19e6bd';
const DOWN = '#f23546';
const TP_COLOR = '#0b9981';
const SL_COLOR = '#f23546';
const ENTRY_COLOR = '#807dfe';

interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number }

function yesCandles(pts: HistPoint[], strike: number): Candle[] {
  if (pts.length < 2) return [];
  const span   = (pts[pts.length - 1]!.t - pts[0]!.t) / 1000 || 1;
  const bucket = Math.max(2, Math.round(span / TARGET_CANDLES));
  const map    = new Map<number, Candle>();
  for (const p of pts) {
    const y = yesNo(p.svi, p.forward || p.spot, strike).yes * 100;
    const t = (Math.floor(p.t / 1000 / bucket) * bucket) as UTCTimestamp;
    const c = map.get(t);
    if (!c) map.set(t, { time: t, open: y, high: y, low: y, close: y });
    else { c.high = Math.max(c.high, y); c.low = Math.min(c.low, y); c.close = y; }
  }
  return [...map.values()].sort((a, b) => (a.time as number) - (b.time as number));
}

// ── Level line manager ────────────────────────────────────────────────────────

interface Level { price: number | null; line: IPriceLine | null }

function useLevelLine(
  seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>,
  color: string,
  title: string,
  lineStyle: LineStyle = LineStyle.Dashed,
) {
  const ref  = useRef<IPriceLine | null>(null)
  const prev = useRef<number | null>(null)

  const set = (price: number | null) => {
    const s = seriesRef.current
    if (!s) return
    if (ref.current) { s.removePriceLine(ref.current); ref.current = null }
    if (price !== null) {
      ref.current = s.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle,
        axisLabelVisible: true,
        title,
        axisLabelColor: color,
        axisLabelTextColor: '#fff',
      })
    }
    prev.current = price
  }

  const remove = () => set(null)
  return { set, remove, ref }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PriceChart() {
  const wrapRef  = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)

  const [oid,    setOid]    = useState<string | null>(null)
  const [strike, setStrike] = useState<number>(0)
  const [hdr,    setHdr]    = useState<{ yes: number; chg: number } | null>(null)
  const [err,    setErr]    = useState<string | null>(null)

  // Level state (in YES ¢)
  const [tp,    setTp]    = useState<number | null>(null)
  const [sl,    setSl]    = useState<number | null>(null)
  const [entry, setEntry] = useState<number | null>(null)
  const [showLevels, setShowLevels] = useState(false)

  const tpLine    = useLevelLine(seriesRef, TP_COLOR,    'TP')
  const slLine    = useLevelLine(seriesRef, SL_COLOR,    'SL')
  const entryLine = useLevelLine(seriesRef, ENTRY_COLOR, 'Entry', LineStyle.Solid)

  // Sync level state → chart lines
  useEffect(() => { tpLine.set(tp) },    [tp])    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { slLine.set(sl) },    [sl])    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { entryLine.set(entry) }, [entry]) // eslint-disable-line react-hooks/exhaustive-deps

  // Create chart
  useEffect(() => {
    if (!wrapRef.current) return
    const chart = createChart(wrapRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255,255,255,0.4)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.035)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(128,125,254,0.5)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#807dfe' },
        horzLine: { color: 'rgba(128,125,254,0.5)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#807dfe' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: true },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
      borderVisible: false,
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
    })
    chartRef.current  = chart
    seriesRef.current = series
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  useEffect(() => {
    let alive = true
    getActiveLadder()
      .then(l => alive && l[0] && setOid(l[0].oracleId))
      .catch(e => alive && setErr(String(e)))
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!oid) return
    let alive = true
    const tick = () =>
      getHistory(oid).then(pts => {
        if (!alive || pts.length < 2 || !seriesRef.current) return
        const lastSpot = pts[pts.length - 1]!.spot
        const k = strike || Math.round(lastSpot / 25) * 25
        if (!strike) setStrike(k)
        const candles = yesCandles(pts, k)
        seriesRef.current.setData(candles)
        const first = candles[0]!
        const last  = candles[candles.length - 1]!
        setHdr({ yes: last.close, chg: last.close - first.open })
      }).catch(e => alive && setErr(String(e)))
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [oid, strike])

  const mono   = { fontFamily: 'var(--font-mono)' } as const
  const yes    = hdr?.yes ?? null
  const curYes = yes ?? 50

  // Quick-set helpers: % offsets from current YES price
  const quickTp = (pct: number) => setTp(Math.min(99, +(curYes * (1 + pct / 100)).toFixed(1)))
  const quickSl = (pct: number) => setSl(Math.max(1,  +(curYes * (1 - pct / 100)).toFixed(1)))

  return (
    <div className="flex flex-col h-full">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle shrink-0 text-[11px]">
        <span className="text-text-secondary font-semibold">YES</span>
        {yes != null ? (
          <>
            <span className="font-bold" style={{ ...mono, color: UP }}>{yes.toFixed(1)}¢</span>
            <span className="text-text-quaternary" style={mono}>NO {(100 - yes).toFixed(1)}¢</span>
            <span className="text-[10px]" style={{ ...mono, color: (hdr?.chg ?? 0) >= 0 ? UP : DOWN }}>
              {(hdr?.chg ?? 0) >= 0 ? '+' : ''}{(hdr?.chg ?? 0).toFixed(1)}¢
            </span>
          </>
        ) : (
          <span className="text-text-quaternary">{err ? `error · ${err}` : 'loading…'}</span>
        )}
        {strike > 0 && (
          <span className="text-text-quaternary text-[10px]" style={mono}>
            ≥ ${strike.toLocaleString('en-US')} · live
          </span>
        )}

        {/* Levels toggle */}
        <button
          onClick={() => setShowLevels(v => !v)}
          className={`ml-auto flex items-center gap-1 px-2 py-0.5 rounded-[5px] text-[10px] font-medium transition-colors ${
            showLevels
              ? 'bg-brand-violet/20 text-brand-violet border border-brand-violet/30'
              : 'text-text-quaternary hover:text-text-secondary border border-transparent'
          }`}
        >
          Levels
          {(tp !== null || sl !== null || entry !== null) && (
            <span className="w-1.5 h-1.5 rounded-full bg-brand-violet" />
          )}
        </button>
      </div>

      {/* Level controls (collapsible) */}
      {showLevels && (
        <div className="flex items-center gap-3 px-3 py-2 border-b border-border-subtle shrink-0 bg-surface-card">

          {/* Entry */}
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: ENTRY_COLOR }}>Entry</span>
            <LevelInput value={entry} onChange={setEntry} color={ENTRY_COLOR} placeholder={curYes.toFixed(1)} />
            {entry !== null && (
              <ClearBtn onClick={() => setEntry(null)} />
            )}
          </div>

          <div className="w-px h-5 bg-border-subtle" />

          {/* TP */}
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: TP_COLOR }}>TP</span>
            <LevelInput value={tp} onChange={setTp} color={TP_COLOR} placeholder={`${(curYes * 1.25).toFixed(1)}`} />
            <QuickPcts onClick={quickTp} color={TP_COLOR} labels={['+10', '+25', '+50']} pcts={[10, 25, 50]} />
            {tp !== null && <ClearBtn onClick={() => setTp(null)} />}
          </div>

          <div className="w-px h-5 bg-border-subtle" />

          {/* SL */}
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: SL_COLOR }}>SL</span>
            <LevelInput value={sl} onChange={setSl} color={SL_COLOR} placeholder={`${(curYes * 0.75).toFixed(1)}`} />
            <QuickPcts onClick={quickSl} color={SL_COLOR} labels={['-10', '-25', '-50']} pcts={[10, 25, 50]} />
            {sl !== null && <ClearBtn onClick={() => setSl(null)} />}
          </div>

          {/* Clear all */}
          {(tp !== null || sl !== null || entry !== null) && (
            <>
              <div className="w-px h-5 bg-border-subtle" />
              <button
                onClick={() => { setTp(null); setSl(null); setEntry(null) }}
                className="text-[9px] text-text-quaternary hover:text-bearish-red transition-colors"
              >
                Clear all
              </button>
            </>
          )}
        </div>
      )}

      <div ref={wrapRef} className="flex-1 min-h-0" />
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LevelInput({
  value, onChange, color, placeholder,
}: {
  value: number | null
  onChange: (v: number | null) => void
  color: string
  placeholder: string
}) {
  const [raw, setRaw] = useState('')
  const [focused, setFocused] = useState(false)

  // Sync external value → display when not focused
  useEffect(() => {
    if (!focused) setRaw(value !== null ? value.toFixed(1) : '')
  }, [value, focused])

  return (
    <input
      type="number"
      value={focused ? raw : (value !== null ? value.toFixed(1) : '')}
      placeholder={placeholder}
      min={0.1} max={99.9} step={0.1}
      onFocus={() => { setFocused(true); setRaw(value !== null ? value.toFixed(1) : '') }}
      onBlur={() => {
        setFocused(false)
        const n = parseFloat(raw)
        onChange(isNaN(n) ? null : Math.max(0.1, Math.min(99.9, +n.toFixed(1))))
      }}
      onChange={e => setRaw(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="w-14 px-1.5 py-0.5 text-[10px] rounded-[4px] bg-surface-hover border border-border-default text-text-primary placeholder:text-text-quaternary outline-none focus:border-opacity-60"
      style={{ fontFamily: 'var(--font-mono)', borderColor: focused ? color : undefined }}
    />
  )
}

function QuickPcts({
  onClick, color, labels, pcts,
}: {
  onClick: (pct: number) => void
  color: string
  labels: string[]
  pcts: number[]
}) {
  return (
    <div className="flex items-center gap-0.5">
      {labels.map((label, i) => (
        <button
          key={label}
          onClick={() => onClick(pcts[i]!)}
          className="px-1.5 py-0.5 text-[9px] rounded-[3px] transition-colors hover:bg-surface-hover"
          style={{ color, fontFamily: 'var(--font-mono)' }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function ClearBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] text-text-quaternary hover:text-text-primary transition-colors leading-none"
    >
      ×
    </button>
  )
}
