import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconBell,
  IconChevronDown,
  IconCopy,
  IconDatabase,
  IconEye,
  IconEyeOff,
  IconKey,
  IconRefresh,
  IconShieldCheck,
  IconTerminal2,
  IconUser,
  IconWallet,
  IconX,
} from '@tabler/icons-react'

type SettingsSection = 'profile' | 'preferences' | 'notifications' | 'security' | 'api' | 'controls'

const sections: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
  { id: 'profile', label: 'Profile / Wallet', icon: <IconUser size={16} stroke={1.8} /> },
  { id: 'preferences', label: 'Preferences', icon: <IconDatabase size={16} stroke={1.8} /> },
  { id: 'notifications', label: 'Notifications', icon: <IconBell size={16} stroke={1.8} /> },
  { id: 'security', label: 'Security', icon: <IconShieldCheck size={16} stroke={1.8} /> },
  { id: 'api', label: 'API / Keeper / Dev', icon: <IconTerminal2 size={16} stroke={1.8} /> },
  { id: 'controls', label: 'Account Controls', icon: <IconKey size={16} stroke={1.8} /> },
]

const wallets = [
  { label: 'Trading wallet', address: '0x8b55522178a6fd0372b07071e52a835f41c5c4e224a54ce94738f9d0a07fb8c9', balance: '$12,480.42' },
  { label: 'Keeper hot key', address: '0x41b1c24c54674d07f2a9822327e3074c9804bac22b3ba77a3b988756729dd0f4', balance: '$410.00' },
]

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

function copyText(value: string) {
  void navigator.clipboard?.writeText(value)
}

