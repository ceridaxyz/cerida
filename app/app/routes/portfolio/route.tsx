import { useMemo, useState } from 'react'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconRefresh,
  IconUserCheck,
  IconWallet,
} from '@tabler/icons-react'
import { useCurrentAccount, useCurrentWallet } from '@mysten/dapp-kit'
import { useQuery } from '@tanstack/react-query'
import OnboardingModal from '../../components/onboarding-modal'
import { usePositions } from '../../lib/use-positions'
import { getActiveLadder } from '../../lib/cerida-api'

export const meta = () => [{ title: 'Portfolio - Cerida' }]

type PortfolioTab = 'positions' | 'orders' | 'combos' | 'history' | 'trades'
type TimeView = 'calendar' | 'chart'
type PnlMode = 'pnl' | 'volume'
type PositionStatus = 'all' | 'open' | 'settled'

const stats = [
  { label: 'Portfolio', value: '—', sub: '' },
  { label: 'Positions', value: '—', sub: '' },
  { label: 'Predict', value: '—', sub: 'BTC ladder' },
  { label: 'Vaults', value: '—', sub: '' },
  { label: 'Total PnL', value: '—', sub: '' },
  { label: 'Volume', value: '—', sub: '30d' },
]

const metrics = [
  { label: 'Realized PnL', value: '—' },
  { label: 'Unrealized PnL', value: '—' },
  { label: 'Open Positions', value: '—' },
  { label: 'At Risk', value: '—' },
  { label: 'Open Value', value: '—' },
  { label: 'Volume', value: '—' },
]

const pnlByDay: Record<number, number> = {}

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

