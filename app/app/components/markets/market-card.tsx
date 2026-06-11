import { Link } from 'react-router'

export interface Market {
  slug: string
  icon: string
  title: string
  price: string
  change: string
  isPositive: boolean
  volume: string
  liquidity: string
  autoClose: string
  longPct: number
}

const MarketCard = ({ market }: { market: Market }) => {
  return (
    <Link
      to="/trade"
      className="block bg-surface-card border border-border-default rounded-[12px] p-4 hover:bg-surface-hover transition-colors cursor-pointer"
      style={{ boxShadow: '0 1px 0 0 rgba(255,255,255,0.1) inset, 0 8px 32px rgba(0,0,0,0.6)' }}
    >
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-[8px] bg-surface-primary border border-border-default flex items-center justify-center shrink-0 text-lg overflow-hidden">
          {market.icon}
        </div>
        <p className="text-[15px] font-medium text-text-primary leading-snug flex-1 min-w-0 line-clamp-2">
          {market.title}
        </p>
      </div>

      {/* Price + change */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[18px] font-medium text-text-primary" style={{ fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.3px' }}>
          {market.price}
        </span>
        <span className={`text-[13px] font-medium ${market.isPositive ? 'text-bullish-green' : 'text-bearish-red'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {market.change}
        </span>
      </div>

      {/* Long/Short bar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 h-1.5 rounded-full overflow-hidden flex">
          <div className="h-full bg-bullish-green" style={{ width: `${market.longPct}%` }} />
          <div className="h-full bg-bearish-red" style={{ width: `${100 - market.longPct}%` }} />
        </div>
        <span className="text-[12px] text-text-tertiary shrink-0">{market.longPct}% Long</span>
      </div>

      {/* Footer stats */}
      <div className="flex items-center gap-4">
        <div>
          <p className="text-[11px] text-text-tertiary mb-0.5">Volume</p>
          <p className="text-[13px] text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{market.volume}</p>
        </div>
        <div>
          <p className="text-[11px] text-text-tertiary mb-0.5">Liquidity</p>
          <p className="text-[13px] text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{market.liquidity}</p>
        </div>
        <div className="ml-auto">
          <p className="text-[11px] text-text-tertiary mb-0.5">Auto-close</p>
          <p className="text-[13px] text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{market.autoClose}</p>
        </div>
      </div>
    </Link>
  )
}

export default MarketCard
