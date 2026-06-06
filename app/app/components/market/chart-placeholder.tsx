import { useState } from 'react'

const CameraIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
)

const FullscreenIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
)

const SettingsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.07 4.93A10 10 0 0 0 4.93 19.07M4.93 4.93A10 10 0 0 0 19.07 19.07" />
  </svg>
)

const CandlestickIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="8" width="4" height="8" rx="1" />
    <rect x="16" y="6" width="4" height="10" rx="1" />
    <line x1="6" y1="4" x2="6" y2="8" />
    <line x1="6" y1="16" x2="6" y2="20" />
    <line x1="18" y1="3" x2="18" y2="6" />
    <line x1="18" y1="16" x2="18" y2="21" />
  </svg>
)

const UndoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </svg>
)

const RedoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 14 20 9 15 4" />
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
  </svg>
)

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 .49-4.93" />
  </svg>
)

interface ChartPlaceholderProps {
  symbol: string
  ohlc?: { open: number; high: number; low: number; close: number; change: number; changePct: number }
}

const ChartPlaceholder = ({ symbol, ohlc }: ChartPlaceholderProps) => {
  const [interval, setIntervalState] = useState('1h')
  const [timeRange, setTimeRange] = useState('5d')

  const intervals = ['1h']
  const timeRanges = ['3m', '5d', '1d']

  const isPositive = ohlc ? ohlc.change >= 0 : false
  const changeColor = isPositive ? 'text-bullish-green' : 'text-bearish-red'

  return (
    <div className="flex flex-col h-full bg-surface-primary">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle shrink-0">
        {/* Interval selector */}
        {intervals.map((iv) => (
          <button
            key={iv}
            onClick={() => setIntervalState(iv)}
            className={`px-2 py-1 text-[13px] font-medium rounded-[5px] transition-colors ${
              interval === iv
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {iv}
          </button>
        ))}

        <div className="w-px h-4 bg-border-subtle mx-0.5" />

        {/* Chart type */}
        <button className="p-1.5 text-text-secondary hover:text-text-primary rounded-[5px] hover:bg-surface-hover transition-colors">
          <CandlestickIcon />
        </button>

        <div className="w-px h-4 bg-border-subtle mx-0.5" />

        {/* Indicators */}
        <button className="flex items-center gap-1 px-2 py-1 text-[13px] text-text-secondary hover:text-text-primary rounded-[5px] hover:bg-surface-hover transition-colors">
          <SettingsIcon />
          Indicators
        </button>

        <div className="w-px h-4 bg-border-subtle mx-0.5" />

        {/* Undo/Redo */}
        <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
          <UndoIcon />
        </button>
        <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
          <RedoIcon />
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
            <SettingsIcon />
          </button>
          <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
            <FullscreenIcon />
          </button>
          <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
            <CameraIcon />
          </button>
        </div>
      </div>

      {/* OHLC badge bar */}
      {ohlc && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle shrink-0">
          <span className="text-[13px] text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {symbol} · {interval} · <span className="text-brand-violet">Ultramarkets</span>
          </span>
          <span className="w-2 h-2 rounded-full bg-brand-violet" />
          <span className="text-[13px] text-text-tertiary ml-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            O <span className="text-text-secondary">{ohlc.open.toFixed(1)}</span>{' '}
            H <span className="text-text-secondary">{ohlc.high.toFixed(1)}</span>{' '}
            L <span className="text-text-secondary">{ohlc.low.toFixed(1)}</span>{' '}
            C <span className="text-text-secondary">{ohlc.close.toFixed(1)}</span>{' '}
            <span className={changeColor}>{ohlc.change >= 0 ? '+' : ''}{ohlc.change.toFixed(1)} ({ohlc.changePct >= 0 ? '+' : ''}{ohlc.changePct.toFixed(2)}%)</span>
          </span>
        </div>
      )}

      {/* Chart area — placeholder */}
      <div className="flex-1 relative overflow-hidden bg-surface-primary">
        {/* TradingView placeholder */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-surface-card border border-border-subtle flex items-center justify-center mx-auto mb-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-tertiary">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <p className="text-[13px] text-text-tertiary">Chart coming soon</p>
          </div>
        </div>

        {/* TradingView watermark */}
        <div className="absolute bottom-8 left-4">
          <div className="w-9 h-9 rounded-full bg-surface-card/80 border border-border-subtle flex items-center justify-center">
            <span className="text-[11px] font-bold text-text-tertiary">TV</span>
          </div>
        </div>

        {/* Drag handle */}
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-3 h-8 flex items-center justify-center cursor-ew-resize">
          <div className="w-0.5 h-6 bg-border-subtle rounded-full" />
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border-subtle shrink-0">
        {timeRanges.map((range) => (
          <button
            key={range}
            onClick={() => setTimeRange(range)}
            className={`px-2 py-1 text-[13px] font-medium rounded-[5px] transition-colors ${
              timeRange === range
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {range}
          </button>
        ))}

        <div className="w-px h-4 bg-border-subtle mx-0.5" />

        <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
          <RefreshIcon />
        </button>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-text-tertiary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            10:07:23 UTC
          </span>
          <button className="px-2 py-0.5 text-[13px] text-text-secondary border border-border-subtle rounded-[5px] hover:bg-surface-hover transition-colors">
            %
          </button>
        </div>
      </div>
    </div>
  )
}

export default ChartPlaceholder
