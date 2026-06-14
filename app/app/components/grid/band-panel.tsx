import { IconPlus, IconCheck } from '@tabler/icons-react';
import type { GridState } from './use-grid-state';

export default function BandPanel({ s }: { s: GridState }) {
  const epoch =
    s.epochs.find((e) => e.id === s.focusedEpoch) ?? s.epochs[0]!;

  // High price at top → low at bottom.
  const rows = [...s.bands].sort((a, b) => b.lower - a.lower);

  return (
    <div className="flex flex-col h-full text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <span className="text-text-secondary font-semibold">Bands</span>
        <span className="text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
          {epoch.id === s.currentEpochId ? 'NOW' : ''}{' '}
          {new Date(epoch.start).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>

      {/* column headers */}
      <div className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.8fr_auto] gap-1 px-3 py-1.5 text-[9px] uppercase tracking-wider text-text-quaternary border-b border-border-subtle shrink-0">
        <span>Range</span>
        <span className="text-right">Prob</span>
        <span className="text-right">Mult</span>
        <span className="text-right">Cost</span>
        <span className="w-5" />
      </div>

      <div className="flex-1 overflow-auto">
        {rows.map((band) => {
          const cell = s.cellFor(epoch, band);
          const key = `${epoch.id}:${band.idx}`;
          const selected = s.hasLeg(key);
          const isPriceBand = s.price >= band.lower && s.price < band.upper;
          return (
            <button
              key={band.idx}
              onClick={() => s.toggleLeg(epoch, band)}
              className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.8fr_auto] gap-1 items-center w-full px-3 py-1.5 text-left transition-colors hover:bg-surface-hover/40"
              style={{
                background: selected ? 'rgba(128,125,254,0.12)' : 'transparent',
                borderLeft: isPriceBand
                  ? '2px solid #807dfe'
                  : '2px solid transparent',
              }}
            >
              <span
                className="text-text-secondary"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                ${band.lower}–{band.upper}
              </span>
              <span className="text-right text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                {(cell.prob * 100).toFixed(0)}%
              </span>
              <span className="text-right text-bullish-green" style={{ fontFamily: 'var(--font-mono)' }}>
                {cell.multiplier.toFixed(1)}x
              </span>
              <span className="text-right text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                ${cell.cost.toFixed(2)}
              </span>
              <span
                className="flex items-center justify-center w-5 h-5 rounded-[4px]"
                style={{
                  background: selected ? '#807dfe' : 'rgba(255,255,255,0.06)',
                  color: selected ? '#fff' : 'var(--color-text-tertiary)',
                }}
              >
                {selected ? <IconCheck size={12} stroke={2.5} /> : <IconPlus size={12} stroke={2.5} />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
