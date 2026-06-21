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
} from '@tabler/icons-react'
import OnboardingModal from '../onboarding-modal'

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
          <button className="flex items-center gap-2.5 hover:bg-surface-card rounded-[8px] px-2 py-1 transition-colors">
            <div className="w-7 h-7 rounded-full bg-[#f7931a] flex items-center justify-center text-white text-[14px] font-bold shrink-0">
              ₿
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-semibold text-text-primary">BTC/USD</span>
              <span className="text-[10px] font-medium text-text-tertiary bg-surface-card border border-border-subtle rounded-badge px-1 py-px">10x</span>
            </div>
            <span className="ml-1 text-[10px] text-text-quaternary bg-surface-card border border-border-subtle rounded-badge px-1.5 py-0.5" style={{ fontFamily: 'var(--font-mono)' }}>
              ⌘K
            </span>
          </button>
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
            className="flex items-center gap-1.5 text-[12px] font-semibold rounded-[10px] px-2.5 py-1.5 transition-all"
            style={{
              background: comboActive ? 'rgba(128,125,254,0.22)' : 'rgba(128,125,254,0.1)',
              color: '#807dfe',
              border: `1px solid rgba(128,125,254,${comboActive ? '0.45' : '0.25'})`,
            }}
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
                style={{ background: 'linear-gradient(135deg, #807dfe 0%, #19e6bd 100%)' }}
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
