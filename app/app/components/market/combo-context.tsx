import { createContext, useContext, useState } from 'react'

export interface ComboLeg {
  id:          string        // stable key — prevents duplicate adds
  label:       string        // display: "YES BTC/USD", "$99k–$102k"
  direction:   'yes' | 'no' | 'range'
  prob:        number        // win probability 0–1
  multiplier:  number        // payout multiple
}

interface ComboCtx {
  legs:      ComboLeg[]
  open:      boolean
  mode:      'combo' | 'parlay'
  addLeg:    (leg: ComboLeg) => void
  removeLeg: (id: string) => void
  clear:     () => void
  setOpen:   (v: boolean) => void
  setMode:   (m: 'combo' | 'parlay') => void
}

const ComboContext = createContext<ComboCtx>({
  legs: [], open: false, mode: 'combo',
  addLeg: () => {}, removeLeg: () => {}, clear: () => {}, setOpen: () => {}, setMode: () => {},
})

export const useCombo = () => useContext(ComboContext)

export function ComboProvider({ children }: { children: React.ReactNode }) {
  const [legs, setLegs] = useState<ComboLeg[]>([])
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'combo' | 'parlay'>('combo')

  const addLeg = (leg: ComboLeg) => {
    setLegs(prev => prev.some(l => l.id === leg.id) ? prev : [...prev, leg])
    setOpen(true)
  }
  const removeLeg = (id: string) => setLegs(prev => prev.filter(l => l.id !== id))
  const clear     = () => setLegs([])

  return (
    <ComboContext.Provider value={{ legs, open, mode, addLeg, removeLeg, clear, setOpen, setMode }}>
      {children}
    </ComboContext.Provider>
  )
}
