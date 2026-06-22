import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getPositions, getFlow } from '../../lib/cerida-api'

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

function formatTs(ms: number) {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function ColHeader({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-1.5 text-[9px] font-medium uppercase tracking-widest text-text-quaternary whitespace-nowrap">
      {children}
    </th>
  )
}

function Cell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`px-3 py-2 text-[11px] whitespace-nowrap ${className}`}>
      {children}
    </td>
  )
}

function PositionsTab({ filter }: { filter: 'open' | 'closed' }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['positions'],
    queryFn: () => getPositions(200),
    refetchInterval: 5_000,
  })

  if (isLoading) return <EmptyState message="Loading…" />
  if (error)    return <EmptyState message={`Error: ${(error as Error).message}`} />

  const rows = (data ?? []).filter(e => {
    if (filter === 'open')   return e.type === 'RangeMinted' || e.type === 'PositionOpened'
    if (filter === 'closed') return e.type === 'PositionRedeemed' || e.type === 'PositionClosed'
    return true
  })

  if (!rows.length) return <EmptyState message={`No ${filter} positions`} />

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full min-w-max">
        <thead className="sticky top-0 bg-surface-primary border-b border-border-subtle">
          <tr>
            <ColHeader>Type</ColHeader>
            <ColHeader>Oracle</ColHeader>
            <ColHeader>Strike</ColHeader>
            <ColHeader>Side</ColHeader>
            <ColHeader>Size</ColHeader>
            <ColHeader>Time</ColHeader>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const p = row.payload
            const oracle = typeof p.oracle_id === 'string'
              ? `${p.oracle_id.slice(0, 6)}…`
              : '—'
            const strike = typeof p.strike === 'number' ? `$${(p.strike / 1e9).toLocaleString()}` : '—'
            const side = typeof p.side === 'string' ? p.side.toUpperCase() : typeof p.direction === 'string' ? p.direction.toUpperCase() : '—'
            const size = typeof p.amount === 'number'
              ? `$${(p.amount / 1e6).toFixed(2)}`
              : typeof p.size === 'number'
              ? `$${(p.size / 1e6).toFixed(2)}`
              : '—'
            return (
              <tr key={i} className="border-b border-border-subtle/40 hover:bg-surface-card transition-colors">
                <Cell>
                  <span className="px-1.5 py-0.5 rounded-[4px] text-[9px] font-medium bg-surface-hover text-text-secondary">
                    {row.type}
                  </span>
                </Cell>
                <Cell className="text-text-tertiary font-mono">{oracle}</Cell>
                <Cell className="text-text-primary font-mono">{strike}</Cell>
                <Cell>
                  <span className={side === 'YES' || side === 'LONG' || side === 'BUY' ? 'text-bullish-green' : 'text-bearish-red'}>
                    {side}
                  </span>
                </Cell>
                <Cell className="text-text-primary font-mono">{size}</Cell>
                <Cell className="text-text-quaternary">{formatTs(row.ts)}</Cell>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FlowTab({ label }: { label: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['flow'],
    queryFn: () => getFlow(100),
    refetchInterval: 5_000,
  })

  if (isLoading) return <EmptyState message="Loading…" />
  if (error)    return <EmptyState message={`Error: ${(error as Error).message}`} />
  if (!data?.length) return <EmptyState message={`No ${label.toLowerCase()}`} />

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full min-w-max">
        <thead className="sticky top-0 bg-surface-primary border-b border-border-subtle">
          <tr>
            <ColHeader>Event</ColHeader>
            <ColHeader>Oracle</ColHeader>
            <ColHeader>Details</ColHeader>
            <ColHeader>Time</ColHeader>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const p = row.payload
            const oracle = typeof p.oracle_id === 'string'
              ? `${p.oracle_id.slice(0, 6)}…`
              : '—'
            const details = Object.entries(p)
              .filter(([k]) => !['oracle_id', 'id'].includes(k))
              .slice(0, 2)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' · ')
            return (
              <tr key={i} className="border-b border-border-subtle/40 hover:bg-surface-card transition-colors">
                <Cell>
                  <span className="px-1.5 py-0.5 rounded-[4px] text-[9px] font-medium bg-surface-hover text-text-secondary">
                    {row.type}
                  </span>
                </Cell>
                <Cell className="text-text-tertiary font-mono">{oracle}</Cell>
                <Cell className="text-text-quaternary text-[10px] max-w-48 truncate">{details}</Cell>
                <Cell className="text-text-quaternary">{formatTs(row.ts)}</Cell>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const BottomTabs = () => {
  const [activeTab, setActiveTab] = useState<Tab>('positions')
  const [positionFilter, setPositionFilter] = useState<'open' | 'closed'>('open')
  const [combosOpen, setCombosOpen] = useState(false)

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

      {/* Content + combos arch */}
      <div className="relative flex-1 overflow-hidden min-h-0">
        {/* Regular tab content */}
        {activeTab === 'positions'   && <PositionsTab filter={positionFilter} />}
        {activeTab === 'open-orders' && <PositionsTab filter={positionFilter} />}
        {activeTab === 'history'     && <FlowTab label="Trade history" />}
        {activeTab === 'trades'      && <FlowTab label="Recent trades" />}

        {/* Combos triangle handle — always visible at the bottom */}
        <button
          onClick={() => setCombosOpen(o => !o)}
          className="absolute inset-x-0 bottom-0 flex items-start justify-center hover:opacity-90 transition-opacity"
          style={{ height: 52 }}
        >
          <svg
            viewBox="0 0 1000 52"
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full"
            style={{ display: 'block' }}
          >
            {/* Triangle with rounded peak */}
            <path d="M0,52 L455,10 Q500,1 545,10 L1000,52 Z" style={{ fill: 'var(--color-surface-primary)' }} />
            <path d="M0,52 L455,10 Q500,1 545,10 L1000,52" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
          </svg>
          <span className="relative text-[10px] font-medium tracking-widest uppercase mt-2 text-white">
            Combos
          </span>
        </button>

        {/* Combos panel — slides up over content */}
        <div
          className="absolute inset-0 flex flex-col bg-surface-primary"
          style={{
            transform: combosOpen ? 'translateY(0)' : 'translateY(100%)',
            transition: 'transform 0.22s ease',
          }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
            <span className="text-[11px] font-medium text-text-primary">Combos</span>
            <button
              onClick={() => setCombosOpen(false)}
              className="text-[10px] text-text-quaternary hover:text-text-secondary transition-colors"
            >
              Close
            </button>
          </div>
          <EmptyState message="No combo positions" />
        </div>
      </div>
    </div>
  )
}

export default BottomTabs
