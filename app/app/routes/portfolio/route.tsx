import { useMemo, useState, useEffect } from 'react'
import {
  IconArrowsSort,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconUserCheck,
  IconWallet,
} from '@tabler/icons-react'
import { useCurrentAccount, useCurrentWallet } from '@mysten/dapp-kit'
import OnboardingModal from '../../components/onboarding-modal'
import { toast } from '../../components/toast/toast-context'

export const meta = () => [{ title: 'Portfolio - Cerida' }]

type PortfolioTab = 'positions' | 'activity' | 'copy' | 'analytics'
type TimeView = 'calendar' | 'chart'
type PnlMode = 'pnl' | 'volume'
type PositionStatus = 'all' | 'open' | 'settled'
type Category = 'all' | 'binary' | 'range' | 'leverage'

const stats = [
  { label: 'Portfolio', value: '$12,480.42', sub: '+2.84%' },
  { label: 'Positions', value: '$4,918.10', sub: '7 live' },
  { label: 'Predict', value: '$8,146.00', sub: 'BTC ladder' },
  { label: 'Vaults', value: '$3,402.12', sub: '2 active' },
  { label: 'Total PnL', value: '+$628.40', sub: '+5.31%' },
  { label: 'Volume', value: '$48,910', sub: '30d' },
]

const metrics = [
  { label: 'Realized PnL', value: '+$314.82' },
  { label: 'Unrealized PnL', value: '+$313.58' },
  { label: 'Open Positions', value: '7' },
  { label: 'At Risk', value: '$2,418.00' },
  { label: 'Open Value', value: '$4,918.10' },
  { label: 'Volume', value: '$48,910' },
]

const positions = [
  {
    id: 'pos-1',
    market: 'BTC closes above 64,500',
    type: 'Binary',
    side: 'YES',
    expiry: 'Today 02:00 UTC',
    size: '$1,240',
    entry: '0.48',
    mark: '0.57',
    pnl: '+$232.40',
    status: 'open',
    category: 'binary',
  },
  {
    id: 'pos-2',
    market: 'BTC 64,000 - 65,000 range',
    type: 'Range',
    side: 'IN',
    expiry: 'Jun 18 08:00 UTC',
    size: '$860',
    entry: '0.31',
    mark: '0.28',
    pnl: '-$81.20',
    status: 'open',
    category: 'range',
  },
  {
    id: 'pos-3',
    market: 'BTC upside leverage window',
    type: 'Leverage',
    side: '3.0x LONG',
    expiry: 'Jun 20 00:00 UTC',
    size: '$2,818',
    entry: '64,112',
    mark: '64,454',
    pnl: '+$162.38',
    status: 'open',
    category: 'leverage',
  },
  {
    id: 'pos-4',
    market: 'BTC closes below 62,000',
    type: 'Binary',
    side: 'NO',
    expiry: 'Jun 17 00:00 UTC',
    size: '$700',
    entry: '0.64',
    mark: '1.00',
    pnl: '+$252.00',
    status: 'settled',
    category: 'binary',
  },
] as const

const activity = [
  { event: 'Mint executed', market: 'BTC closes above 64,500', value: '$1,240', time: '2m ago' },
  { event: 'Keeper fill', market: 'BTC upside leverage window', value: '$2,818', time: '14m ago' },
  { event: 'Range bet requested', market: 'BTC 64,000 - 65,000 range', value: '$860', time: '38m ago' },
  { event: 'Payout claimed', market: 'BTC closes below 62,000', value: '$952', time: '1d ago' },
]

const pnlByDay: Record<number, number> = {
  2: 86,
  4: -42,
  8: 114,
  11: 72,
  13: -19,
  16: 148,
  18: 0,
  21: 64,
  23: -33,
  26: 219,
  29: 51,
}

const copyLeaders = [
  { name: 'svi-carry', mode: 'Vol ladder', followers: 184, thirtyDay: '+9.4%', risk: 'Medium' },
  { name: 'gamma-flat', mode: 'Window spreads', followers: 91, thirtyDay: '+4.1%', risk: 'Low' },
  { name: 'btc-snap', mode: 'Short expiry', followers: 327, thirtyDay: '+14.8%', risk: 'High' },
]

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

