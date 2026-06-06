import { useState } from 'react'

type Tab = 'positions' | 'open-orders' | 'history' | 'market-summary' | 'market-trades'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'positions', label: 'Positions' },
  { id: 'open-orders', label: 'Open Orders' },
  { id: 'history', label: 'History' },
  { id: 'market-summary', label: 'Market summary' },
  { id: 'market-trades', label: 'Market trades' },
]

const EmptyState = ({ message }: { message: string }) => (
  <div className="flex items-center justify-center flex-1 py-12">
    <span className="text-[14px] text-text-tertiary">{message}</span>
  </div>
)

const BottomTabs = () => {
  const [activeTab, setActiveTab] = useState<Tab>('positions')
  const [positionFilter, setPositionFilter] = useState<'open' | 'closed'>('open')

  return (
    <div className="flex flex-col border-t border-border-subtle bg-surface-primary shrink-0" style={{ minHeight: '120px' }}>
      {/* Tab bar */}
      <div className="flex items-center border-b border-border-subtle">
        <div className="flex items-center flex-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative px-4 py-3 text-[14px] font-medium whitespace-nowrap transition-colors shrink-0 ${
                activeTab === tab.id
                  ? 'text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-text-primary rounded-t-full" />
              )}
            </button>
          ))}
        </div>

        {/* Open / Closed filter (only for positions & orders) */}
        {(activeTab === 'positions' || activeTab === 'open-orders') && (
          <div className="flex items-center gap-1 pr-4 shrink-0">
            <button
              onClick={() => setPositionFilter('open')}
              className={`px-3 py-1 text-[13px] font-medium rounded-[5px] transition-colors ${
                positionFilter === 'open'
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              Open
            </button>
            <button
              onClick={() => setPositionFilter('closed')}
              className={`px-3 py-1 text-[13px] font-medium rounded-[5px] transition-colors ${
                positionFilter === 'closed'
                  ? 'bg-surface-hover text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              Closed
            </button>
          </div>
        )}
      </div>

      {/* Tab content */}
      {activeTab === 'positions' && <EmptyState message="No open positions" />}
      {activeTab === 'open-orders' && <EmptyState message="No open orders" />}
      {activeTab === 'history' && <EmptyState message="No trade history" />}
      {activeTab === 'market-summary' && (
        <div className="px-4 py-3 flex-1">
          <p className="text-[14px] text-text-secondary">Market summary will appear here.</p>
        </div>
      )}
      {activeTab === 'market-trades' && (
        <div className="px-4 py-3 flex-1">
          <p className="text-[14px] text-text-secondary">Recent market trades will appear here.</p>
        </div>
      )}
    </div>
  )
}

export default BottomTabs
