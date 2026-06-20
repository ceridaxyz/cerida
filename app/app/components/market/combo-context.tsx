import { createContext, useCallback, useContext, useMemo, useState } from 'react'

export interface ComboLeg {
  id:         string
  label:      string
  direction:  'yes' | 'no' | 'range'
  prob:       number
  multiplier: number
}

// ── State context (re-renders subscribers when legs/open/mode change) ─────────

interface ComboState {
  legs: ComboLeg[]
  open: boolean
  mode: 'combo' | 'parlay'
}

const ComboStateContext = createContext<ComboState>({ legs: [], open: false, mode: 'combo' })

// ── Dispatch context (stable — never triggers re-renders in subscribers) ──────

interface ComboDispatch {
  addLeg:    (leg: ComboLeg) => void
  removeLeg: (id: string) => void
  clear:     () => void
  setOpen:   (v: boolean) => void
  setMode:   (m: 'combo' | 'parlay') => void
}

const ComboDispatchContext = createContext<ComboDispatch>({
  addLeg: () => {}, removeLeg: () => {}, clear: () => {}, setOpen: () => {}, setMode: () => {},
})

// ── Hooks ─────────────────────────────────────────────────────────────────────

export const useCombo         = () => ({ ...useContext(ComboStateContext), ...useContext(ComboDispatchContext) })
export const useComboDispatch = () => useContext(ComboDispatchContext)

// ── Provider ──────────────────────────────────────────────────────────────────

export function ComboProvider({ children }: { children: React.ReactNode }) {
  const [legs, setLegs] = useState<ComboLeg[]>([])
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'combo' | 'parlay'>('combo')

  // Stable references — never recreated after mount
  const addLeg    = useCallback((leg: ComboLeg) => {
    setLegs(prev => prev.some(l => l.id === leg.id) ? prev : [...prev, leg])
    setOpen(true)
  }, [])
  const removeLeg = useCallback((id: string) => setLegs(prev => prev.filter(l => l.id !== id)), [])
  const clear     = useCallback(() => setLegs([]), [])

  const dispatch = useMemo<ComboDispatch>(
    () => ({ addLeg, removeLeg, clear, setOpen, setMode }),
    [addLeg, removeLeg, clear],
  )

  const state = useMemo<ComboState>(() => ({ legs, open, mode }), [legs, open, mode])

  return (
    <ComboDispatchContext.Provider value={dispatch}>
      <ComboStateContext.Provider value={state}>
        {children}
      </ComboStateContext.Provider>
    </ComboDispatchContext.Provider>
  )
}
