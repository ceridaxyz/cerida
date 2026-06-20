import { useMemo, useState } from 'react';
import type { GridState } from './use-grid-state';
import { computeAnalytics } from './analytics';

// ── Combo math ────────────────────────────────────────────────────────────────

const BASE_EDGE = 0.06;

// Edge discount grows with each added leg (capped at 1%)
const comboEdge = (n: number) => Math.max(0.01, BASE_EDGE - (n - 1) * 0.015);

interface ComboResult {
  valid: boolean;
  conflict: string | null;   // error if two legs share an epoch
  pCombo: number;            // combined probability
  mCombo: number;            // boosted multiplier
  mRaw: number;              // what multiplier would be without boost
  boostPct: number;          // edge savings %
  payout: number;            // stake × mCombo
}

function calcCombo(legs: GridState['legsArr'], stake: number): ComboResult {
  if (legs.length < 2) {
    return { valid: false, conflict: 'Select 2+ legs to build a combo', pCombo: 0, mCombo: 0, mRaw: 0, boostPct: 0, payout: 0 };
  }
  // Check for epoch conflicts (same epoch = mutually exclusive, can't both win)
  const epochIds = legs.map(l => l.epochId);
  const seen = new Set<string>();
  for (const id of epochIds) {
    if (seen.has(id)) {
      return { valid: false, conflict: 'Legs in the same epoch are mutually exclusive — pick different epochs', pCombo: 0, mCombo: 0, mRaw: 0, boostPct: 0, payout: 0 };
    }
    seen.add(id);
  }
  // p_i derived from the locked-in multiplier: m_i = (1-EDGE)/p_i → p_i = (1-EDGE)/m_i
  const pCombo  = legs.reduce((acc, l) => acc * ((1 - BASE_EDGE) / l.multiplier), 1);
  const mRaw    = (1 - BASE_EDGE) / pCombo;              // no discount
  const edge    = comboEdge(legs.length);
  const mCombo  = (1 - edge) / pCombo;                   // with boost
  const boostPct = (BASE_EDGE - edge) * 100;
  return { valid: true, conflict: null, pCombo, mCombo, mRaw, boostPct, payout: stake * mCombo };
}

// Parlay chain: stake rolls into next leg on win
function parlayChain(legs: GridState['legsArr'], stake: number) {
  let running = stake;
  return legs.map(l => {
    const prev  = running;
    running = running * l.multiplier;
    return { leg: l, stakeIn: prev, payoutOut: running };
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] uppercase tracking-wider text-text-quaternary">{label}</span>
      <span
        className="text-[12px] font-semibold"
        style={{ fontFamily: 'var(--font-mono)', color: color ?? 'var(--color-text-primary)' }}
      >
        {value}
      </span>
    </div>
  );
}

function ModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-1 text-[10px] font-semibold uppercase tracking-widest rounded-[6px] transition-colors ${
        active
          ? 'bg-brand-violet/20 text-brand-violet border border-brand-violet/30'
          : 'text-text-quaternary hover:text-text-secondary border border-transparent'
      }`}
    >
      {label}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Mode = 'legs' | 'combo' | 'parlay';

export default function OrderSummary({ s }: { s: GridState }) {
  const { legsArr } = s;
  const [mode,     setMode]     = useState<Mode>('legs');
  const [slipOpen, setSlipOpen] = useState(false);
  const [slip,     setSlip]     = useState('1.0');
  const [legsOpen, setLegsOpen] = useState(false);

  const stake    = s.stake;
  const setStake = (v: string) => s.setStake(Math.max(0, parseFloat(v) || 0));
  const hasLegs  = legsArr.length > 0;
  const a        = computeAnalytics(s);

  // Combo / parlay derived data
  const combo  = useMemo(() => calcCombo(legsArr, stake), [legsArr, stake]);
  const chain  = useMemo(() => parlayChain(legsArr, stake), [legsArr, stake]);

  // Legs mode stats
  const totalCost  = stake * legsArr.length;
  const bestPayout = legsArr.reduce((m, l) => Math.max(m, stake * l.multiplier), 0);

  // Group legs for display
  const grouped = useMemo(() => {
    const map = new Map<string, { lower: number; upper: number; epochId: string; mult: number; count: number }>();
    for (const l of legsArr) {
      const k = `${l.epochId}:${l.lower}-${l.upper}`;
      const g = map.get(k) ?? { lower: l.lower, upper: l.upper, epochId: l.epochId, mult: l.multiplier, count: 0 };
      g.count++;
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => b.lower - a.lower);
  }, [legsArr]);

  const buttonLabel = mode === 'combo' ? 'Place Combo' : mode === 'parlay' ? 'Place Parlay' : 'Confirm Order';
  const buttonActive = hasLegs && (mode === 'legs' || (mode !== 'legs' && combo.valid));

  return (
    <div className="flex flex-col h-full text-[11px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <span className="text-text-secondary font-semibold">Order</span>
        <span className="text-text-quaternary">{legsArr.length} leg{legsArr.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-2.5 flex-1 overflow-auto no-scrollbar">

        {/* Mode toggle */}
        <div className="flex gap-1">
          <ModeTab label="Legs"   active={mode === 'legs'}   onClick={() => setMode('legs')} />
          <ModeTab label="Combo"  active={mode === 'combo'}  onClick={() => setMode('combo')} />
          <ModeTab label="Parlay" active={mode === 'parlay'} onClick={() => setMode('parlay')} />
        </div>

        {/* Stake */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-quaternary">
            {mode === 'combo' || mode === 'parlay' ? 'Stake' : 'Stake / band'}
          </span>
          <div className="flex items-center bg-surface-card rounded-[6px] px-2 py-1 border border-border-subtle gap-1 w-24">
            <span className="text-text-quaternary text-[11px]">$</span>
            <input
              type="number" min={0} value={String(stake)}
              onChange={e => setStake(e.target.value)}
              className="flex-1 bg-transparent text-[12px] font-medium text-text-primary outline-none w-0"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>
        </div>
        <div className="flex gap-1">
          {[5, 10, 25, 50].map(v => (
            <button
              key={v}
              onClick={() => s.setStake(v)}
              className="flex-1 py-1 rounded-[5px] text-[10px] font-medium transition-colors"
              style={{
                background: stake === v ? 'var(--color-surface-hover)' : 'var(--color-surface-card)',
                color: stake === v ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                border: `1px solid ${stake === v ? 'var(--color-border-default)' : 'var(--color-border-subtle)'}`,
              }}
            >
              ${v}
            </button>
          ))}
        </div>

        {/* ── LEGS mode ── */}
        {mode === 'legs' && (
          <>
            {hasLegs && (
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-0.5 bg-surface-card/40 rounded-[8px] px-2.5 py-1.5">
                  <span className="text-[9px] uppercase tracking-wider text-text-quaternary">Exp. value</span>
                  <span className="text-[13px] font-bold" style={{ fontFamily: 'var(--font-mono)', color: a.ev >= 0 ? '#0b9981' : '#f23546' }}>
                    {a.ev >= 0 ? '+$' : '−$'}{Math.abs(a.ev).toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 bg-surface-card/40 rounded-[8px] px-2.5 py-1.5">
                  <span className="text-[9px] uppercase tracking-wider text-text-quaternary">Win prob</span>
                  <span className="text-[13px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                    {(a.winProb * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            )}
            <Stat label="Total cost"  value={`$${totalCost.toFixed(2)}`} />
            <Stat label="Best payout" value={`$${bestPayout.toFixed(2)}`} color="#0b9981" />
            <Stat label="Max loss"    value={`-$${totalCost.toFixed(2)}`} color="#f23546" />
          </>
        )}

        {/* ── COMBO mode ── */}
        {mode === 'combo' && (
          <>
            {!combo.valid ? (
              <div className="rounded-[8px] px-3 py-2.5 text-[10px] leading-relaxed"
                style={{ background: 'rgba(242,53,70,0.08)', border: '1px solid rgba(242,53,70,0.2)', color: '#f23546' }}>
                {combo.conflict}
              </div>
            ) : (
              <>
                {/* Leg chain */}
                <div className="flex flex-col gap-0.5">
                  {legsArr.map((l, i) => (
                    <div key={l.key}>
                      <div className="flex items-center justify-between px-2.5 py-1.5 rounded-[6px]"
                        style={{ background: 'var(--color-surface-card)' }}>
                        <span className="text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                          ${l.lower}–{l.upper}
                        </span>
                        <span className="text-text-quaternary text-[10px]" style={{ fontFamily: 'var(--font-mono)' }}>
                          {((1 - BASE_EDGE) / l.multiplier * 100).toFixed(1)}% · {l.multiplier.toFixed(1)}×
                        </span>
                      </div>
                      {i < legsArr.length - 1 && (
                        <div className="flex justify-center my-0.5 text-text-quaternary">×</div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Combo stats */}
                <div className="border-t border-border-subtle pt-2 flex flex-col gap-1.5">
                  <Stat label="Combined prob" value={`${(combo.pCombo * 100).toFixed(2)}%`} />
                  <Stat label="Combo mult"    value={`${combo.mCombo.toFixed(1)}×`} color="#807dfe" />
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-text-quaternary">Edge boost</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-[4px] font-semibold"
                      style={{ background: 'rgba(11,153,129,0.15)', color: '#0b9981', fontFamily: 'var(--font-mono)' }}>
                      -{combo.boostPct.toFixed(1)}% edge
                    </span>
                  </div>
                  <Stat label="Cost"   value={`$${stake.toFixed(2)}`} />
                  <Stat label="Payout" value={`$${combo.payout.toFixed(2)}`} color="#0b9981" />
                  <Stat label="Max loss" value={`-$${stake.toFixed(2)}`} color="#f23546" />
                </div>
              </>
            )}
          </>
        )}

        {/* ── PARLAY mode ── */}
        {mode === 'parlay' && (
          <>
            {legsArr.length < 2 ? (
              <div className="rounded-[8px] px-3 py-2.5 text-[10px] leading-relaxed"
                style={{ background: 'rgba(242,53,70,0.08)', border: '1px solid rgba(242,53,70,0.2)', color: '#f23546' }}>
                Select 2+ legs to build a parlay
              </div>
            ) : (
              <>
                {/* Sequential compounding chain */}
                <div className="flex flex-col gap-0">
                  {chain.map(({ leg, stakeIn, payoutOut }, i) => (
                    <div key={leg.key}>
                      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[6px]"
                        style={{ background: 'var(--color-surface-card)' }}>
                        <div className="flex-1 min-w-0">
                          <div className="text-text-secondary" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                            ${leg.lower}–{leg.upper}
                          </div>
                          <div className="text-text-quaternary" style={{ fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                            {leg.multiplier.toFixed(1)}×
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                            ${stakeIn.toFixed(2)}
                          </div>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#0b9981' }}>
                            → ${payoutOut.toFixed(2)}
                          </div>
                        </div>
                      </div>
                      {i < chain.length - 1 && (
                        <div className="flex items-center gap-2 px-3 py-0.5">
                          <div className="flex-1 border-l border-dashed border-border-default ml-3" style={{ height: 10 }} />
                          <span className="text-[9px] text-text-quaternary">rolls into</span>
                          <div className="flex-1 border-r border-dashed border-border-default mr-3" style={{ height: 10 }} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Parlay totals */}
                <div className="border-t border-border-subtle pt-2 flex flex-col gap-1.5">
                  <Stat label="At risk"       value={`$${stake.toFixed(2)}`} />
                  <Stat label="Final payout"  value={`$${chain[chain.length-1]!.payoutOut.toFixed(2)}`} color="#0b9981" />
                  <Stat label="All-win prob"  value={`${(combo.pCombo * 100).toFixed(2)}%`} />
                  <Stat label="Implied mult"  value={`${(chain[chain.length-1]!.payoutOut / stake).toFixed(1)}×`} color="#807dfe" />
                </div>
              </>
            )}
          </>
        )}

        {/* Slippage */}
        <button
          onClick={() => setSlipOpen(o => !o)}
          className="flex items-center justify-between text-[10px] text-text-quaternary hover:text-text-tertiary transition-colors mt-1"
        >
          <span className="uppercase tracking-wider">Slippage tolerance</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{slip}%</span>
        </button>
        {slipOpen && (
          <div className="flex items-center bg-surface-card rounded-[6px] px-2 py-1 border border-border-subtle">
            <input type="number" min={0} step={0.1} value={slip}
              onChange={e => setSlip(e.target.value)}
              className="flex-1 bg-transparent text-[12px] text-text-primary outline-none w-0"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
            <span className="text-text-quaternary text-[11px]">%</span>
          </div>
        )}

        {/* Leg list (legs mode only) */}
        {mode === 'legs' && hasLegs && (
          <div className="border-t border-border-subtle pt-2 mt-1 flex flex-col gap-1">
            <button
              onClick={() => setLegsOpen(o => !o)}
              className="flex items-center justify-between text-[10px] text-text-quaternary hover:text-text-tertiary transition-colors"
            >
              <span className="uppercase tracking-wider">
                {grouped.length} band{grouped.length === 1 ? '' : 's'} · {legsArr.length} leg{legsArr.length === 1 ? '' : 's'}
              </span>
              <span>{legsOpen ? 'Hide' : 'Show'}</span>
            </button>
            {grouped.map(g => (
              <div key={`${g.epochId}:${g.lower}-${g.upper}`}
                className="flex items-center justify-between text-[10px]">
                <span className="text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${g.lower}–{g.upper}
                  {g.count > 1 && <span className="text-text-quaternary"> ×{g.count}</span>}
                </span>
                <span className="text-text-quaternary" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${(stake * g.count).toFixed(2)} → ${(stake * g.mult * g.count).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-3 pb-3 pt-1 shrink-0 flex flex-col gap-2">
        {hasLegs && (
          <button
            onClick={s.clearLegs}
            className="text-[10px] text-text-quaternary hover:text-bearish-red transition-colors self-end uppercase tracking-wider"
          >
            Clear all
          </button>
        )}
        <button
          disabled={!buttonActive}
          className="w-full py-2 text-[12px] font-semibold rounded-[8px] transition-all"
          style={{
            background: buttonActive ? '#807dfe' : 'var(--color-surface-hover)',
            color: buttonActive ? '#fff' : 'var(--color-text-quaternary)',
            cursor: buttonActive ? 'pointer' : 'not-allowed',
            opacity: buttonActive ? 1 : 0.6,
          }}
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}
