import { Link } from 'react-router'

const ExternalLinkIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

const ShareIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
)

const BookmarkIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
)

const ChevronDownIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
      <div className="flex items-center gap-2 px-3 py-2">
        {icon && (
          <div className="w-7 h-7 rounded-[6px] bg-surface-card border border-border-subtle flex items-center justify-center shrink-0 text-sm">
            {icon}
          </div>
        )}
        <h1 className="text-[15px] font-medium text-text-primary flex-1 min-w-0 truncate leading-tight">
          {title}
        </h1>
        <button className="p-1 text-text-tertiary hover:text-text-secondary transition-colors shrink-0">
          <ChevronDownIcon />
        </button>
        <div className="flex items-center gap-0 ml-1">
          {[ExternalLinkIcon, ShareIcon, BookmarkIcon].map((Icon, i) => (
            <button key={i} className="p-1.5 text-text-tertiary hover:text-text-secondary rounded-[4px] hover:bg-surface-hover transition-colors">
              <Icon />
            </button>
          ))}
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-start gap-5 px-3 pb-2 overflow-x-auto">
        <div className="shrink-0">
          <p className="text-[11px] text-text-tertiary mb-0.5">Price</p>
          <p className="text-[14px] font-medium text-text-primary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{price}</p>
        </div>
        <div className="shrink-0">
          <p className="text-[11px] text-text-tertiary mb-0.5">24 hour change</p>
          <p className={`text-[14px] font-medium ${isPositive ? 'text-bullish-green' : 'text-bearish-red'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{change}</p>
        </div>
        <div className="shrink-0">
          <p className="text-[11px] text-text-tertiary mb-0.5">Open Interest</p>
          <p className="text-[14px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{openInterest}</p>
        </div>
        <div className="shrink-0">
          <p className="text-[11px] text-text-tertiary mb-0.5">Capacity left</p>
          <p className="text-[14px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{capacityLeft}</p>
        </div>
        <div className="shrink-0">
          <p className="text-[11px] text-text-tertiary mb-0.5">Volume</p>
          <p className="text-[14px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{volume}</p>
        </div>
        <div className="shrink-0">
          <p className="text-[11px] text-text-tertiary mb-0.5">Liquidity</p>
          <p className="text-[14px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{liquidity}</p>
        </div>
        <div className="shrink-0">
          <p className="text-[11px] text-text-tertiary mb-0.5">Auto-close</p>
          <p className="text-[14px] font-medium text-text-secondary" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{autoClose}</p>
        </div>
      </div>

      {/* Related markets */}
      {relatedMarkets.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 pb-2 overflow-x-auto">
          {relatedMarkets.map((m) => (
            <Link
              key={m.name}
              to={`/markets/${m.name.toLowerCase().replace(/\s+/g, '-')}`}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-card border border-border-subtle rounded-full text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors shrink-0"
            >
              <span className="font-medium">{m.name}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{m.price}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default MarketHeader
