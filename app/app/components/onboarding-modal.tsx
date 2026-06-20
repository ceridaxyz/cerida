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

const SESSION_KEY = 'cerida.onboarding.session'
const PENDING_KEY = 'cerida.zklogin.pending'

export type OnboardingSession = {
  mode: 'zklogin' | 'wallet'
  label: string
  address: string
  provider: string
  createdAt: number
  proofStatus: 'preview' | 'pending_prover' | 'ready'
}

type PendingLogin = {
  state: string
  nonce: string
  createdAt: number
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

function readPending(): PendingLogin | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY)
    return raw ? JSON.parse(raw) as PendingLogin : null
  } catch {
    return null
  }
}

function writePending(pending: PendingLogin) {
  window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
}

function clearPending() {
  window.sessionStorage.removeItem(PENDING_KEY)
}

function oauthClientId() {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim()
}

function buildGoogleUrl(pending: PendingLogin) {
  const clientId = oauthClientId()
  if (!clientId) return null

  const redirectUri = `${window.location.origin}${window.location.pathname}`
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce: pending.nonce,
    state: pending.state,
    prompt: 'select_account',
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

function parseOAuthHash() {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  if (!hash.includes('id_token=')) return null
  const params = new URLSearchParams(hash)
  const idToken = params.get('id_token')
  const state = params.get('state')
  return idToken && state ? { idToken, state } : null
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
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px] max-[860px]:grid-cols-1">
      <section className="min-w-0 border-r border-border-subtle p-5 max-[860px]:border-b max-[860px]:border-r-0">
        <div className="inline-flex items-center gap-2 rounded-[6px] border border-bullish-green/30 bg-bullish-green/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-bullish-green">
          <IconCheck size={13} stroke={2.2} />
          Signed in
        </div>
        <h2 className="mt-5 text-[24px] font-bold tracking-[-0.01em] text-text-primary">Cerida account ready</h2>
        <p className="mt-3 max-w-xl text-[12px] leading-6 text-text-tertiary">
          This local session is ready for profile state, sponsored transactions, and later zkLogin proof signing. The next backend piece is the prover/salt service that converts the OAuth JWT into a Sui zkLogin signature.
        </p>

        <div className="mt-6 grid gap-px border border-border-subtle bg-border-subtle">
          {[
            ['Mode', session.mode === 'zklogin' ? 'zkLogin social wallet' : 'External wallet'],
            ['Provider', session.provider],
            ['Proof status', session.proofStatus === 'pending_prover' ? 'JWT captured, prover pending' : 'Local preview'],
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
          Disconnect local session
        </button>
      </aside>
    </div>
  )
}

function StartState({ onSession }: { onSession: (session: OnboardingSession) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clientId = oauthClientId()

  const startGoogle = () => {
    setError(null)
    if (!clientId) {
      setError('Add VITE_GOOGLE_CLIENT_ID to enable the real Google redirect.')
      return
    }
    const pending = {
      state: randomHex(16),
      nonce: randomHex(24),
      createdAt: Date.now(),
    }
    writePending(pending)
    const url = buildGoogleUrl(pending)
    if (!url) return
    window.location.assign(url)
  }

  const preview = async () => {
    setBusy(true)
    setError(null)
    const address = await digestAddress(`cerida-preview:${Date.now()}:${randomHex(8)}`)
    const session: OnboardingSession = {
      mode: 'zklogin',
      label: 'Preview account',
      address,
      provider: 'Local preview',
      createdAt: Date.now(),
      proofStatus: 'preview',
    }
    safeWriteSession(session)
    onSession(session)
    setBusy(false)
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_330px] max-[900px]:grid-cols-1">
      <section className="min-w-0 border-r border-border-subtle p-5 max-[900px]:border-b max-[900px]:border-r-0">
        <div className="flex flex-wrap gap-4">
          <StepPill active done={false} label="OAuth" />
          <StepPill active={false} done={false} label="Proof" />
          <StepPill active={false} done={false} label="Gasless" />
        </div>

        <h2 className="mt-6 text-[25px] font-bold tracking-[-0.01em] text-text-primary">Start with zkLogin</h2>
        <p className="mt-3 max-w-xl text-[12px] leading-6 text-text-tertiary">
          Sign in with Google, create a Sui address, then let Cerida sponsor first actions while your account stays self-custodial. This is the first onboarding slice; prover-backed transaction signing comes next.
        </p>

        <div className="mt-6 grid gap-3">
          <button
            onClick={startGoogle}
            className="flex h-11 items-center justify-between rounded-[6px] border border-brand-violet/45 bg-brand-violet/15 px-4 text-[13px] font-bold text-text-primary hover:bg-brand-violet/20"
          >
            <span className="flex items-center gap-3">
              <IconLogin2 size={17} stroke={1.9} />
              Continue with Google
            </span>
            <IconExternalLink size={16} stroke={1.8} />
          </button>

          <button
            onClick={preview}
            disabled={busy}
            className="flex h-10 items-center justify-between rounded-[6px] border border-border-subtle bg-surface-card px-4 text-[12px] font-semibold text-text-secondary hover:text-text-primary disabled:opacity-60"
          >
            <span className="flex items-center gap-3">
              <IconSparkles size={15} stroke={1.8} />
              Preview signed-in state
            </span>
            <IconArrowRight size={15} stroke={1.8} />
          </button>
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
          title="Self-custody first"
          body="OAuth creates the address path, but trade approvals still require scoped signing."
        />
        <CapabilityRow
          icon={<IconKey size={15} stroke={1.9} />}
          title="Keeper permissions later"
          body="Copy trading and auto execution should use bounded capability objects."
        />
        <CapabilityRow
          icon={<IconWallet size={15} stroke={1.9} />}
          title="Wallet fallback"
          body="Power users can still connect a normal Sui wallet in the next slice."
        />
      </aside>
    </div>
  )
}

function OnboardingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false)
  const [session, setSession] = useState<OnboardingSession | null>(null)
  const [callbackError, setCallbackError] = useState<string | null>(null)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!mounted) return
    setSession(safeReadSession())
  }, [mounted, open])

  useEffect(() => {
    if (!mounted) return
    const oauth = parseOAuthHash()
    if (!oauth) return

    const pending = readPending()
    if (!pending || pending.state !== oauth.state) {
      setCallbackError('OAuth state mismatch. Start zkLogin again from Cerida.')
      return
    }

    void digestAddress(`cerida-zklogin:${oauth.idToken}`).then((address) => {
      const next: OnboardingSession = {
        mode: 'zklogin',
        label: 'zkLogin account',
        address,
        provider: 'Google',
        createdAt: Date.now(),
        proofStatus: 'pending_prover',
      }
      safeWriteSession(next)
      setSession(next)
      clearPending()
      window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`)
    })
  }, [mounted])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  const title = useMemo(() => session ? `${session.label} ${shortAddress(session.address)}` : 'Sign in / Sign up', [session])

  const disconnect = () => {
    clearOnboardingSession()
    setSession(null)
  }

  if (!mounted || !open) return null

  return createPortal(
    <div className="fixed inset-0 z-[220] bg-black/72 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Cerida onboarding">
      <button className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close onboarding" />
      <div className="relative mx-auto flex h-[min(680px,calc(100vh-32px))] max-w-[980px] flex-col overflow-hidden border border-border-subtle bg-page shadow-2xl">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-surface-primary px-4">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold text-text-primary">{title}</div>
            <div className="text-[11px] text-text-quaternary">zkLogin onboarding, sponsored actions, and wallet fallback.</div>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-[6px] text-text-quaternary hover:bg-surface-card hover:text-text-primary" aria-label="Close onboarding">
            <IconX size={16} stroke={1.8} />
          </button>
        </header>

        {callbackError && (
          <div className="border-b border-bearish-red/30 bg-bearish-red/10 px-4 py-2 text-[11px] text-bearish-red">
            {callbackError}
          </div>
        )}

        {session ? <ConnectedState session={session} onDisconnect={disconnect} /> : <StartState onSession={setSession} />}
      </div>
    </div>,
    document.body,
  )
}

export default OnboardingModal
