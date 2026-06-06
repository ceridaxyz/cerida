import { useState } from 'react'

const LEVERAGE_MARKS = [2, 3, 4, 5, 6, 7, 8, 9, 10]

const TradingPanel = () => {
  const [direction, setDirection] = useState<'long' | 'short'>('long')
  const [orderType, setOrderType] = useState<'market' | 'limit' | 'pro'>('market')
  const [pctSelected, setPctSelected] = useState<number | null>(null)
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(false)
  const [leverage, setLeverage] = useState(2)

  const pctOptions = [10, 25, 50, 75]

  return (
    <div className="flex flex-col bg-surface-card border-l border-border-subtle h-full min-w-0">
      {/* LONG / SHORT toggle */}
      <div className="flex border-b border-border-subtle shrink-0">
        <button
          onClick={() => setDirection('long')}
          className={`flex-1 py-3 text-[15px] font-semibold tracking-wide transition-colors ${
            direction === 'long'
              ? 'bg-surface-hover text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          LONG
        </button>
        <button
          onClick={() => setDirection('short')}
          className={`flex-1 py-3 text-[15px] font-semibold tracking-wide transition-colors ${
            direction === 'short'
              ? 'bg-surface-hover text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          SHORT
        </button>
      </div>

      {/* Order type tabs */}
      <div className="flex items-center gap-0 px-3 pt-3 pb-1 border-b border-border-subtle shrink-0">
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
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-3 py-3 flex-1 overflow-auto">
        {/* Margin row */}
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-text-secondary">Margin</span>
          <span className="text-[13px] text-text-tertiary">
            Bal. <span className="text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>$8</span>
          </span>
        </div>

        {/* Amount input */}
        <div className="flex items-center bg-surface-primary rounded-[8px] px-3 py-2 border border-border-subtle gap-2">
          <span className="text-[28px] font-medium text-text-primary tracking-tight" style={{ fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.3px' }}>
            $0<span className="text-text-tertiary">.00</span>
          </span>
          <span className="ml-auto flex items-center justify-center px-2 py-0.5 rounded-[3px] text-[13px] font-semibold bg-brand-violet/20 text-brand-violet border border-brand-violet/30">
            2X
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

        {/* Leverage */}
        <div>
          <span className="text-[14px] text-text-secondary block mb-2">Leverage</span>
          <div className="flex items-end gap-0.5 mb-3">
            <span className="text-[32px] font-semibold text-text-primary leading-none" style={{ fontFamily: 'Barlow, sans-serif' }}>
              {leverage}
            </span>
            <span className="text-[18px] font-medium text-text-secondary mb-0.5">×</span>
          </div>

          {/* Leverage slider row */}
          <div className="relative">
            {/* Track */}
            <div className="flex items-center gap-[1px] mb-1.5">
              {LEVERAGE_MARKS.map((mark) => (
                <button
                  key={mark}
                  onClick={() => setLeverage(mark)}
                  className={`h-3 flex-1 rounded-[2px] transition-colors ${
                    mark <= leverage ? 'bg-brand-violet' : 'bg-surface-hover'
                  }`}
                />
              ))}
            </div>
            {/* Labels */}
            <div className="flex items-center justify-between">
              {LEVERAGE_MARKS.map((mark) => (
                <button
                  key={mark}
                  onClick={() => setLeverage(mark)}
                  className={`text-[10px] transition-colors ${
                    mark === leverage ? 'text-brand-violet font-medium' : 'text-text-tertiary'
                  }`}
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                >
                  {mark}x
                </button>
              ))}
            </div>
          </div>
        </div>

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
      </div>

      {/* Sign in CTA */}
      <div className="px-3 pb-3 shrink-0">
        <button className="w-full py-3 bg-bullish-green text-[#1a1a1a] text-[15px] font-semibold rounded-[8px] hover:opacity-90 transition-opacity">
          Sign in
        </button>
      </div>
    </div>
  )
}

export default TradingPanel
