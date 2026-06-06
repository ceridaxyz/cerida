import { useState } from 'react'

interface OrderRow {
  price: string
  shares: number
  usd: string
  depth: number
  side: 'ask' | 'bid'
}

const ASK_ROWS: OrderRow[] = [
  { price: '31¢', shares: 50, usd: '$15.5', depth: 8, side: 'ask' },
  { price: '30¢', shares: 545, usd: '$163.5', depth: 18, side: 'ask' },
  { price: '28.9¢', shares: 450, usd: '$130.5', depth: 22, side: 'ask' },
  { price: '28¢', shares: 200, usd: '$56', depth: 12, side: 'ask' },
  { price: '27¢', shares: 100, usd: '$27', depth: 9, side: 'ask' },
  { price: '26¢', shares: 45, usd: '$11.7', depth: 6, side: 'ask' },
  { price: '25¢', shares: 6, usd: '$1.5', depth: 3, side: 'ask' },
]

const BID_ROWS: OrderRow[] = [
  { price: '19¢', shares: 5, usd: '$0.95', depth: 3, side: 'bid' },
  { price: '18¢', shares: 5, usd: '$0.89', depth: 3, side: 'bid' },
  { price: '17¢', shares: 120, usd: '$20.4', depth: 14, side: 'bid' },
  { price: '16¢', shares: 542.5, usd: '$86.8', depth: 40, side: 'bid' },
  { price: '15¢', shares: 28.8, usd: '$4.31', depth: 8, side: 'bid' },
  { price: '14¢', shares: 2000, usd: '$279.99', depth: 65, side: 'bid' },
  { price: '11¢', shares: 250, usd: '$27.5', depth: 20, side: 'bid' },
]

const OrderRow = ({ row }: { row: OrderRow }) => {
  const isAsk = row.side === 'ask'
  const barColor = isAsk ? 'rgba(237, 109, 88, 0.18)' : 'rgba(113, 216, 134, 0.18)'
  const priceColor = isAsk ? 'text-bearish-red' : 'text-bullish-green'

  return (
    <div className="relative flex items-center h-[26px] px-3 hover:bg-surface-hover/40 cursor-pointer group">
      {/* Depth bar */}
      <div
        className="absolute right-0 top-0 bottom-0"
        style={{ width: `${row.depth}%`, backgroundColor: barColor }}
      />
      <div className={`w-[56px] text-[13px] font-medium ${priceColor} z-10`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {row.price}
      </div>
      <div className="flex-1 text-[13px] text-text-secondary text-right z-10" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {row.shares.toLocaleString()}
      </div>
      <div className="w-[72px] text-[13px] text-text-secondary text-right z-10" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {row.usd}
      </div>
    </div>
  )
}

const OrderBook = () => {
  const [side, setSide] = useState<'long' | 'short'>('long')
  const askPct = 88
  const bidPct = 12

  return (
    <div className="flex flex-col bg-surface-primary h-full min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-subtle shrink-0">
        <span className="text-[13px] font-medium text-text-primary tracking-wide uppercase">Order Book</span>
        <div className="flex items-center gap-0">
          <button
            onClick={() => setSide('long')}
            className={`px-3 py-1 text-[13px] font-medium rounded-l-[5px] transition-colors ${
              side === 'long'
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            Long
          </button>
          <button
            onClick={() => setSide('short')}
            className={`px-3 py-1 text-[13px] font-medium rounded-r-[5px] transition-colors ${
              side === 'short'
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            Short
          </button>
        </div>
      </div>

      {/* Last traded + spread */}
      <div className="px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[13px] text-text-secondary">Last Traded</span>
          <span className="text-[13px] text-bearish-red" style={{ fontFamily: 'JetBrains Mono, monospace' }}>▼ 26¢</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-text-secondary">Spread</span>
          <span className="text-[13px] text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>6¢</span>
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center px-3 py-1.5 border-b border-border-subtle shrink-0">
        <div className="w-[56px] text-[12px] font-semibold text-text-tertiary">Price</div>
        <div className="flex-1 text-[12px] font-semibold text-text-tertiary text-right">Shares</div>
        <div className="w-[72px] text-[12px] font-semibold text-text-tertiary text-right">USD</div>
      </div>

      {/* Ask rows */}
      <div className="flex flex-col overflow-auto flex-1">
        <div className="flex flex-col">
          {ASK_ROWS.map((row) => (
            <OrderRow key={row.price} row={row} />
          ))}
        </div>

        {/* Spread divider */}
        <div className="flex items-center justify-center py-1 border-y border-border-subtle my-0.5 bg-surface-primary/50">
          <span className="text-[12px] text-text-tertiary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>— 6¢ spread —</span>
        </div>

        {/* Bid rows */}
        <div className="flex flex-col">
          {BID_ROWS.map((row) => (
            <OrderRow key={row.price} row={row} />
          ))}
        </div>
      </div>

      {/* Ask/Bid bar */}
      <div className="px-3 py-2.5 border-t border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-text-secondary shrink-0">Ask {askPct}%</span>
          <div className="flex-1 h-1.5 rounded-full overflow-hidden flex">
            <div className="h-full bg-bearish-red" style={{ width: `${askPct}%` }} />
            <div className="h-full bg-bullish-green" style={{ width: `${bidPct}%` }} />
          </div>
          <span className="text-[12px] text-text-secondary shrink-0">{bidPct}% Bid</span>
        </div>
      </div>
    </div>
  )
}

export default OrderBook
