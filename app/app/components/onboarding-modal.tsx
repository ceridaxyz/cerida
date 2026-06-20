import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconArrowRight,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconKey,
  IconLogin2,
  IconShieldCheck,
  IconSparkles,
  IconUser,
  IconWallet,
  IconX,
} from '@tabler/icons-react'
import { useConnectWallet, useCurrentAccount, useCurrentWallet, useDisconnectWallet, useWallets } from '@mysten/dapp-kit'
import { isGoogleWallet } from '@mysten/enoki'
import { getEnokiConfig } from './app-providers'

const SESSION_KEY = 'cerida.onboarding.session'

export type OnboardingSession = {
  mode: 'enoki' | 'wallet' | 'preview'
  label: string
  address: string
  provider: string
  createdAt: number
  proofStatus: 'preview' | 'wallet_standard' | 'ready'
}

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

function safeReadSession(): OnboardingSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) as OnboardingSession : null
  } catch {
    return null
  }
}

function safeWriteSession(session: OnboardingSession | null) {
  if (typeof window === 'undefined') return
  if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  else window.localStorage.removeItem(SESSION_KEY)
  window.dispatchEvent(new CustomEvent('cerida:onboarding-session', { detail: session }))
}

export function getOnboardingSession() {
  return safeReadSession()
}

export function clearOnboardingSession() {
  safeWriteSession(null)
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value)
}

function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes)
  window.crypto.getRandomValues(data)
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function digestAddress(seed: string) {
  const encoded = new TextEncoder().encode(seed)
  const hash = await window.crypto.subtle.digest('SHA-256', encoded)
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `0x${hex.slice(0, 64)}`
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function StepPill({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cx(
          'flex h-5 w-5 items-center justify-center rounded-[6px] border text-[10px]',
          done && 'border-bullish-green bg-bullish-green/15 text-bullish-green',
          active && !done && 'border-brand-violet bg-brand-violet/15 text-accent-light',
          !active && !done && 'border-border-default bg-surface-card text-text-quaternary',
        )}
      >
        {done ? <IconCheck size={12} stroke={2.2} /> : null}
      </span>
      <span className={cx('text-[11px] uppercase tracking-widest', active || done ? 'text-text-secondary' : 'text-text-quaternary')}>
        {label}
      </span>
    </div>
  )
}

function CapabilityRow({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="border-b border-border-subtle px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-text-primary">
        {icon}
        {title}
      </div>
      <div className="mt-1 text-[11px] leading-5 text-text-quaternary">{body}</div>
    </div>
  )
}

function ConnectedState({ session, onDisconnect }: { session: OnboardingSession; onDisconnect: () => void }) {
  const isPreview = session.mode === 'preview'

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px] max-[860px]:grid-cols-1">
      <section className="min-w-0 border-r border-border-subtle p-5 max-[860px]:border-b max-[860px]:border-r-0">
        <div className="inline-flex items-center gap-2 rounded-[6px] border border-bullish-green/30 bg-bullish-green/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-bullish-green">
          <IconCheck size={13} stroke={2.2} />
          {isPreview ? 'Preview session' : 'Enoki connected'}
        </div>
        <h2 className="mt-5 text-[24px] font-bold tracking-[-0.01em] text-text-primary">Cerida account ready</h2>
        <p className="mt-3 max-w-xl text-[12px] leading-6 text-text-tertiary">
          {isPreview
            ? 'This local preview keeps the onboarding UI usable while Enoki credentials are missing. Add the Enoki API key and Google OAuth client ID to use the real wallet-standard flow.'
            : 'This account is connected through Enoki as a Sui wallet-standard account. The next Cerida step is using this signer to create profile, deposit, and copy-trading permission transactions.'}
        </p>

        <div className="mt-6 grid gap-px border border-border-subtle bg-border-subtle">
          {[
            ['Mode', session.mode === 'enoki' ? 'Enoki zkLogin wallet' : session.mode === 'wallet' ? 'Sui wallet' : 'Local preview'],
            ['Provider', session.provider],
            ['Proof status', session.proofStatus === 'wallet_standard' ? 'Managed by Enoki wallet' : 'Local preview only'],
          ].map(([label, value]) => (
            <div key={label} className="grid grid-cols-[160px_minmax(0,1fr)] bg-surface-primary px-4 py-3 text-[12px] max-[560px]:grid-cols-1">
              <div className="uppercase tracking-widest text-text-quaternary">{label}</div>
              <div className="font-semibold text-text-primary">{value}</div>
            </div>
          ))}
          <div className="grid grid-cols-[160px_minmax(0,1fr)_40px] items-center bg-surface-primary px-4 py-3 text-[12px] max-[560px]:grid-cols-1">
            <div className="uppercase tracking-widest text-text-quaternary">Address</div>
            <div className="min-w-0 truncate font-semibold text-text-primary">{session.address}</div>
            <button onClick={() => copyText(session.address)} className="flex h-8 w-8 items-center justify-center rounded-[6px] text-text-quaternary hover:bg-surface-card hover:text-text-primary" aria-label="Copy address">
              <IconCopy size={15} stroke={1.8} />
            </button>
          </div>
        </div>
      </section>

      <aside className="bg-surface-primary p-5">
        <div className="text-[11px] uppercase tracking-widest text-text-quaternary">Account controls</div>
        <button className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-[6px] border border-border-subtle bg-page text-[12px] font-semibold text-text-primary hover:bg-surface-card">
          <IconWallet size={15} stroke={1.8} />
          Open portfolio
        </button>
        <button onClick={onDisconnect} className="mt-2 flex h-10 w-full items-center justify-center rounded-[6px] border border-bearish-red/35 text-[12px] font-semibold text-bearish-red hover:bg-bearish-red/10">
          Disconnect session
        </button>
      </aside>
    </div>
  )
}

