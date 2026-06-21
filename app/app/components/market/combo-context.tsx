import { createContext, useCallback, useContext, useMemo, useState } from 'react'

// ── ComboLeg (UI + on-chain fields) ──────────────────────────────────────────

export interface ComboLeg {
  // UI display
  id:         string
  label:      string
  direction:  'yes' | 'no' | 'range'
  prob:       number
  multiplier: number

  // On-chain fields (populated when added from a market widget)
  oracle_id?:      string
  asset?:          string   // 'BTC', 'ETH', etc.
  expiry?:         bigint   // unix ms
  strike?:         bigint   // scaled 1e9
  lower_strike?:   bigint   // range only
  higher_strike?:  bigint   // range only
  qty?:            bigint   // 1e6 units
  escrow?:         bigint   // 1e6 USDC to lock
}

// ── State context ─────────────────────────────────────────────────────────────

interface ComboState {
  legs:   ComboLeg[]
  open:   boolean
  mode:   'parlay' | 'portfolio'  // parlay = all-or-nothing; portfolio = tracked independently
  status: 'idle' | 'submitting' | 'submitted' | 'error'
  error?:  string
  result?: { combo_id: string; tx_digest: string }
}

const ComboStateContext = createContext<ComboState>({
  legs: [], open: false, mode: 'parlay', status: 'idle',
})

// ── Dispatch context (stable) ─────────────────────────────────────────────────

interface ComboDispatch {
  addLeg:    (leg: ComboLeg) => void
  removeLeg: (id: string) => void
  clear:     () => void
  setOpen:   (v: boolean) => void
  setMode:   (m: ComboState['mode']) => void
  place:     (coinId: string, owner: string) => Promise<void>
}

const ComboDispatchContext = createContext<ComboDispatch>({
  addLeg: () => {}, removeLeg: () => {}, clear: () => {},
  setOpen: () => {}, setMode: () => {}, place: async () => {},
})

// ── Hooks ─────────────────────────────────────────────────────────────────────

export const useCombo         = () => ({ ...useContext(ComboStateContext), ...useContext(ComboDispatchContext) })
export const useComboDispatch = () => useContext(ComboDispatchContext)

// ── Provider ──────────────────────────────────────────────────────────────────

const COMBO_API = import.meta.env.VITE_COMBO_API_URL ?? 'http://localhost:3001'

export function ComboProvider({ children }: { children: React.ReactNode }) {
  const [legs,   setLegs]   = useState<ComboLeg[]>([])
  const [open,   setOpen]   = useState(false)
  const [mode,   setMode]   = useState<ComboState['mode']>('parlay')
  const [status, setStatus] = useState<ComboState['status']>('idle')
  const [error,  setError]  = useState<string | undefined>()
  const [result, setResult] = useState<ComboState['result'] | undefined>()

  const addLeg    = useCallback((leg: ComboLeg) => {
    setLegs(prev => prev.some(l => l.id === leg.id) ? prev : [...prev, leg])
    setOpen(true)
  }, [])
  const removeLeg = useCallback((id: string) => setLegs(prev => prev.filter(l => l.id !== id)), [])
  const clear     = useCallback(() => { setLegs([]); setResult(undefined); setError(undefined); setStatus('idle') }, [])

  const place = useCallback(async (coinId: string, owner: string) => {
    if (legs.length === 0) return
    setStatus('submitting')
    setError(undefined)
    try {
      const spec = {
        kind: legs.length === 2 ? 'spread' : legs.length === 4 ? 'condor' : 'custom',
        mode,
        legs: legs.map(l => buildLegSpec(l)),
        label: legs.map(l => l.label).join(' + '),
      }
      const res = await fetch(`${COMBO_API}/combos`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ owner, spec, coin_id: coinId }),
      })
      const data = await res.json() as any
      if (!res.ok) throw new Error(data.error ?? 'submit failed')
      setResult({ combo_id: data.combo_id, tx_digest: data.tx_digest })
      setStatus('submitted')
    } catch (e: any) {
      setError(e.message)
      setStatus('error')
    }
  }, [legs, mode])

  const dispatch = useMemo<ComboDispatch>(
    () => ({ addLeg, removeLeg, clear, setOpen, setMode, place }),
    [addLeg, removeLeg, clear, place],
  )

  const state = useMemo<ComboState>(
    () => ({ legs, open, mode, status, error, result }),
    [legs, open, mode, status, error, result],
  )

  return (
    <ComboDispatchContext.Provider value={dispatch}>
      <ComboStateContext.Provider value={state}>
        {children}
      </ComboStateContext.Provider>
    </ComboDispatchContext.Provider>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildLegSpec(leg: ComboLeg) {
  if (leg.direction === 'range') {
    return {
      kind:          'range',
      oracle_id:     leg.oracle_id ?? '',
      asset:         leg.asset ?? 'BTC',
      expiry:        leg.expiry ?? 0n,
      lower_strike:  leg.lower_strike ?? 0n,
      higher_strike: leg.higher_strike ?? 0n,
      qty:           leg.qty ?? 1_000_000n,
      max_cost:      0n,
      escrow:        leg.escrow ?? 1_000_000n,
    }
  }
  return {
    kind:      'binary',
    oracle_id: leg.oracle_id ?? '',
    asset:     leg.asset ?? 'BTC',
    expiry:    leg.expiry ?? 0n,
    strike:    leg.strike ?? 0n,
    is_up:     leg.direction === 'yes',
    qty:       leg.qty ?? 1_000_000n,
    max_cost:  0n,
    escrow:    leg.escrow ?? 1_000_000n,
  }
}
