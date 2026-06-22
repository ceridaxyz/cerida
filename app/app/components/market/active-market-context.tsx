import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getActiveLadder, type Market } from '../../lib/cerida-api'

interface ActiveMarketCtx {
  activeMarket: Market | null
  setActiveMarket: (m: Market) => void
}

const ActiveMarketContext = createContext<ActiveMarketCtx>({
  activeMarket: null,
  setActiveMarket: () => {},
})

export function ActiveMarketProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Market | null>(null)

  const { data: ladder } = useQuery({
    queryKey: ['activeLadder'],
    queryFn: getActiveLadder,
    staleTime: 30_000,
  })

  // Default to first market once ladder loads, but only if user hasn't picked one
  useEffect(() => {
    if (!selected && ladder?.[0]) setSelected(ladder[0])
  }, [ladder, selected])

  return (
    <ActiveMarketContext.Provider value={{ activeMarket: selected, setActiveMarket: setSelected }}>
      {children}
    </ActiveMarketContext.Provider>
  )
}

export function useActiveMarket() {
  return useContext(ActiveMarketContext)
}