function StartState({ onPreview }: { onPreview: (session: OnboardingSession) => void }) {
  const wallets = useWallets()
  const connectWallet = useConnectWallet()
  const currentAccount = useCurrentAccount()
  const { isConnecting } = useCurrentWallet()
  const [error, setError] = useState<string | null>(null)
  const config = getEnokiConfig()

  const googleWallet = wallets.find((wallet) => isGoogleWallet(wallet))
  const enokiConfigured = Boolean(config.apiKey && config.googleClientId)

  const connectGoogle = () => {
    setError(null)
    if (!enokiConfigured) {
      setError('Add VITE_ENOKI_API_KEY and VITE_GOOGLE_CLIENT_ID to enable Enoki Google sign-in.')
      return
    }
    if (!googleWallet) {
      setError('Enoki Google wallet is not registered yet. Refresh after adding the env vars.')
      return
    }

    connectWallet.mutate(
      { wallet: googleWallet },
      {
        onError: (err) => setError(err.message),
      },
    )
  }

  const preview = async () => {
    setError(null)
    const address = await digestAddress(`cerida-enoki-preview:${Date.now()}:${randomHex(8)}`)
    const session: OnboardingSession = {
      mode: 'preview',
      label: 'Preview account',
      address,
      provider: 'Local Enoki preview',
      createdAt: Date.now(),
      proofStatus: 'preview',
    }
    safeWriteSession(session)
    onPreview(session)
  }

  const disabled = isConnecting || connectWallet.isPending

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_330px] max-[900px]:grid-cols-1">
      <section className="min-w-0 border-r border-border-subtle p-5 max-[900px]:border-b max-[900px]:border-r-0">
        <div className="flex flex-wrap gap-4">
          <StepPill active done={false} label="Enoki" />
          <StepPill active={false} done={false} label="Wallet" />
          <StepPill active={false} done={false} label="Gasless" />
        </div>

        <h2 className="mt-6 text-[25px] font-bold tracking-[-0.01em] text-text-primary">Start with Enoki</h2>
        <p className="mt-3 max-w-xl text-[12px] leading-6 text-text-tertiary">
          Enoki gives Cerida a managed zkLogin wallet path: Google sign-in, app-specific Sui address, wallet-standard signing, and a clean route into sponsored transactions.
        </p>

        <div className="mt-6 grid gap-3">
          <button
            onClick={connectGoogle}
            disabled={disabled}
            className="flex h-11 items-center justify-between rounded-[6px] border border-brand-violet/45 bg-brand-violet/15 px-4 text-[13px] font-bold text-text-primary hover:bg-brand-violet/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="flex items-center gap-3">
              <IconLogin2 size={17} stroke={1.9} />
              {disabled ? 'Opening Enoki...' : 'Continue with Google'}
            </span>
            <IconExternalLink size={16} stroke={1.8} />
          </button>

          <button
            onClick={preview}
            className="flex h-10 items-center justify-between rounded-[6px] border border-border-subtle bg-surface-card px-4 text-[12px] font-semibold text-text-secondary hover:text-text-primary"
          >
            <span className="flex items-center gap-3">
              <IconSparkles size={15} stroke={1.8} />
              Preview signed-in state
            </span>
            <IconArrowRight size={15} stroke={1.8} />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden border border-border-subtle bg-border-subtle text-[11px] max-[620px]:grid-cols-1">
          {[
            ['Network', config.network],
            ['Enoki API', config.apiKey ? 'configured' : 'missing'],
            ['Google OAuth', config.googleClientId ? 'configured' : 'missing'],
            ['Wallet', currentAccount ? shortAddress(currentAccount.address) : googleWallet ? 'registered' : 'not registered'],
          ].map(([label, value]) => (
            <div key={label} className="bg-surface-primary px-3 py-2">
              <div className="uppercase tracking-widest text-text-quaternary">{label}</div>
              <div className="mt-1 font-semibold text-text-primary">{value}</div>
            </div>
          ))}
        </div>

        {error && (
          <div className="mt-4 border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-5 text-warning">
            {error}
          </div>
        )}
      </section>

      <aside className="bg-surface-primary">
        <CapabilityRow
          icon={<IconShieldCheck size={15} stroke={1.9} />}
          title="Managed zkLogin"
          body="Enoki handles the sharp OAuth, salt, and proof edges instead of us operating custom zkLogin infra."
        />
        <CapabilityRow
          icon={<IconKey size={15} stroke={1.9} />}
          title="Keeper permissions later"
          body="Copy trading should still use bounded Move capability objects signed by this account."
        />
        <CapabilityRow
          icon={<IconWallet size={15} stroke={1.9} />}
          title="Wallet-standard path"
          body="Once connected, Cerida can use normal Sui wallet hooks for profile, deposits, and approvals."
        />
      </aside>
    </div>
  )
}

function OnboardingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false)
  const [previewSession, setPreviewSession] = useState<OnboardingSession | null>(null)
  const currentAccount = useCurrentAccount()
  const { currentWallet, isConnected } = useCurrentWallet()
  const disconnectWallet = useDisconnectWallet()

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!currentAccount || !isConnected) return

    const isEnoki = currentWallet ? isGoogleWallet(currentWallet) : false
    const next: OnboardingSession = {
      mode: isEnoki ? 'enoki' : 'wallet',
      label: isEnoki ? 'Enoki account' : currentWallet?.name ?? 'Sui wallet',
      address: currentAccount.address,
      provider: isEnoki ? 'Google via Enoki' : currentWallet?.name ?? 'Wallet Standard',
      createdAt: Date.now(),
      proofStatus: 'wallet_standard',
    }
    safeWriteSession(next)
    setPreviewSession(null)
  }, [currentAccount, currentWallet, isConnected])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  const connectedSession = currentAccount && isConnected
    ? safeReadSession() ?? {
      mode: 'wallet' as const,
      label: currentWallet?.name ?? 'Sui wallet',
      address: currentAccount.address,
      provider: currentWallet?.name ?? 'Wallet Standard',
      createdAt: Date.now(),
      proofStatus: 'wallet_standard' as const,
    }
    : null

  const session = connectedSession ?? previewSession
  const title = useMemo(() => session ? `${session.label} ${shortAddress(session.address)}` : 'Sign in / Sign up', [session])

  const disconnect = () => {
    safeWriteSession(null)
    setPreviewSession(null)
    if (isConnected) disconnectWallet.mutate()
  }

  if (!mounted || !open) return null

  return createPortal(
    <div className="fixed inset-0 z-[220] bg-black/72 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Cerida onboarding">
      <button className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close onboarding" />
      <div className="relative mx-auto flex h-[min(680px,calc(100vh-32px))] max-w-[980px] flex-col overflow-hidden border border-border-subtle bg-page shadow-2xl">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-surface-primary px-4">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold text-text-primary">{title}</div>
            <div className="text-[11px] text-text-quaternary">Enoki zkLogin, sponsored actions, and wallet-standard signing.</div>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-[6px] text-text-quaternary hover:bg-surface-card hover:text-text-primary" aria-label="Close onboarding">
            <IconX size={16} stroke={1.8} />
          </button>
        </header>

        {session ? <ConnectedState session={session} onDisconnect={disconnect} /> : <StartState onPreview={setPreviewSession} />}
      </div>
    </div>,
    document.body,
  )
}

export default OnboardingModal
