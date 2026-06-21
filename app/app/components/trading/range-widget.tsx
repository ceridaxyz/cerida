import { useState } from 'react'
import RangeTrading from './range-trading'
import LadderTrading from './ladder-trading'

type Mode = 'single' | 'ladder'

interface Props {
  currentPrice?: number
  oracleId?: string
  oracleExpiry?: number
  underlying?: string
}

export default function RangeWidget(props: Props) {
  const [mode, setMode] = useState<Mode>('single')

  return (
    <div className="flex flex-col h-full">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-0 shrink-0">
        {(['single', 'ladder'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className="px-3 py-1 rounded-[6px] text-[11px] font-semibold capitalize transition-all"
            style={{
              background: mode === m ? 'rgba(128,125,254,0.15)' : 'transparent',
              color:      mode === m ? '#807dfe'                  : 'var(--color-text-quaternary)',
              border:     `1px solid ${mode === m ? 'rgba(128,125,254,0.3)' : 'transparent'}`,
            }}
          >
            {m === 'single' ? 'Range' : 'Ladder'}
          </button>
        ))}
        {mode === 'ladder' && (
          <span className="ml-auto text-[9px] text-text-quaternary uppercase tracking-wider">
            click a band to shift center
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {mode === 'single'
          ? <RangeTrading  {...props} />
          : <LadderTrading {...props} />
        }
      </div>
    </div>
  )
}