function PortfolioPage() {
  const [tab, setTab] = useState<PortfolioTab>('positions')
  const [pnlMode, setPnlMode] = useState<PnlMode>('pnl')
  const [timeView, setTimeView] = useState<TimeView>('calendar')
  const [status, setStatus] = useState<PositionStatus>('open')
  const [showHistory, setShowHistory] = useState(false)

  const account = useCurrentAccount()
  const { currentWallet, isConnected } = useCurrentWallet()
  const [onboardingOpen, setOnboardingOpen] = useState(false)

  const { data: allPositions = [] } = usePositions()
  const { data: ladder } = useQuery({ queryKey: ['activeLadder'], queryFn: getActiveLadder, staleTime: 30_000 })
  const btcSpot = ladder?.find(m => m.asset === 'BTC')?.spot ?? null

  const filteredPositions = useMemo(() => {
    return allPositions.filter((p) => {
      if (!showHistory && p.status === 'settled') return false
      if (status !== 'all' && p.status !== status) return false
      return true
    })
  }, [allPositions, showHistory, status])

  if (!isConnected || !account) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center bg-page p-6 text-center">
        <div className="max-w-md border border-border-subtle bg-surface-primary rounded-card p-8 flex flex-col items-center shadow-xl">
          <div className="w-16 h-16 rounded-full bg-surface-card border border-brand-violet/40 flex items-center justify-center mb-6 text-brand-violet">
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
    <>
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
                  <div className="mt-8 text-[34px] font-bold text-text-primary">—</div>
                  <div className="mt-4 h-1 bg-surface-card">
                    <div className="h-full bg-bullish-green" style={{ width: '0%' }} />
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
                      <div className="text-[13px] font-bold text-text-quaternary">No trades yet</div>
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
                              'min-h-[58px] border-b border-r border-border-subtle p-2 text-center transition-all hover:bg-surface-hover relative overflow-hidden',
                              day === 18 && 'bg-surface-hover',
                            )}
                          >
                            <div className="text-[15px] font-semibold text-text-secondary">{day}</div>
                            {pnl !== undefined && (
                              <div className={cx('mt-1 text-[11px] font-bold', pnl >= 0 ? 'text-bullish-green' : 'text-bearish-red')}>
                                {pnl >= 0 ? '+' : '-'}${Math.abs(pnl)}
                              </div>
                            )}
                            {pnl !== undefined && (
                              <div className={cx(
                                'absolute top-0 left-0 right-0 h-[2px]',
                                pnl >= 0 ? 'bg-bullish-green/60' : 'bg-bearish-red/60'
                              )} />
                            )}
                          </button>
                        )
                      })}
                    </div>
                    <div className="mt-4 flex justify-center gap-5 text-[11px] text-text-quaternary">
                      <span className="flex items-center gap-1.5"><span className="inline-block h-1 w-3 bg-bearish-red/60 rounded-full" />Loss</span>
                      <span className="flex items-center gap-1.5"><span className="inline-block h-1 w-3 bg-bullish-green/60 rounded-full" />Profit</span>
                      <span className="flex items-center gap-1.5"><span className="inline-block h-1.5 w-1.5 rounded-full bg-bullish-green" />Best</span>
                    </div>
                  </div>
                ) : (
                  <EmptyState title="No data yet" body="P&L chart will appear once you have trade history." />
                )}
              </section>
            </div>
          </section>

          <section className="mt-5 border-t border-border-subtle">
            {/* Tab bar — raised Combos pill floats above the border line */}
            <div className="relative" style={{ height: 52 }}>
              {/* The bottom border line */}
              <div className="absolute bottom-0 left-0 right-0 border-b border-border-subtle" />

              {/* Flat tabs + raised Combos, all baseline-aligned to bottom */}
              <div className="absolute inset-0 flex items-end px-2">
                {/* Left tabs */}
                <TabButton value="positions" active={tab} onClick={setTab}>Positions</TabButton>
                <TabButton value="orders" active={tab} onClick={setTab}>Orders</TabButton>

                {/* Spacer + raised Combos */}
                <div className="flex flex-1 justify-center" style={{ paddingBottom: 0 }}>
                  <button
                    onClick={() => setTab('combos')}
                    className="relative flex items-center gap-2 px-6 py-2 text-[11px] font-bold uppercase tracking-widest transition-all"
                    style={{
                      background: tab === 'combos'
                        ? 'linear-gradient(145deg, #807dfe, #a855f7)'
                        : 'var(--color-surface-card)',
                      color: tab === 'combos' ? '#fff' : '#807dfe',
                      border: `1px solid ${tab === 'combos' ? 'rgba(128,125,254,0.6)' : 'rgba(128,125,254,0.35)'}`,
                      borderRadius: '20px 20px 0 0',
                      boxShadow: tab === 'combos'
                        ? '0 -6px 24px rgba(128,125,254,0.4), 0 0 0 1px rgba(128,125,254,0.2)'
                        : '0 -3px 12px rgba(0,0,0,0.25)',
                      marginBottom: -1,
                      paddingBottom: 10,
                      paddingTop: 10,
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{
                        background: tab === 'combos' ? 'rgba(255,255,255,0.85)' : '#807dfe',
                        boxShadow: tab === 'combos' ? '0 0 6px rgba(255,255,255,0.5)' : 'none',
                      }}
                    />
                    Combos
                  </button>
                </div>

                {/* Right tabs */}
                <TabButton value="history" active={tab} onClick={setTab}>History</TabButton>
                <TabButton value="trades" active={tab} onClick={setTab}>Trades</TabButton>
              </div>
            </div>

            {tab === 'positions' && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-2 py-0">
                <div />
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
                </div>
              </div>
            )}

            {tab === 'positions' && (
              <div className="overflow-x-auto">
                {filteredPositions.length ? (
                  <table className="w-full min-w-[940px] border-collapse text-left">
                    <thead className="text-[11px] uppercase tracking-widest text-text-quaternary">
                      <tr className="border-b border-border-subtle">
                        <th className="px-4 py-3 font-semibold">Market</th>
                        <th className="px-4 py-3 font-semibold">Type</th>
                        <th className="px-4 py-3 font-semibold">Band</th>
                        <th className="px-4 py-3 font-semibold">Expiry</th>
                        <th className="px-4 py-3 font-semibold">Cost</th>
                        <th className="px-4 py-3 font-semibold">Range</th>
                        <th className="px-4 py-3 font-semibold">Mark</th>
                        <th className="px-4 py-3 font-semibold">PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPositions.map((p) => {
                        const bandLabel = ['BEAR', 'FLAT', 'BULL'][p.bandIdx] ?? `Band ${p.bandIdx}`
                        const expiryStr = p.expiry
                          ? new Date(p.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                          : '—'
                        const rangeStr = p.lower != null && p.upper != null
                          ? `$${p.lower.toLocaleString(undefined, { maximumFractionDigits: 0 })} – $${p.upper.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                          : '—'

                        let markEl: React.ReactNode = <span className="text-text-quaternary">—</span>
                        let pnlEl: React.ReactNode = <span className="text-text-quaternary">—</span>

                        if (p.status === 'settled' && p.settlementPrice != null) {
                          const won = p.lower != null && p.upper != null
                            && p.settlementPrice >= p.lower && p.settlementPrice < p.upper
                          markEl = <span className={won ? 'text-bullish-green font-semibold' : 'text-text-quaternary'}>
                            ${p.settlementPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </span>
                          const pnl = won ? p.payout - p.basis : -p.basis
                          pnlEl = <span className={won ? 'text-bullish-green font-bold' : 'text-bearish-red font-bold'}>
                            {won ? '+' : ''}${pnl.toFixed(2)}
                          </span>
                        } else if (p.status === 'open' && btcSpot != null && p.lower != null && p.upper != null) {
                          const inBand = btcSpot >= p.lower && btcSpot < p.upper
                          markEl = <span className={inBand ? 'text-bullish-green font-semibold' : 'text-text-tertiary'}>
                            {inBand ? 'In' : 'Out'}
                          </span>
                        }

                        return (
                          <tr key={p.objectId} className="border-b border-border-subtle hover:bg-surface-card/40">
                            <td className="px-4 py-4 text-[13px] font-semibold text-text-primary">BTC/USD</td>
                            <td className="px-4 py-4 text-text-tertiary">Grid</td>
                            <td className="px-4 py-4 text-text-primary">{bandLabel}</td>
                            <td className="px-4 py-4 text-text-tertiary" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{expiryStr}</td>
                            <td className="px-4 py-4 text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>${p.basis.toFixed(2)}</td>
                            <td className="px-4 py-4 text-text-tertiary" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{rangeStr}</td>
                            <td className="px-4 py-4">{markEl}</td>
                            <td className="px-4 py-4">{pnlEl}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="No open positions" body="Place a grid bet on the Grid page to see positions here." />
                )}
              </div>
            )}

            {tab === 'orders' && (
              <EmptyState title="No open orders" body="Pending keeper orders and limit entries will appear here." />
            )}

            {tab === 'combos' && (
              <EmptyState title="No combo positions" body="Multi-leg grid positions will appear here after your first order." />
            )}

            {tab === 'history' && (
              <EmptyState title="No history" body="Completed trades and payouts will appear here." />
            )}

            {tab === 'trades' && (
              <EmptyState title="No trade analytics" body="Statistics will populate once you have trade history." />
            )}
          </section>
        </div>
      </main>
      <OnboardingModal open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
    </>
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