function copyText(value: string) {
  void navigator.clipboard?.writeText(value)
}

function TabButton<T extends string>({
  value,
  active,
  onClick,
  children,
}: {
  value: T
  active: T
  onClick: (value: T) => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={() => onClick(value)}
      className={cx(
        'h-9 px-3 text-[11px] font-semibold uppercase tracking-widest border-b transition-colors',
        active === value
          ? 'border-text-primary text-text-primary'
          : 'border-transparent text-text-quaternary hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  )
}

const Toggle = ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
  <button
    onClick={onChange}
    className={cx(
      'h-5 w-9 rounded-pill border transition-colors p-0.5',
      checked ? 'border-bullish-green bg-bullish-green/20' : 'border-border-default bg-surface-card',
    )}
    aria-pressed={checked}
  >
    <span
      className={cx(
        'block h-3.5 w-3.5 rounded-pill transition-transform',
        checked ? 'translate-x-4 bg-bullish-green' : 'translate-x-0 bg-text-quaternary',
      )}
    />
  </button>
)

function PortfolioPage() {
  const [tab, setTab] = useState<PortfolioTab>('positions')
  const [pnlMode, setPnlMode] = useState<PnlMode>('pnl')
  const [timeView, setTimeView] = useState<TimeView>('calendar')
  const [status, setStatus] = useState<PositionStatus>('open')
  const [category, setCategory] = useState<Category>('all')
  const [search, setSearch] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [copyEnabled, setCopyEnabled] = useState(true)
  const [riskLimit, setRiskLimit] = useState('12')

  const account = useCurrentAccount()
  const { currentWallet, isConnected } = useCurrentWallet()
  const [onboardingOpen, setOnboardingOpen] = useState(false)

  const filteredPositions = useMemo(() => {
    return positions.filter((position) => {
      if (!showHistory && position.status === 'settled') return false
      if (status !== 'all' && position.status !== status) return false
      if (category !== 'all' && position.category !== category) return false
      if (search && !position.market.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [category, search, showHistory, status])

  if (!isConnected || !account) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center bg-page p-6 text-center">
        <div className="max-w-md border border-border-subtle bg-surface-primary rounded-card p-8 flex flex-col items-center shadow-xl">
          <div className="w-16 h-16 rounded-full bg-brand-violet/10 flex items-center justify-center mb-6 text-brand-violet">
            <IconWallet size={32} stroke={1.5} />
          </div>
          
          <h2 className="text-[20px] font-bold text-text-primary tracking-tight">Connect your wallet</h2>
          <p className="mt-2.5 text-[12px] text-text-tertiary leading-5 max-w-sm">
            Please connect your Sui wallet to view your portfolio, tracking performance, copy trading, and positions.
          </p>

          <button
            onClick={() => setOnboardingOpen(true)}
            className="mt-6 flex h-10 px-6 items-center justify-center gap-2 rounded-button text-[13px] font-semibold text-white bg-brand-violet hover:opacity-90 transition-opacity cursor-pointer animate-pulse w-full"
          >
            <IconWallet size={15} stroke={1.8} />
            Connect Wallet
          </button>
        </div>

        <OnboardingModal open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
      </main>
    )
  }

  return (
    <main className="flex-1 overflow-auto min-w-0">
      <div className="mx-auto max-w-[1840px] px-5 py-5">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h1 className="text-[22px] font-bold text-text-primary">Portfolio</h1>
              <p className="mt-1 text-[12px] text-text-quaternary">Account performance, copy settings, and open Cerida risk.</p>
            </div>
            <div className="flex items-center gap-2">
              <button className="flex h-8 items-center gap-2 rounded-[6px] border border-border-subtle bg-surface-primary px-3 text-[11px] uppercase tracking-widest text-text-secondary hover:text-text-primary">
                <IconRefresh size={14} stroke={1.8} />
                Sync
              </button>
              <button className="flex h-8 items-center gap-2 rounded-[6px] border border-border-subtle bg-surface-primary px-3 text-[11px] uppercase tracking-widest text-text-secondary hover:text-text-primary">
                <IconDownload size={14} stroke={1.8} />
                Export
              </button>
            </div>
          </div>

          {/* Toast Testing Console */}
          <div className="mb-6 p-4 border border-border-subtle bg-surface-primary rounded-card">
            <h3 className="text-[12px] font-bold text-text-primary uppercase tracking-wider mb-3">Toast Testing Console</h3>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => toast.success("Action completed successfully", "Your recent changes have been synchronized with the cloud. You can now view the updated history in your activity log.", {
                  action: { label: "VIEW", onClick: () => alert("View clicked!") }
                })}
                className="h-8 px-3 rounded-[6px] border border-bullish-green/30 bg-bullish-green/5 text-[11px] font-bold text-[#00e676] hover:bg-bullish-green/10 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Trigger Success
              </button>
              <button
                onClick={() => toast.info("New update available", "A newer version of this dataset has been detected on the server. Please refresh the page to sync with the latest version.", {
                  action: { label: "REFRESH", onClick: () => alert("Refresh clicked!") }
                })}
                className="h-8 px-3 rounded-[6px] border border-[#2196f3]/30 bg-[#2196f3]/5 text-[11px] font-bold text-[#2196f3] hover:bg-[#2196f3]/10 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Trigger Info
              </button>
              <button
                onClick={() => toast.warning("Connection is unstable", "We are having trouble reaching the primary database. Any unsaved progress may be lost if you close this browser tab.", {
                  action: { label: "RETRY", onClick: () => alert("Retry clicked!") }
                })}
                className="h-8 px-3 rounded-[6px] border border-[#ff9800]/30 bg-[#ff9800]/5 text-[11px] font-bold text-[#ff9800] hover:bg-[#ff9800]/10 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Trigger Warning
              </button>
              <button
                onClick={() => toast.error("Unable to save changes", "An unexpected error occurred during the data transfer. Please check your network and try performing the action again.", {
                  action: { label: "REPORT", onClick: () => alert("Report clicked!") }
                })}
                className="h-8 px-3 rounded-[6px] border border-[#ff5252]/30 bg-[#ff5252]/5 text-[11px] font-bold text-[#ff5252] hover:bg-[#ff5252]/10 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Trigger Error
              </button>
              <button
                onClick={() => {
                  let progress = 0;
                  const id = toast.progress("Generating technical data", progress, undefined, {
                    action: { label: "CANCEL", onClick: () => { clearInterval(interval); alert("Cancelled!"); } }
                  });
                  const interval = setInterval(() => {
                    progress += 10;
                    if (progress > 100) {
                      clearInterval(interval);
                      toast.update(id, { type: 'success', title: 'Data generated successfully', duration: 4000, progress: undefined, action: undefined });
                    } else {
                      toast.update(id, { progress });
                    }
                  }, 600);
                }}
                className="h-8 px-3 rounded-[6px] border border-[#ffca28]/30 bg-[#ffca28]/5 text-[11px] font-bold text-[#ffca28] hover:bg-[#ffca28]/10 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Trigger Progress
              </button>
            </div>
          </div>

          <section className="border border-border-subtle bg-surface-primary">
            <div className="grid grid-cols-[150px_repeat(6,minmax(120px,1fr))_160px] max-[1180px]:grid-cols-2">
              <div className="flex min-h-[74px] items-center gap-2 border-b border-r border-border-subtle px-4 max-[1180px]:col-span-2">
                <div>
                  <div className="text-[14px] font-bold text-text-primary">
                    {currentWallet?.name ?? 'Connected'}
                  </div>
                  <button
                    onClick={() => copyText(account.address)}
                    className="mt-1 flex items-center gap-1 text-[10px] uppercase tracking-widest text-text-quaternary hover:text-text-secondary"
                  >
                    {`${account.address.slice(0, 6)}...${account.address.slice(-4)}`}
                    <IconCopy size={12} stroke={1.8} />
                  </button>
                </div>
              </div>

              {stats.map((stat) => (
                <div key={stat.label} className="min-h-[74px] border-b border-r border-border-subtle px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">{stat.label}</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className={cx('text-[18px] font-bold', stat.value.startsWith('+') ? 'text-bullish-green' : 'text-text-primary')}>
                      {stat.value}
                    </span>
                    <span className="text-[11px] text-text-quaternary">{stat.sub}</span>
                  </div>
                </div>
              ))}

              <div className="flex min-h-[74px] items-center justify-end gap-2 border-b border-border-subtle px-4">
                <button className="flex h-8 items-center gap-2 rounded-[6px] border border-border-subtle px-3 text-[11px] uppercase tracking-widest text-text-secondary hover:text-text-primary">
                  All
                  <IconChevronDown size={14} stroke={1.8} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-[460px_minmax(0,1fr)] max-[980px]:grid-cols-1">
              <aside className="border-r border-border-subtle max-[980px]:border-r-0">
                <div className="border-b border-border-subtle px-4 py-4">
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">Win rate</div>
                  <div className="mt-8 text-[34px] font-bold text-text-primary">67.2%</div>
                  <div className="mt-4 h-1 bg-surface-card">
                    <div className="h-full bg-bullish-green" style={{ width: '67.2%' }} />
                  </div>
                  <div className="mt-2 flex justify-between text-[11px] text-text-quaternary">
                    <span>0%</span>
                    <span>50%</span>
                    <span>100%</span>
                  </div>
                </div>

                <div className="border-b border-border-subtle px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">Metrics</div>
                </div>

                <div className="grid grid-cols-2">
                  {metrics.map((metric) => (
                    <div key={metric.label} className="min-h-[94px] border-b border-r border-border-subtle px-4 py-4 even:border-r-0">
                      <div className="text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">{metric.label}</div>
                      <div className={cx('mt-3 text-[20px] font-bold', metric.value.startsWith('+') ? 'text-bullish-green' : 'text-text-primary')}>
                        {metric.value}
                      </div>
                    </div>
                  ))}
                </div>
              </aside>

              <section className="min-w-0">
                <div className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
                  <div className="flex items-center gap-2">
                    <TabButton value="pnl" active={pnlMode} onClick={setPnlMode}>PnL</TabButton>
                    <TabButton value="volume" active={pnlMode} onClick={setPnlMode}>Volume</TabButton>
                  </div>
                  <div className="flex items-center gap-2">
                    <TabButton value="calendar" active={timeView} onClick={setTimeView}>Calendar</TabButton>
                    <TabButton value="chart" active={timeView} onClick={setTimeView}>Chart</TabButton>
                  </div>
                </div>

                {timeView === 'calendar' ? (
                  <div className="p-4">
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <button className="text-text-quaternary hover:text-text-primary"><IconChevronLeft size={18} stroke={1.8} /></button>
                        <div className="text-[18px] font-bold text-text-primary">Jun 2026</div>
                        <button className="text-text-quaternary hover:text-text-primary"><IconChevronRight size={18} stroke={1.8} /></button>
                      </div>
                      <div className="text-[13px] font-bold text-bullish-green">
                        +$628 <span className="ml-2 text-text-quaternary">18W / 7L</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-7 text-center text-[12px] text-text-quaternary">
                      {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) => (
                        <div key={`${day}-${i}`} className="py-2">{day}</div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 border-l border-t border-border-subtle">
                      {Array.from({ length: 30 }).map((_, i) => {
                        const day = i + 1
                        const pnl = pnlByDay[day]
                        return (
                          <button
                            key={day}
                            className={cx(
                              'min-h-[58px] border-b border-r border-border-subtle p-2 text-center transition-colors hover:bg-surface-card',
                              pnl && pnl > 0 && 'bg-bullish-green/10',
                              pnl && pnl < 0 && 'bg-bearish-red/10',
                              day === 18 && 'bg-surface-hover',
                            )}
                          >
                            <div className="text-[15px] font-semibold text-text-secondary">{day}</div>
                            {pnl !== undefined && (
                              <div className={cx('mt-1 text-[11px]', pnl >= 0 ? 'text-bullish-green' : 'text-bearish-red')}>
                                {pnl >= 0 ? '+' : '-'}${Math.abs(pnl)}
                              </div>
                            )}
                          </button>
                        )
                      })}
                    </div>
                    <div className="mt-4 flex justify-center gap-5 text-[11px] text-text-quaternary">
                      <span><span className="mr-2 inline-block h-2 w-2 bg-bearish-red/30" />Loss</span>
                      <span><span className="mr-2 inline-block h-2 w-2 bg-bullish-green/30" />Profit</span>
                      <span><span className="mr-2 inline-block h-2 w-2 bg-bullish-green" />Best</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-[390px] items-end gap-2 p-6">
                    {Array.from({ length: 24 }).map((_, i) => {
                      const value = Math.sin(i / 2) * 42 + i * 5 + 30
                      return (
                        <div key={i} className="flex flex-1 flex-col justify-end gap-2">
                          <div
                            className="border border-bullish-green/30 bg-bullish-green/20"
                            style={{ height: `${Math.max(14, value)}px` }}
                          />
                          <div className="text-center text-[9px] text-text-quaternary">{i % 4 === 0 ? i + 1 : ''}</div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          </section>

          <section className="mt-5 border-t border-border-subtle">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-2">
              <div className="flex items-center gap-1 overflow-x-auto">
                <TabButton value="positions" active={tab} onClick={setTab}>Positions</TabButton>
                <TabButton value="activity" active={tab} onClick={setTab}>Activity</TabButton>
                <TabButton value="copy" active={tab} onClick={setTab}>Copy Trading</TabButton>
                <TabButton value="analytics" active={tab} onClick={setTab}>Advanced Analytics</TabButton>
              </div>

              <div className="flex flex-wrap items-center gap-2 py-2">
                <button
                  onClick={() => setShowHistory((prev) => !prev)}
                  className="h-8 px-3 text-[11px] font-semibold uppercase tracking-widest text-text-secondary hover:text-text-primary"
                >
                  {showHistory ? 'Hide history' : 'Show history'}
                </button>
                <select value={status} onChange={(e) => setStatus(e.target.value as PositionStatus)} className="h-8 border border-border-subtle bg-page px-3 text-[11px] uppercase tracking-widest text-text-secondary">
                  <option value="all">Status</option>
                  <option value="open">Open</option>
                  <option value="settled">Settled</option>
                </select>
                <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className="h-8 border border-border-subtle bg-page px-3 text-[11px] uppercase tracking-widest text-text-secondary">
                  <option value="all">Category</option>
                  <option value="binary">Binary</option>
                  <option value="range">Range</option>
                  <option value="leverage">Leverage</option>
                </select>
                <label className="flex h-8 items-center gap-2 border border-border-subtle px-3 text-text-quaternary">
                  <IconSearch size={14} stroke={1.8} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search markets..."
                    className="w-48 bg-transparent text-[12px] text-text-primary placeholder:text-text-quaternary"
                  />
                </label>
              </div>
            </div>

            {tab === 'positions' && (
              <div className="overflow-x-auto">
                {filteredPositions.length ? (
                  <table className="w-full min-w-[940px] border-collapse text-left">
                    <thead className="text-[11px] uppercase tracking-widest text-text-quaternary">
                      <tr className="border-b border-border-subtle">
                        <th className="px-4 py-3 font-semibold">Market</th>
                        <th className="px-4 py-3 font-semibold">Type</th>
                        <th className="px-4 py-3 font-semibold">Side</th>
                        <th className="px-4 py-3 font-semibold">Expiry</th>
                        <th className="px-4 py-3 font-semibold">Size</th>
                        <th className="px-4 py-3 font-semibold">Entry</th>
                        <th className="px-4 py-3 font-semibold">Mark</th>
                        <th className="px-4 py-3 font-semibold">PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPositions.map((position) => (
                        <tr key={position.id} className="border-b border-border-subtle hover:bg-surface-primary">
                          <td className="px-4 py-4 text-[13px] font-semibold text-text-primary">{position.market}</td>
                          <td className="px-4 py-4 text-text-tertiary">{position.type}</td>
                          <td className="px-4 py-4 text-text-primary">{position.side}</td>
                          <td className="px-4 py-4 text-text-tertiary">{position.expiry}</td>
                          <td className="px-4 py-4 text-text-primary">{position.size}</td>
                          <td className="px-4 py-4 text-text-tertiary">{position.entry}</td>
                          <td className="px-4 py-4 text-text-tertiary">{position.mark}</td>
                          <td className={cx('px-4 py-4 font-bold', position.pnl.startsWith('+') ? 'text-bullish-green' : 'text-bearish-red')}>{position.pnl}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="No open positions" body="Place a trade or loosen the filters to see account exposure." />
                )}
              </div>
            )}

            {tab === 'activity' && (
              <div className="grid divide-y divide-border-subtle">
                {activity.map((item) => (
                  <div key={`${item.event}-${item.time}`} className="grid grid-cols-[180px_minmax(0,1fr)_120px_100px] gap-4 px-4 py-4 max-[780px]:grid-cols-1">
                    <div className="font-semibold text-text-primary">{item.event}</div>
                    <div className="text-text-tertiary">{item.market}</div>
                    <div className="text-text-primary">{item.value}</div>
                    <div className="text-text-quaternary">{item.time}</div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'copy' && (
              <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-4 p-4 max-[980px]:grid-cols-1">
                <div className="grid gap-3">
                  {copyLeaders.map((leader) => (
                    <button key={leader.name} className="grid grid-cols-[minmax(0,1fr)_100px_90px_90px] items-center gap-4 border border-border-subtle bg-surface-primary px-4 py-4 text-left hover:border-border-default max-[780px]:grid-cols-1">
                      <div>
                        <div className="font-bold text-text-primary">{leader.name}</div>
                        <div className="mt-1 text-[11px] uppercase tracking-widest text-text-quaternary">{leader.mode}</div>
                      </div>
                      <div className="text-text-tertiary">{leader.followers} followers</div>
                      <div className="font-bold text-bullish-green">{leader.thirtyDay}</div>
                      <div className="text-text-tertiary">{leader.risk}</div>
                    </button>
                  ))}
                </div>
                <div className="border border-border-subtle bg-surface-primary p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[13px] font-bold text-text-primary">Copy guardrails</div>
                      <div className="mt-1 text-[11px] text-text-quaternary">Policy enforced before keeper execution.</div>
                    </div>
                    <Toggle checked={copyEnabled} onChange={() => setCopyEnabled((prev) => !prev)} />
                  </div>
                  <label className="mt-5 block text-[11px] uppercase tracking-widest text-text-quaternary">
                    Max account risk
                    <input
                      value={riskLimit}
                      onChange={(e) => setRiskLimit(e.target.value)}
                      className="mt-2 h-9 w-full border border-border-subtle bg-page px-3 text-[13px] text-text-primary"
                    />
                  </label>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] text-text-tertiary">
                    <div className="border border-border-subtle p-3">Per trade cap<br /><span className="text-text-primary">$500</span></div>
                    <div className="border border-border-subtle p-3">Leverage cap<br /><span className="text-text-primary">3.0x</span></div>
                    <div className="border border-border-subtle p-3">Allowed market<br /><span className="text-text-primary">BTC</span></div>
                    <div className="border border-border-subtle p-3">Slippage<br /><span className="text-text-primary">1.2%</span></div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'analytics' && (
              <div className="grid grid-cols-4 gap-px bg-border-subtle max-[980px]:grid-cols-2 max-[620px]:grid-cols-1">
                {[
                  ['Sharpe proxy', '1.84', 'PnL volatility normalized'],
                  ['Win streak', '6', 'Best current run'],
                  ['Keeper latency', '840ms', 'Median local dry-run'],
                  ['Gamma exposure', '+$18.4k', 'Synthetic surface estimate'],
                ].map(([title, value, body]) => (
                  <div key={title} className="bg-page p-5">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-text-quaternary">
                      <IconArrowsSort size={14} stroke={1.8} />
                      {title}
                    </div>
                    <div className="mt-5 text-[26px] font-bold text-text-primary">{value}</div>
                    <div className="mt-2 text-[12px] text-text-quaternary">{body}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
      <OnboardingModal open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
    )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
      <IconUserCheck size={28} stroke={1.6} className="mb-4 text-text-quaternary" />
      <div className="text-[16px] font-bold text-text-tertiary">{title}</div>
      <div className="mt-2 text-[12px] text-text-quaternary">{body}</div>
    </div>
  )
}

export default PortfolioPage