const Toggle = ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
  <button
    onClick={onChange}
    className={cx(
      'h-5 w-9 rounded-pill border p-0.5 transition-colors',
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

function RowToggle({
  title,
  body,
  checked,
  onChange,
}: {
  title: string
  body: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-4 last:border-b-0">
      <div>
        <div className="font-semibold text-text-primary">{title}</div>
        <div className="mt-1 text-[12px] text-text-quaternary">{body}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-text-quaternary">{label}</div>
      {children}
    </label>
  )
}

function SettingsBody() {
  const [section, setSection] = useState<SettingsSection>('profile')
  const [displayName, setDisplayName] = useState('tofunnmi')
  const [defaultAsset, setDefaultAsset] = useState('BTC')
  const [quoteMode, setQuoteMode] = useState('Probability')
  const [slippage, setSlippage] = useState('1.0')
  const [showKey, setShowKey] = useState(false)
  const [toggles, setToggles] = useState({
    compact: true,
    confirmations: true,
    sound: false,
    settlement: true,
    keeper: true,
    copy: true,
    biometrics: false,
    sponsored: true,
    dryRun: true,
    redis: true,
  })

  const flip = (key: keyof typeof toggles) => {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)] max-[820px]:grid-cols-1">
      <aside className="border-r border-border-subtle bg-surface-primary max-[820px]:border-b max-[820px]:border-r-0">
        <div className="border-b border-border-subtle px-4 py-4">
          <div className="text-[11px] uppercase tracking-widest text-text-quaternary">Account</div>
          <div className="mt-2 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[6px] border border-border-default bg-surface-card text-[14px] font-bold">T</div>
            <div className="min-w-0">
              <div className="truncate font-bold text-text-primary">tofunnmi</div>
              <div className="text-[11px] text-text-quaternary">local testnet</div>
            </div>
          </div>
        </div>

        <nav className="grid gap-1 p-2 max-[820px]:grid-cols-2 max-[520px]:grid-cols-1">
          {sections.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={cx(
                'flex items-center gap-3 rounded-[6px] px-3 py-2.5 text-left text-[12px] font-semibold transition-colors',
                section === item.id
                  ? 'bg-surface-card text-text-primary'
                  : 'text-text-quaternary hover:bg-surface-card/60 hover:text-text-secondary',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="min-h-0 min-w-0 overflow-auto bg-page">
        <div className="border-b border-border-subtle bg-surface-primary px-5 py-4">
          <div className="text-[15px] font-bold text-text-primary">{sections.find((item) => item.id === section)?.label}</div>
          <div className="mt-1 text-[12px] text-text-quaternary">Changes are local mock state until wallet persistence is wired.</div>
        </div>

        {section === 'profile' && (
          <div className="grid gap-px bg-border-subtle">
            <div className="grid grid-cols-2 gap-4 bg-surface-primary p-5 max-[760px]:grid-cols-1">
              <Field label="Display name">
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="h-10 w-full border border-border-subtle bg-page px-3 text-text-primary" />
              </Field>
              <Field label="Account mode">
                <button className="flex h-10 w-full items-center justify-between border border-border-subtle bg-page px-3 text-left text-text-primary">
                  Self-custody + keeper intents
                  <IconChevronDown size={14} stroke={1.8} />
                </button>
              </Field>
            </div>

            <div className="bg-surface-primary">
              {wallets.map((wallet) => (
                <div key={wallet.label} className="grid grid-cols-[160px_minmax(0,1fr)_110px_78px] items-center gap-4 border-b border-border-subtle px-5 py-4 last:border-b-0 max-[760px]:grid-cols-1">
                  <div className="flex items-center gap-2 font-semibold text-text-primary">
                    <IconWallet size={16} stroke={1.8} />
                    {wallet.label}
                  </div>
                  <button onClick={() => copyText(wallet.address)} className="flex min-w-0 items-center gap-2 text-left text-[12px] text-text-quaternary hover:text-text-secondary">
                    <span className="truncate">{wallet.address}</span>
                    <IconCopy size={14} stroke={1.8} />
                  </button>
                  <div className="font-bold text-text-primary">{wallet.balance}</div>
                  <button className="h-8 rounded-[6px] border border-border-subtle text-[11px] uppercase tracking-widest text-text-secondary hover:text-text-primary">
                    Rotate
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {section === 'preferences' && (
          <div>
            <div className="grid grid-cols-3 gap-4 border-b border-border-subtle bg-surface-primary p-5 max-[900px]:grid-cols-1">
              <Field label="Default asset">
                <select value={defaultAsset} onChange={(e) => setDefaultAsset(e.target.value)} className="h-10 w-full border border-border-subtle bg-page px-3 text-text-primary">
                  <option>BTC</option>
                  <option>ETH</option>
                  <option>SUI</option>
                </select>
              </Field>
              <Field label="Quote display">
                <select value={quoteMode} onChange={(e) => setQuoteMode(e.target.value)} className="h-10 w-full border border-border-subtle bg-page px-3 text-text-primary">
                  <option>Probability</option>
                  <option>Decimal odds</option>
                  <option>Implied vol</option>
                </select>
              </Field>
              <Field label="Max slippage">
                <input value={slippage} onChange={(e) => setSlippage(e.target.value)} className="h-10 w-full border border-border-subtle bg-page px-3 text-text-primary" />
              </Field>
            </div>
            <RowToggle title="Compact trading panels" body="Reduce padding and keep more surface visible on trade pages." checked={toggles.compact} onChange={() => flip('compact')} />
            <RowToggle title="Trade confirmations" body="Require an extra confirmation before keeper intent submission." checked={toggles.confirmations} onChange={() => flip('confirmations')} />
            <RowToggle title="Execution sounds" body="Play a subtle tone when a fill or settlement lands." checked={toggles.sound} onChange={() => flip('sound')} />
          </div>
        )}

        {section === 'notifications' && (
          <div>
            <RowToggle title="Settlement alerts" body="Notify when Predict oracles settle and payouts become executable." checked={toggles.settlement} onChange={() => flip('settlement')} />
            <RowToggle title="Keeper job updates" body="Show submitted, confirmed, failed, and dead-lettered jobs." checked={toggles.keeper} onChange={() => flip('keeper')} />
            <RowToggle title="Copy trading fills" body="Notify when a followed strategy opens or closes a mirrored position." checked={toggles.copy} onChange={() => flip('copy')} />
          </div>
        )}

        {section === 'security' && (
          <div>
            <RowToggle title="Biometric unlock" body="Require device unlock before signing local keeper and trade actions." checked={toggles.biometrics} onChange={() => flip('biometrics')} />
            <RowToggle title="Sponsored transactions" body="Allow gas sponsorship for supported low-risk account actions." checked={toggles.sponsored} onChange={() => flip('sponsored')} />
            <div className="grid grid-cols-3 gap-px bg-border-subtle max-[900px]:grid-cols-1">
              {[
                ['zkLogin ready', 'OAuth onboarding path can be attached later.'],
                ['Hot key separated', 'Keeper key is isolated from admin authority.'],
                ['Policy vaults', 'Copy trading should use constrained vault permissions.'],
              ].map(([title, body]) => (
                <div key={title} className="bg-surface-primary p-5">
                  <div className="font-bold text-text-primary">{title}</div>
                  <div className="mt-2 text-[12px] text-text-quaternary">{body}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {section === 'api' && (
          <div>
            <div className="grid grid-cols-2 gap-4 border-b border-border-subtle bg-surface-primary p-5 max-[900px]:grid-cols-1">
              <Field label="Local API">
                <button onClick={() => copyText('http://127.0.0.1:8788')} className="flex h-10 w-full items-center justify-between border border-border-subtle bg-page px-3 text-left text-text-primary">
                  http://127.0.0.1:8788
                  <IconCopy size={14} stroke={1.8} />
                </button>
              </Field>
              <Field label="WebSocket">
                <button onClick={() => copyText('ws://127.0.0.1:8788/ws')} className="flex h-10 w-full items-center justify-between border border-border-subtle bg-page px-3 text-left text-text-primary">
                  ws://127.0.0.1:8788/ws
                  <IconCopy size={14} stroke={1.8} />
                </button>
              </Field>
              <Field label="API key">
                <div className="flex h-10 border border-border-subtle bg-page">
                  <input readOnly value={showKey ? 'cerida_live_local_8svi_kpr_29d' : '*******************************'} className="min-w-0 flex-1 bg-transparent px-3 text-text-primary" />
                  <button onClick={() => setShowKey((prev) => !prev)} className="flex w-10 items-center justify-center text-text-quaternary hover:text-text-primary">
                    {showKey ? <IconEyeOff size={16} stroke={1.8} /> : <IconEye size={16} stroke={1.8} />}
                  </button>
                </div>
              </Field>
              <Field label="Indexer lane">
                <button className="flex h-10 w-full items-center justify-between border border-border-subtle bg-page px-3 text-left text-text-primary">
                  markets + flow + keeper
                  <IconChevronDown size={14} stroke={1.8} />
                </button>
              </Field>
            </div>
            <RowToggle title="Keeper dry-run mode" body="Simulate every job but avoid submitting signed transactions." checked={toggles.dryRun} onChange={() => flip('dryRun')} />
            <RowToggle title="Redis stream cache" body="Use local Redis for live widgets, locks, and job queues." checked={toggles.redis} onChange={() => flip('redis')} />
          </div>
        )}

        {section === 'controls' && (
          <div className="p-5">
            <div className="grid grid-cols-3 gap-3 max-[980px]:grid-cols-1">
              {['Download account CSV', 'Export fills JSON', 'Reset local layout'].map((label) => (
                <button key={label} className="h-10 border border-border-subtle bg-surface-primary px-3 text-[11px] font-semibold uppercase tracking-widest text-text-secondary hover:text-text-primary">
                  {label}
                </button>
              ))}
            </div>

            <div className="mt-6 border border-bearish-red/30 bg-bearish-red/5 p-5">
              <div className="text-[13px] font-bold text-bearish-red">Account danger zone</div>
              <div className="mt-2 max-w-2xl text-[12px] text-text-quaternary">
                These controls are inert mock actions for now, but this is where disconnect wallet, revoke copy permissions, and wipe local cache will live.
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="h-9 border border-bearish-red/40 px-3 text-[11px] uppercase tracking-widest text-bearish-red hover:bg-bearish-red/10">
                  Disconnect wallet
                </button>
                <button className="h-9 border border-bearish-red/40 px-3 text-[11px] uppercase tracking-widest text-bearish-red hover:bg-bearish-red/10">
                  Revoke copy vaults
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!mounted || !open) return null

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black/70 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Settings">
      <button className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close settings" />
      <div className="relative mx-auto flex h-[min(780px,calc(100vh-32px))] max-w-[1180px] flex-col overflow-hidden border border-border-subtle bg-page shadow-2xl">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-surface-primary px-4">
          <div>
            <div className="text-[15px] font-bold text-text-primary">Settings</div>
            <div className="text-[11px] text-text-quaternary">Account, wallet, keeper, and local development controls.</div>
          </div>
          <div className="flex items-center gap-2">
            <button className="flex h-8 items-center gap-2 rounded-[6px] border border-border-subtle px-3 text-[11px] uppercase tracking-widest text-text-secondary hover:text-text-primary">
              <IconRefresh size={14} stroke={1.8} />
              Sync
            </button>
            <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-[6px] text-text-quaternary hover:bg-surface-card hover:text-text-primary" aria-label="Close settings">
              <IconX size={16} stroke={1.8} />
            </button>
          </div>
        </header>
        <SettingsBody />
      </div>
    </div>,
    document.body,
  )
}

export default SettingsModal
