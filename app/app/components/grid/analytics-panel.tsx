import { useState } from 'react';
import type { GridState } from './use-grid-state';
import { computeAnalytics, bandVolume, type Analytics } from './analytics';

type Tab = 'stats' | 'dist' | 'flow';

const TABS: { id: Tab; label: string }[] = [
  { id: 'stats', label: 'Stats' },
  { id: 'dist', label: 'Distribution' },
  { id: 'flow', label: 'Flow' },
];

const mono = { fontFamily: 'var(--font-mono)' } as const;

export default function AnalyticsPanel({ s }: { s: GridState }) {
  const [tab, setTab] = useState<Tab>('stats');
  const a = computeAnalytics(s);

  return (
    <div className="flex flex-col h-full text-[11px]">
      {/* tab bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-2.5 py-1 rounded-[6px] text-[11px] font-medium uppercase tracking-wider transition-colors"
            style={{
              background: tab === t.id ? 'rgba(128,125,254,0.14)' : 'transparent',
              color: tab === t.id ? '#a6a3ff' : 'var(--color-text-quaternary)',
            }}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto pr-1 text-text-quaternary" style={mono}>
          {a.secsToExpiry > 0
            ? `${Math.floor(a.secsToExpiry / 60)}:${String(
                Math.floor(a.secsToExpiry % 60),
              ).padStart(2, '0')}`
            : '0:00'}
        </span>
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {tab === 'stats' && <StatsView a={a} price={s.price} />}
        {tab === 'dist' && <DistView a={a} />}
        {tab === 'flow' && <FlowView a={a} />}
      </div>
    </div>
  );
}

// ── Stats ──────────────────────────────────────────────────────────────────────

function Metric({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface-card/40 rounded-[8px] px-3 py-2">
      <span className="text-[9px] uppercase tracking-wider text-text-quaternary">
        {label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span
          className="text-[14px] font-semibold"
          style={{ ...mono, color: color ?? 'var(--color-text-primary)' }}
        >
          {value}
        </span>
        {sub && (
          <span className="text-[10px] text-text-tertiary" style={mono}>
            {sub}
          </span>
        )}
      </span>
    </div>
  );
}

function StatsView({ a, price }: { a: Analytics; price: number }) {
  const hasLegs = a.totalCost > 0;
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div>
        <p className="text-[9px] uppercase tracking-wider text-text-quaternary mb-1.5">
          Expected move · {a.focused.id === '' ? '' : ''}next settle
        </p>
        <div className="grid grid-cols-3 gap-2">
          <Metric label="Mean" value={`$${a.mean.toFixed(1)}`} />
          <Metric label="1σ move" value={`±$${a.sigma.toFixed(1)}`} color="#807dfe" />
          <Metric label="Implied vol" value={`${a.ivPct.toFixed(0)}%`} />
        </div>
        {/* ±1σ range bar relative to current price */}
        <RangeBar lower={a.lower1} upper={a.upper1} price={price} />
      </div>

      <div>
        <p className="text-[9px] uppercase tracking-wider text-text-quaternary mb-1.5">
          Selection edge
        </p>
        <div className="grid grid-cols-3 gap-2">
          <Metric
            label="Exp. value"
            value={hasLegs ? `${a.ev >= 0 ? '+' : '−'}$${Math.abs(a.ev).toFixed(2)}` : '—'}
            sub={hasLegs ? `${a.evPct >= 0 ? '+' : ''}${a.evPct.toFixed(0)}%` : undefined}
            color={hasLegs ? (a.ev >= 0 ? '#0b9981' : '#f23546') : undefined}
          />
          <Metric
            label="Win prob"
            value={hasLegs ? `${(a.winProb * 100).toFixed(0)}%` : '—'}
          />
          <Metric
            label="Cost"
            value={hasLegs ? `$${a.totalCost.toFixed(2)}` : '—'}
          />
        </div>
        {hasLegs && (
          <p className="text-[10px] text-text-quaternary mt-2 leading-snug">
            {a.ev >= 0
              ? 'Positive expected value — the selection prices in your favour.'
              : 'Negative expected value — house edge exceeds your edge here.'}
          </p>
        )}
      </div>
    </div>
  );
}

