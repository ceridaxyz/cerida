import { useEffect, useMemo, useState } from 'react';
import { getChartOracle, getLatestPrice } from '../../lib/predict-api';

const mono = { fontFamily: 'var(--font-mono)' } as const;

interface FlowRow {
  id: string;
  time: string;
  side: 'mint' | 'redeem';
  range: string;
  notional: number;
  price: number;
}

interface ProfileRow {
  strike: string;
  oi: number;
  net: number;
  active: boolean;
}

function noise(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function fmtCompact(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return value.toFixed(0);
}

function niceStep(price: number) {
  const target = Math.max(1, price * 0.0035);
  const pow = 10 ** Math.floor(Math.log10(target));
  const mult = [1, 2, 2.5, 5, 10].find((m) => m * pow >= target) ?? 10;
  return mult * pow;
}

function makeRows(spot: number, tick: number) {
  const step = niceStep(spot);
  const base = Math.round(spot / step) * step;
  const bands = Array.from({ length: 13 }, (_, i) => {
    const lower = base + (i - 6) * step;
    return { lower, upper: lower + step, idx: i };
  }).reverse();

  const profile: ProfileRow[] = bands.map((band) => {
    const mid = (band.lower + band.upper) / 2;
    const distance = Math.abs(mid - spot) / step;
    const heat = Math.max(0.12, Math.exp(-distance * 0.45));
    const seeded = noise(tick + band.idx * 7);
    const oi = Math.round((35_000 + seeded * 180_000) * heat);
    const net = Math.round(oi * (noise(tick * 2 + band.idx * 11) - 0.48));
    return {
      strike: `${band.lower.toFixed(0)}-${band.upper.toFixed(0)}`,
      oi,
      net,
      active: spot >= band.lower && spot < band.upper,
    };
  });

  const tape: FlowRow[] = [...bands]
    .sort((a, b) => {
      const av = Math.abs((a.lower + a.upper) / 2 - spot);
      const bv = Math.abs((b.lower + b.upper) / 2 - spot);
      return av - bv;
    })
    .slice(0, 10)
    .map((band, i) => {
      const seeded = noise(tick + band.idx * 13 + i);
      const side = seeded > 0.36 ? 'mint' : 'redeem';
      const secondsAgo = Math.max(1, Math.round((i + 1) * (3 + seeded * 10)));
      const distance = Math.abs((band.lower + band.upper) / 2 - spot) / step;
      return {
        id: `${tick}-${band.idx}-${i}`,
        time: `${secondsAgo}s`,
        side,
        range: `${band.lower.toFixed(0)}-${band.upper.toFixed(0)}`,
        notional: Math.round((1.2 - Math.min(0.9, distance * 0.12)) * (35_000 + seeded * 110_000)),
        price: Math.max(0.02, Math.min(0.95, 0.52 - distance * 0.055 + seeded * 0.08)),
      };
    });

  return { profile, tape };
}

export default function OptionsFlow() {
  const [spot, setSpot] = useState(66_600);
  const [tick, setTick] = useState(() => Math.floor(Date.now() / 10_000));
  const [status, setStatus] = useState<'loading' | 'live' | 'local'>('loading');

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const oracle = await getChartOracle();
        if (!oracle) {
          if (alive) setStatus('local');
          return;
        }
        const latest = await getLatestPrice(oracle.oracle_id);
        if (!alive) return;
        setSpot(latest.spot);
        setTick(Math.floor(latest.timestamp / 10_000));
        setStatus('live');
      } catch {
        if (alive) {
          setTick(Math.floor(Date.now() / 10_000));
          setStatus('local');
        }
      }
    }

    poll();
    const id = window.setInterval(poll, 15_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const { profile, tape } = useMemo(() => makeRows(spot, tick), [spot, tick]);
  const maxOi = Math.max(...profile.map((p) => p.oi), 1);
  const maxAbsNet = Math.max(...profile.map((p) => Math.abs(p.net)), 1);
  const minted = tape.filter((t) => t.side === 'mint').reduce((a, t) => a + t.notional, 0);
  const redeemed = tape.filter((t) => t.side === 'redeem').reduce((a, t) => a + t.notional, 0);
  const totalOi = profile.reduce((a, r) => a + r.oi, 0);
  const netFlow = minted - redeemed;

  return (
    <div className="grid grid-cols-[1.05fr_0.95fr] h-full min-h-0 bg-surface-primary text-[11px]">
      <section className="flex flex-col min-w-0 border-r border-border-subtle">
        <div className="grid grid-cols-3 gap-2 px-3 py-2 border-b border-border-subtle shrink-0">
          <Metric label="Minted" value={`$${fmtCompact(minted)}`} color="#19e6bd" />
          <Metric label="Redeemed" value={`$${fmtCompact(redeemed)}`} color="#f23546" />
          <Metric
            label="Net"
            value={`${netFlow >= 0 ? '+' : '-'}$${fmtCompact(Math.abs(netFlow))}`}
            color={netFlow >= 0 ? '#19e6bd' : '#f23546'}
          />
        </div>

        <div className="flex items-center justify-between px-3 py-1.5 text-[9px] uppercase tracking-wider text-text-quaternary border-b border-border-subtle shrink-0">
          <span>Mint / redeem tape</span>
          <span style={mono}>{status === 'live' ? 'Predict spot' : status === 'loading' ? 'Loading' : 'Local feed'}</span>
        </div>

        <div className="grid grid-cols-[38px_58px_1fr_64px] gap-2 px-3 py-1.5 text-[9px] uppercase tracking-wider text-text-quaternary border-b border-border-subtle shrink-0">
          <span>Time</span>
          <span>Side</span>
          <span>Range</span>
          <span className="text-right">Notional</span>
        </div>

        <div className="flex-1 overflow-auto min-h-0">
          {tape.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[38px_58px_1fr_64px] gap-2 items-center px-3 py-1.5 border-b border-border-subtle/60"
            >
              <span className="text-text-quaternary" style={mono}>{row.time}</span>
              <span
                className="w-fit rounded-[4px] px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
                style={{
                  color: row.side === 'mint' ? '#19e6bd' : '#f23546',
                  background: row.side === 'mint' ? 'rgba(25,230,189,0.1)' : 'rgba(242,53,70,0.1)',
                }}
              >
                {row.side}
              </span>
              <span className="text-text-secondary truncate" style={mono}>${row.range}</span>
              <span className="text-right text-text-tertiary" style={mono}>${fmtCompact(row.notional)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col min-w-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
          <span className="font-semibold text-text-secondary">OI by strike</span>
          <span className="text-text-quaternary" style={mono}>${fmtCompact(totalOi)}</span>
        </div>
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-subtle text-[9px] uppercase tracking-wider text-text-quaternary shrink-0">
          <span style={mono}>Spot ${spot.toFixed(0)}</span>
          <span>Net profile</span>
        </div>

        <div className="flex-1 overflow-auto px-3 py-2 min-h-0">
          {profile.map((row) => {
            const oiPct = (row.oi / maxOi) * 100;
            const netPct = (Math.abs(row.net) / maxAbsNet) * 50;
            return (
              <div key={row.strike} className="grid grid-cols-[72px_1fr_42px] gap-2 items-center h-5">
                <span
                  className="text-[9px] truncate"
                  style={{
                    ...mono,
                    color: row.active ? '#a6a3ff' : 'var(--color-text-quaternary)',
                  }}
                >
                  ${row.strike}
                </span>
                <div className="relative h-3 rounded-[3px] bg-surface-card/50 overflow-hidden">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-white/10" />
                  <div
                    className="absolute inset-y-0 left-0 rounded-[3px]"
                    style={{
                      width: `${oiPct}%`,
                      background: row.active ? 'rgba(128,125,254,0.2)' : 'rgba(255,255,255,0.06)',
                    }}
                  />
                  <div
                    className="absolute top-0 bottom-0"
                    style={{
                      left: row.net >= 0 ? '50%' : `${50 - netPct}%`,
                      width: `${netPct}%`,
                      background: row.net >= 0 ? 'rgba(25,230,189,0.7)' : 'rgba(242,53,70,0.72)',
                    }}
                  />
                </div>
                <span
                  className="text-[9px] text-right"
                  style={{ ...mono, color: row.net >= 0 ? '#19e6bd' : '#f23546' }}
                >
                  {row.net >= 0 ? '+' : '-'}{fmtCompact(Math.abs(row.net))}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[8px] bg-surface-card/40 px-2 py-1.5 min-w-0">
      <span className="text-[9px] uppercase tracking-wider text-text-quaternary truncate">{label}</span>
      <span className="text-[12px] font-semibold truncate" style={{ ...mono, color }}>
        {value}
      </span>
    </div>
  );
}
