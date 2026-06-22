import { useState, useRef, useEffect } from 'react'
import {
  useCurrentAccount,
  useDisconnectWallet,
} from '@mysten/dapp-kit'
import {
  IconSearch,
  IconStar,
  IconWorld,
  IconChevronDown,
  IconPlus,
  IconKeyboard,
  IconBell,
  IconUser,
  IconLogout,
  IconSettings,
  IconWallet,
  IconCopy,
  IconCheck,
  IconX,
  IconLock,
  IconChevronRight,
} from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import OnboardingModal from '../onboarding-modal'
import { getActiveLadder, type Market } from '../../lib/cerida-api'

// ── Asset catalogue (only BTC live; others disabled) ─────────────────────────
const ASSETS = [
  {
    id: 'btc', symbol: 'BTC', name: 'Bitcoin',
    price: '63,347.10', change: '+0.95%', positive: true,
    vol24h: '$93.2M', high24h: '64,842.0', low24h: '62,918.4',
    mcap: '$1.24T', oi: '$18.4B',
    icon: '₿', color: '#f7931a', enabled: true,
  },
  {
    id: 'eth', symbol: 'ETH', name: 'Ethereum',
    price: '3,412.50', change: '+1.24%', positive: true,
    vol24h: '$18.4M', high24h: '3,501.0', low24h: '3,380.2',
    mcap: '$412B', oi: '$6.2B',
    icon: 'Ξ', color: '#627eea', enabled: false,
  },
  {
    id: 'sol', symbol: 'SOL', name: 'Solana',
    price: '142.80', change: '-0.38%', positive: false,
    vol24h: '$4.2M', high24h: '148.20', low24h: '140.10',
    mcap: '$63B', oi: '$1.1B',
    icon: '◎', color: '#9945ff', enabled: false,
  },
  {
    id: 'avax', symbol: 'AVAX', name: 'Avalanche',
    price: '28.14', change: '+2.10%', positive: true,
    vol24h: '$890M', high24h: '29.40', low24h: '27.60',
    mcap: '$11.4B', oi: '$420M',
    icon: 'A', color: '#e84142', enabled: false,
  },
]

interface AddOption { type: string; label: string }
interface TopNavProps {
  addOptions?: AddOption[]
  onAddWidget?: (type: string) => void
  onComboOpen?: () => void
  comboActive?: boolean
}

const SearchIcon = () => <IconSearch size={15} stroke={2} />
const StarIcon = () => <IconStar size={15} stroke={1.75} />
const GlobeIcon = () => <IconWorld size={15} stroke={1.75} />
const ChevronDown = () => <IconChevronDown size={12} stroke={2} />
const PlusIcon = () => <IconPlus size={14} stroke={2.25} />
const KeyboardIcon = () => <IconKeyboard size={14} stroke={1.75} />
const BellIcon = () => <IconBell size={15} stroke={1.75} />

const Stat = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-[10px] font-medium text-text-quaternary uppercase tracking-widest">{label}</span>
    <span className="text-[13px] font-medium" style={{ fontFamily: 'var(--font-mono)' }}>{children}</span>
  </div>
)

const Island = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`flex items-center gap-1 rounded-[12px] bg-surface-primary border border-border-subtle px-1.5 py-1 ${className}`}>
    {children}
  </div>
)

// Onboarding session handles connection.

// ── Top nav ───────────────────────────────────────────────────────────────────

