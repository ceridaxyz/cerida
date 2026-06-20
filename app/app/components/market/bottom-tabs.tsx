import { useState } from 'react'

type Tab = 'positions' | 'open-orders' | 'history' | 'trades'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'positions',   label: 'Positions' },
  { id: 'open-orders', label: 'Orders' },
  { id: 'history',     label: 'History' },
  { id: 'trades',      label: 'Trades' },
]

const EmptyState = ({ message }: { message: string }) => (
  <div className="flex items-center justify-center flex-1">
    <span className="text-[11px] text-text-quaternary">{message}</span>
  </div>
)

const BottomTabs = () => {
  const [activeTab, setActiveTab] = useState<Tab>('positions')
  const [positionFilter, setPositionFilter] = useState<'open' | 'closed'>('open')

  return (
    <div className="flex flex-col bg-surface-primary h-full rounded-b-[10px]">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border-subtle shrink-0">
        <div className="flex items-center flex-1 overflow-hidden">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative px-3 py-2 text-[11px] font-medium whitespace-nowrap transition-colors shrink-0 ${
                activeTab === tab.id
                  ? 'text-text-primary'
                  : 'text-text-quaternary hover:text-text-secondary'
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-text-primary rounded-t-full" />
              )}
            </button>
          ))}
        </div>

        {(activeTab === 'positions' || activeTab === 'open-orders') && (
          <div className="flex items-center gap-0.5 pr-3 shrink-0">
            {(['open', 'closed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setPositionFilter(f)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded-[4px] capitalize transition-colors ${
                  positionFilter === f
                    ? 'bg-surface-hover text-text-primary'
                    : 'text-text-quaternary hover:text-text-secondary'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      {activeTab === 'positions'   && <EmptyState message="No open positions" />}
      {activeTab === 'open-orders' && <EmptyState message="No open orders" />}
      {activeTab === 'history'     && <EmptyState message="No trade history" />}
      {activeTab === 'trades'      && <EmptyState message="No recent trades" />}
    </div>
  )
}

export default BottomTabs
