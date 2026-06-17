import { useEffect, useRef, useState } from 'react';
import {
  getActiveLadder,
  getLatestPrice,
  getLatestSvi,
  type Oracle,
  type LatestPrice,
  type Svi,
} from '../../lib/predict-api';
import { yesNo, impliedVol } from '../../lib/svi';

const MS_YEAR = 365 * 24 * 60 * 60 * 1000;
const POLL_MS = 5000;
const NUM_STRIKES = 11;

// Live YES/NO ladder derived from the Predict indexer's SVI surface (testnet).
export default function LiveBinary() {
  const [oracle, setOracle] = useState<Oracle | null>(null);
  const [price, setPrice] = useState<LatestPrice | null>(null);
  const [svi, setSvi] = useState<Svi | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const oracleRef = useRef<Oracle | null>(null);

  // Pick the soonest-expiry active BTC oracle once.
  useEffect(() => {
    let alive = true;
    getActiveLadder()
      .then((ladder) => {
        if (!alive) return;
        // Soonest expiry still in the future (the indexer keeps expired-but-
        // unsettled oracles as "active").
        const future = ladder.filter((o) => o.expiry > Date.now());
        const o = future[0] ?? ladder[ladder.length - 1] ?? null;
        oracleRef.current = o;
        setOracle(o);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Poll price + SVI for the chosen oracle.
  useEffect(() => {
    if (!oracle) return;
    let alive = true;
    const tick = () => {
      Promise.all([getLatestPrice(oracle.oracle_id), getLatestSvi(oracle.oracle_id)])
        .then(([p, s]) => {
          if (!alive) return;
          setPrice(p);
          setSvi(s);
          setNow(Date.now());
        })
        .catch((e) => alive && setErr(String(e)));
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [oracle]);

  if (err) {
    return <Center>indexer error · {err}</Center>;
  }
  if (!oracle || !price || !svi) {
    return <Center>loading live BTC market…</Center>;
  }

  const tYears = Math.max((oracle.expiry - svi.timestamp) / MS_YEAR, 1e-9);
  const iv = impliedVol(svi, price.forward, price.forward, tYears) * 100;
  const secs = Math.max(0, (oracle.expiry - now) / 1000);
  const countdown =
    secs >= 3600
      ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
      : `${Math.floor(secs / 60)}m ${Math.floor(secs % 60)}s`;

  // Strike ladder around the forward (display step ≈ 0.1% of price, on a round grid).
  const step = Math.max(50, Math.round((price.forward * 0.0015) / 50) * 50);
  const base = Math.round(price.forward / step) * step;
  const strikes = Array.from({ length: NUM_STRIKES }, (_, i) =>
    base + (Math.floor(NUM_STRIKES / 2) - i) * step,
  );

  const mono = { fontFamily: 'var(--font-mono)' } as const;

  return (
    <div className="flex flex-col h-full text-[11px]">
      {/* header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary font-semibold">BTC</span>
          <span className="text-bullish-green font-bold" style={mono}>
            ${price.spot.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
          <span className="px-1.5 py-0.5 rounded-[4px] text-[9px] font-semibold" style={{ ...mono, background: 'rgba(128,125,254,0.15)', color: '#a6a3ff' }}>
            IV {iv.toFixed(0)}%
          </span>
        </div>
        <span className="text-text-quaternary" style={mono}>
          {countdown} · live
        </span>
      </div>

      {/* column headers */}
      <div className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-1 px-3 py-1.5 text-[9px] uppercase tracking-wider text-text-quaternary border-b border-border-subtle shrink-0">
        <span>Strike (≥)</span>
        <span className="text-right">Yes</span>
        <span className="text-right">No</span>
      </div>

      <div className="flex-1 overflow-auto">
        {strikes.map((k) => {
          const { yes, no } = yesNo(svi, price.forward, k);
          const atm = Math.abs(k - price.forward) < step / 2;
          return (
            <div
              key={k}
              className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-1 items-center px-3 py-1.5"
              style={{
                borderLeft: atm ? '2px solid #807dfe' : '2px solid transparent',
                background: atm ? 'rgba(128,125,254,0.06)' : 'transparent',
              }}
            >
              <span className="text-text-secondary" style={mono}>
                ${k.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </span>
              <span className="relative text-right" style={mono}>
                <span
                  className="absolute inset-y-0 right-0 rounded-[2px] pointer-events-none"
                  style={{ width: `${yes * 100}%`, background: 'rgba(11,153,129,0.16)' }}
                />
                <span className="relative text-bullish-green font-semibold">{(yes * 100).toFixed(0)}¢</span>
              </span>
              <span className="relative text-right" style={mono}>
                <span
                  className="absolute inset-y-0 right-0 rounded-[2px] pointer-events-none"
                  style={{ width: `${no * 100}%`, background: 'rgba(242,53,70,0.14)' }}
                />
                <span className="relative text-bearish-red font-semibold">{(no * 100).toFixed(0)}¢</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-border-subtle text-[9px] text-text-quaternary shrink-0">
        YES/NO derived from SVI · {new Date(svi.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full text-[11px] text-text-quaternary uppercase tracking-widest">
      {children}
    </div>
  );
}