const TopNav = ({ addOptions = [], onAddWidget, onComboOpen, comboActive }: TopNavProps) => {
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)
  const [marketOpen, setMarketOpen] = useState(false)
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null)
  const [expandedAssets, setExpandedAssets] = useState<Set<string>>(new Set(['btc']))
  const [marketSearch, setMarketSearch] = useState('')

  const toggleAsset = (id: string) => {
    setExpandedAssets(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const { data: ladder } = useQuery({
    queryKey: ['activeLadder'],
    queryFn: getActiveLadder,
    staleTime: 30_000,
  })
  const activeMarket = selectedMarket ?? ladder?.[0] ?? null

  const account = useCurrentAccount()
  const { mutate: disconnect } = useDisconnectWallet()

  const shortAddr = account
    ? `${account.address.slice(0, 6)}…${account.address.slice(-4)}`
    : null

  const copyAddr = () => {
    if (!account) return
    navigator.clipboard.writeText(account.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleDisconnect = () => {
    disconnect()
    setProfileOpen(false)
  }

useEffect(() => {
    if (!addOpen) return
    const onDown = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [addOpen])

  useEffect(() => {
    if (!profileOpen) return
    const onDown = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [profileOpen])

  return (
    <>
      <div className="flex items-center gap-4 h-13 shrink-0 select-none">
        {/* Market selector */}
        <Island>
          <button className="text-text-tertiary hover:text-text-primary transition-colors px-1.5">
            <SearchIcon />
          </button>
          <div className="relative">
            <button
              onClick={() => setMarketOpen(o => !o)}
              className="flex items-center gap-2.5 hover:bg-surface-card rounded-[8px] px-2 py-1 transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-[#f7931a] flex items-center justify-center text-white text-[14px] font-bold shrink-0">
                ₿
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-semibold text-text-primary">
                  {activeMarket ? `${activeMarket.asset}/USD` : 'BTC/USD'}
                </span>
                {activeMarket && (
                  <span className="text-[10px] font-medium text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                    {new Date(activeMarket.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </div>
              <IconChevronDown size={12} stroke={2.5} className={`text-text-quaternary transition-transform ${marketOpen ? 'rotate-180' : ''}`} />
            </button>

            {marketOpen && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center"
                style={{ background: 'rgba(0,0,0,0.6)' }}
                onMouseDown={(e) => { if (e.target === e.currentTarget) setMarketOpen(false) }}
              >
                <div className="w-[680px] max-h-[78vh] rounded-[16px] bg-surface-primary border border-border-default flex flex-col overflow-hidden">

                  {/* ── Header / search ── */}
                  <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border-subtle shrink-0">
                    <IconSearch size={15} stroke={2} className="text-text-quaternary shrink-0" />
                    <input
                      autoFocus
                      value={marketSearch}
                      onChange={e => setMarketSearch(e.target.value)}
                      placeholder="Search markets…"
                      className="flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-quaternary outline-none"
                    />
                    <button onClick={() => setMarketOpen(false)} className="text-text-quaternary hover:text-text-primary transition-colors shrink-0">
                      <IconX size={15} stroke={2} />
                    </button>
                  </div>

                  {/* ── Column headers ── */}
                  <div className="grid grid-cols-[1fr_100px_100px_90px_80px] px-5 py-2 border-b border-border-subtle shrink-0">
                    {['Asset', 'Price', '24h Change', 'Volume', 'Mkt Cap'].map(h => (
                      <span key={h} className="text-[10px] font-medium text-text-quaternary uppercase tracking-widest">{h}</span>
                    ))}
                  </div>

                  {/* ── Asset rows ── */}
                  <div className="flex-1 overflow-y-auto">
                    {ASSETS.filter(a =>
                      !marketSearch ||
                      a.symbol.toLowerCase().includes(marketSearch.toLowerCase()) ||
                      a.name.toLowerCase().includes(marketSearch.toLowerCase())
                    ).map((asset) => {
                      const expanded = expandedAssets.has(asset.id)
                      const assetMarkets = (ladder ?? []).filter(m => m.asset === asset.symbol)

                      return (
                        <div key={asset.id} className="border-b border-border-subtle/50 last:border-0">

                          {/* Asset row */}
                          <button
                            onClick={() => asset.enabled && toggleAsset(asset.id)}
                            disabled={!asset.enabled}
                            className={`grid grid-cols-[1fr_100px_100px_90px_80px] items-center w-full px-5 py-3.5 text-left transition-colors ${
                              asset.enabled ? 'hover:bg-surface-card cursor-pointer' : 'cursor-default opacity-40'
                            }`}
                          >
                            {/* Name */}
                            <div className="flex items-center gap-3">
                              <div
                                className="w-8 h-8 rounded-full flex items-center justify-center text-[15px] font-bold text-white shrink-0"
                                style={{ background: asset.enabled ? asset.color : '#444' }}
                              >
                                {asset.icon}
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[13px] font-semibold text-text-primary">{asset.symbol}/USD</span>
                                  {!asset.enabled && (
                                    <span className="flex items-center gap-1 text-[9px] font-medium text-text-quaternary uppercase tracking-widest border border-border-subtle rounded-[4px] px-1.5 py-0.5">
                                      <IconLock size={8} stroke={2} />
                                      Soon
                                    </span>
                                  )}
                                </div>
                                <span className="text-[11px] text-text-quaternary">{asset.name}</span>
                              </div>
                              {asset.enabled && (
                                <IconChevronDown
                                  size={13} stroke={2}
                                  className={`ml-1 text-text-quaternary transition-transform ${expanded ? 'rotate-180' : ''}`}
                                />
                              )}
                            </div>
                            {/* Price */}
                            <span className="text-[13px] font-medium text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                              ${asset.price}
                            </span>
                            {/* Change */}
                            <span className={`text-[12px] font-semibold ${asset.positive ? 'text-bullish-green' : 'text-bearish-red'}`}
                              style={{ fontFamily: 'var(--font-mono)' }}>
                              {asset.change}
                            </span>
                            {/* Vol */}
                            <span className="text-[12px] text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                              {asset.vol24h}
                            </span>
                            {/* Mcap */}
                            <span className="text-[12px] text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                              {asset.mcap}
                            </span>
                          </button>

                          {/* Sub-markets dropdown */}
                          {asset.enabled && expanded && (
                            <div className="bg-surface-card border-t border-border-subtle/40">
                              {/* Stats strip */}
                              <div className="grid grid-cols-3 gap-px border-b border-border-subtle/40">
                                {[
                                  ['24h High', `$${asset.high24h}`],
                                  ['24h Low', `$${asset.low24h}`],
                                  ['Open Interest', asset.oi],
                                ].map(([label, val]) => (
                                  <div key={label} className="px-4 py-2.5">
                                    <div className="text-[10px] text-text-quaternary uppercase tracking-widest mb-0.5">{label}</div>
                                    <div className="text-[12px] font-medium text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>{val}</div>
                                  </div>
                                ))}
                              </div>

                              {/* Market rows */}
                              <div className="grid grid-cols-[1fr_120px_80px] px-5 py-1.5 border-b border-border-subtle/40">
                                {['Expiry', 'Time Remaining', 'Status'].map(h => (
                                  <span key={h} className="text-[9px] font-medium text-text-quaternary uppercase tracking-widest">{h}</span>
                                ))}
                              </div>
                              {assetMarkets.length > 0 ? assetMarkets.map((m) => {
                                const now = Date.now()
                                const msLeft = m.expiry - now
                                const hoursLeft = Math.floor(msLeft / 3_600_000)
                                const minsLeft = Math.floor((msLeft % 3_600_000) / 60_000)
                                const isLive = msLeft > 0 && msLeft < 3_600_000
                                const timeStr = msLeft <= 0 ? 'Expired'
                                  : hoursLeft > 24 ? `${Math.floor(hoursLeft / 24)}d ${hoursLeft % 24}h`
                                  : hoursLeft > 0 ? `${hoursLeft}h ${minsLeft}m`
                                  : `${minsLeft}m`

                                return (
                                  <button
                                    key={m.oracleId}
                                    onClick={() => { setSelectedMarket(m); setMarketOpen(false) }}
                                    className={`grid grid-cols-[1fr_120px_80px] items-center w-full px-5 py-2.5 text-left transition-colors hover:bg-surface-hover border-b border-border-subtle/30 last:border-0 ${
                                      m.oracleId === activeMarket?.oracleId ? 'bg-surface-hover' : ''
                                    }`}
                                  >
                                    <span className="text-[12px] font-medium text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                                      {new Date(m.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    <span className="text-[11px] text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                                      {timeStr}
                                    </span>
                                    <span className={`inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-[4px] w-fit ${
                                      isLive
                                        ? 'bg-bullish-green/15 text-bullish-green'
                                        : msLeft <= 0
                                        ? 'bg-surface-hover text-text-quaternary'
                                        : 'bg-[#7132f5]/15 text-[#7132f5]'
                                    }`}>
                                      <span className={`w-1 h-1 rounded-full ${isLive ? 'bg-bullish-green' : msLeft <= 0 ? 'bg-text-quaternary' : 'bg-[#7132f5]'}`} />
                                      {isLive ? 'Live' : msLeft <= 0 ? 'Closed' : 'Open'}
                                    </span>
                                  </button>
                                )
                              }) : (
                                <div className="px-5 py-4 text-[12px] text-text-quaternary">No active markets</div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
          <button className="text-text-tertiary hover:text-warning transition-colors px-1.5">
            <StarIcon />
          </button>
        </Island>

        {/* Stats */}
        <div className="flex items-center gap-6 min-w-0 overflow-hidden px-1">
          <Stat label="Last price">
            <span className="text-bearish-red">63,347.1</span>
            <span className="text-text-tertiary text-[11px] ml-1">USD</span>
          </Stat>
          <Stat label="24h change">
            <span className="text-bullish-green">0.95%</span>
          </Stat>
          <Stat label="24h volume">
            <span className="text-text-primary">1.47K</span>
            <span className="text-text-tertiary text-[11px] ml-1">BTC</span>
            <span className="text-text-primary ml-2">93.2M</span>
            <span className="text-text-tertiary text-[11px] ml-1">USD</span>
          </Stat>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <button className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary rounded-[10px] bg-surface-primary border border-border-subtle px-2.5 py-1.5 transition-colors">
            <KeyboardIcon />
            Hotkeys
          </button>

          <div className="relative" ref={addRef}>
            <button
              onClick={() => setAddOpen((o) => !o)}
              className={`flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] bg-surface-primary border px-2.5 py-1.5 transition-colors ${addOpen ? 'text-text-primary border-border-default' : 'text-text-secondary hover:text-text-primary border-border-subtle'}`}
            >
              <PlusIcon />
              Add Widgets
            </button>
            {addOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-44 z-50 rounded-[12px] bg-surface-primary border border-border-default shadow-xl py-1.5">
                <p className="px-3 py-1 text-[10px] font-medium text-text-quaternary uppercase tracking-widest">Add widget</p>
                {addOptions.map((opt) => (
                  <button key={opt.type} onClick={() => { onAddWidget?.(opt.type); setAddOpen(false) }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-card transition-colors">
                    <IconPlus size={13} stroke={2} className="text-text-quaternary" />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={onComboOpen}
            className={`flex items-center gap-1.5 text-[12px] font-semibold rounded-[10px] px-2.5 py-1.5 transition-all border ${
              comboActive
                ? 'bg-surface-hover text-text-primary border-brand-violet'
                : 'bg-surface-primary text-text-secondary hover:text-text-primary border-border-subtle'
            }`}
          >
            Combo
          </button>

          <div className="w-px h-5 bg-border-subtle mx-0.5" />

          <button className="relative text-text-tertiary hover:text-text-primary transition-colors p-1.5">
            <BellIcon />
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-bearish-red" />
          </button>

          <Island>
            <button className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-card rounded-[8px] px-2.5 py-1.5 transition-colors">
              Advanced <ChevronDown />
            </button>
            <button className="text-text-tertiary hover:text-text-primary transition-colors p-1.5">
              <GlobeIcon />
            </button>
          </Island>

          {account ? (
            <div className="relative" ref={profileRef}>
              <button
                onClick={() => setProfileOpen((o) => !o)}
                className="flex items-center justify-center w-8 h-8 rounded-full transition-all hover:ring-2 hover:ring-border-default"
                style={{ background: '#7132f5' }}
              >
                <IconUser size={15} stroke={2} className="text-white" />
              </button>

              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-52 z-50 rounded-[14px] bg-surface-primary border border-border-default shadow-xl overflow-hidden py-1.5">
                  <div className="px-3 py-2.5 border-b border-border-subtle mb-1">
                    <div className="text-[11px] font-semibold text-text-primary mb-0.5">
                      Connected
                    </div>
                    <button
                      onClick={copyAddr}
                      className="flex items-center gap-1.5 text-[11px] text-text-quaternary hover:text-text-secondary transition-colors"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {shortAddr}
                      {copied ? <IconCheck size={11} stroke={2.5} className="text-bullish-green" /> : <IconCopy size={11} stroke={1.75} />}
                    </button>
                  </div>
                  <button className="flex items-center gap-2.5 w-full px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-card transition-colors">
                    <IconWallet size={14} stroke={1.75} />
                    Portfolio
                  </button>
                  <button className="flex items-center gap-2.5 w-full px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-card transition-colors">
                    <IconSettings size={14} stroke={1.75} />
                    Settings
                  </button>
                  <div className="border-t border-border-subtle mt-1 pt-1">
                    <button
                      onClick={handleDisconnect}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-[12px] text-text-secondary hover:text-bearish-red hover:bg-surface-card transition-colors"
                    >
                      <IconLogout size={14} stroke={1.75} />
                      Disconnect
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <button
                onClick={() => setOnboardingOpen(true)}
                className="text-[12px] font-semibold text-black bg-white rounded-[10px] px-3 py-1.5 hover:opacity-90 transition-opacity"
              >
                Connect Wallet
              </button>
            </>
          )}
        </div>
      </div>

      <OnboardingModal open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
    </>
  )
}

export default TopNav