// Horizontal bar showing the ±1σ range and where the live price sits inside it.
function RangeBar({
  lower,
  upper,
  price,
}: {
  lower: number;
  upper: number;
  price: number;
}) {
  const pad = (upper - lower) * 0.6 || 8;
  const lo = lower - pad;
  const hi = upper + pad;
  const span = hi - lo || 1;
  const pct = (v: number) => `${((v - lo) / span) * 100}%`;
  return (
    <div className="relative h-7 mt-2">
      <div className="absolute inset-x-0 top-1/2 h-px bg-border-subtle -translate-y-1/2" />
      <div
        className="absolute top-1/2 h-2 rounded-full -translate-y-1/2"
        style={{
          left: pct(lower),
          width: `${((upper - lower) / span) * 100}%`,
          background: 'rgba(128,125,254,0.25)',
          border: '1px solid rgba(128,125,254,0.5)',
        }}
      />
      <div
        className="absolute top-1/2 w-0.5 h-4 -translate-y-1/2 rounded-full"
        style={{ left: pct(price), background: '#0b9981' }}
      />
      <span className="absolute -bottom-0 text-[8px] text-text-quaternary" style={{ ...mono, left: pct(lower) }}>
        ${lower.toFixed(0)}
      </span>
      <span className="absolute -bottom-0 text-[8px] text-text-quaternary -translate-x-full" style={{ ...mono, left: pct(upper) }}>
        ${upper.toFixed(0)}
      </span>
    </div>
  );
}

// ── Distribution ────────────────────────────────────────────────────────────────

function DistView({ a }: { a: Analytics }) {
  const max = Math.max(...a.dist.map((d) => d.prob), 0.01);
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2">
      {a.dist.map((d) => (
        <div key={d.band.idx} className="flex items-center gap-2 h-5">
          <span
            className="text-[9px] text-text-quaternary w-16 shrink-0"
            style={mono}
          >
            ${d.band.lower}–{d.band.upper}
          </span>
          <div className="flex-1 h-3 rounded-[3px] overflow-hidden bg-surface-card/40">
            <div
              className="h-full rounded-[3px] transition-all duration-300"
              style={{
                width: `${(d.prob / max) * 100}%`,
                background: d.inPrice
                  ? 'linear-gradient(90deg,#807dfe,#a6a3ff)'
                  : 'rgba(128,125,254,0.35)',
              }}
            />
          </div>
          <span
            className="text-[9px] w-8 text-right shrink-0"
            style={{ ...mono, color: d.inPrice ? '#a6a3ff' : 'var(--color-text-tertiary)' }}
          >
            {(d.prob * 100).toFixed(0)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Flow ──────────────────────────────────────────────────────────────────────

function FlowView({ a }: { a: Analytics }) {
  const vols = a.dist.map((d) => ({
    d,
    vol: bandVolume(a.focused.id, d.band.idx),
  }));
  const max = Math.max(...vols.map((v) => v.vol), 0.1);
  const total = vols.reduce((s, v) => s + v.vol, 0);
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 text-[9px] uppercase tracking-wider text-text-quaternary border-b border-border-subtle">
        <span>Volume by band</span>
        <span style={mono}>${total.toFixed(1)}k total</span>
      </div>
      <div className="flex flex-col gap-0.5 px-3 py-2 flex-1 overflow-auto">
        {vols.map(({ d, vol }) => (
          <div key={d.band.idx} className="flex items-center gap-2 h-5">
            <span className="text-[9px] text-text-quaternary w-16 shrink-0" style={mono}>
              ${d.band.lower}–{d.band.upper}
            </span>
            <div className="flex-1 h-3 rounded-[3px] overflow-hidden bg-surface-card/40">
              <div
                className="h-full rounded-[3px]"
                style={{
                  width: `${(vol / max) * 100}%`,
                  background: d.inPrice
                    ? 'linear-gradient(90deg,#0b9981,#10c79f)'
                    : 'rgba(11,153,129,0.4)',
                }}
              />
            </div>
            <span className="text-[9px] w-10 text-right shrink-0 text-text-tertiary" style={mono}>
              ${vol.toFixed(1)}k
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
