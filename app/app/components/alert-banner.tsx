const WarningIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
)

const AlertBanner = () => (
  <div className="flex items-center gap-2.5 px-4 py-2 text-[13px] text-text-secondary" style={{ backgroundColor: '#1e2d3d' }}>
    <WarningIcon />
    <span>
      Trading paused for Polymarket V2 migration. Close any open positions by April 27th — anything left open will be auto-closed at market price.
    </span>
  </div>
)

export default AlertBanner
