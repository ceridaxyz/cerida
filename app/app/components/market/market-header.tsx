import { Link } from 'react-router'

const ExternalLinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

const ShareIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
)

const BookmarkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
)

const ChevronDownIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

interface MarketHeaderProps {
  icon?: string
  title: string
  price: string
  change: string
  isPositive: boolean
  openInterest: string
  capacityLeft: string
  volume: string
  liquidity: string
  autoClose: string
  relatedMarkets?: Array<{ name: string; price: string }>
}

const MarketHeader = ({
  icon,
  title,
  price,
  change,
  isPositive,
  openInterest,
  capacityLeft,
  volume,
  liquidity,
  autoClose,
  relatedMarkets = [],
}: MarketHeaderProps) => {
  return (
    <div className="border-b border-border-subtle bg-surface-primary shrink-0">
      {/* Title row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Market icon */}
        {icon && (
          <div className="w-8 h-8 rounded-[8px] bg-surface-card border border-border-subtle flex items-center justify-center shrink-0 overflow-hidden">
            <span className="text-lg">{icon}</span>
          </div>
        )}

        <h1 className="text-[16px] font-medium text-text-primary flex-1 min-w-0 truncate" style={{ fontFamily: 'Barlow, sans-serif' }}>
          {title}
        </h1>

        <button className="p-1 text-text-tertiary hover:text-text-secondary rounded transition-colors">
          <ChevronDownIcon />
        </button>

        {/* Action icons */}
        <div className="flex items-center gap-0.5 ml-2">
          <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
            <ExternalLinkIcon />
          </button>
          <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
            <ShareIcon />
          </button>
          <button className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[5px] hover:bg-surface-hover transition-colors">
            <BookmarkIcon />
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-6 px-4 pb-3 overflow-x-auto">
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[12px] text-text-tertiary">Price</span>
          <span className="text-[15px] font-medium text-text-primary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {price}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[12px] text-text-tertiary">24 hour change</span>
          <span className={`text-[15px] font-medium ${isPositive ? 'text-bullish-green' : 'text-bearish-red'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {change}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[12px] text-text-tertiary">Open Interest</span>
          <span className="text-[15px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {openInterest}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[12px] text-text-tertiary">Capacity left</span>
          <span className="text-[15px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {capacityLeft}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[12px] text-text-tertiary">Volume</span>
          <span className="text-[15px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {volume}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[12px] text-text-tertiary">Liquidity</span>
          <span className="text-[15px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {liquidity}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <span className="text-[12px] text-text-tertiary">Auto-close</span>
          <span className="text-[15px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {autoClose}
          </span>
        </div>
      </div>

      {/* Related markets */}
      {relatedMarkets.length > 0 && (
        <div className="flex items-center gap-1 px-4 pb-3 overflow-x-auto">
          {relatedMarkets.map((market) => (
            <Link
              key={market.name}
              to={`/markets/${market.name.toLowerCase().replace(/\s+/g, '-')}`}
              className="flex items-center gap-1.5 px-3 py-1 bg-surface-card border border-border-subtle rounded-full text-[13px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors shrink-0"
            >
              <span className="font-medium">{market.name}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{market.price}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default MarketHeader
