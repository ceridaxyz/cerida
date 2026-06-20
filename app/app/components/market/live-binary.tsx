import { useEffect, useRef, useState } from 'react';
import {
  getActiveLadder,
  getSnapshot,
  getSurface,
  type Market,
  type SurfaceRow,
} from '../../lib/cerida-api';

const POLL_MS = 4000;

// Live YES/NO ladder — server-derived (cerida-api /surface). No client SVI.
export default function LiveBinary() {
  const [market, setMarket] = useState<Market | null>(null);
  const [rows, setRows] = useState<SurfaceRow[]>([]);
  const [spot, setSpot] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const marketRef = useRef<Market | null>(null);

  useEffect(() => {
    let alive = true;
    getActiveLadder()
      .then((l) => {
        if (!alive) return;
        const m = l[0] ?? null;
        marketRef.current = m;
        setMarket(m);
        if (m) setSpot(m.spot);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!market) return;
    let alive = true;
    const tick = () =>
      Promise.all([getSurface(market.oracleId), getSnapshot(market.oracleId)])
        .then(([s, snap]) => {
          if (!alive) return;
          setRows(s.sort((a, b) => b.strike - a.strike)); // high → low
          if (snap) setSpot(snap.spot);
          setNow(Date.now());
        })
        .catch((e) => alive && setErr(String(e)));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [market]);

  const mono = { fontFamily: 'var(--font-mono)' } as const;

  if (err) return <Center>cerida-api error · {err}</Center>;
  if (!market || rows.length === 0) return <Center>loading live market…</Center>;

  const atm = spot != null ? rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), rows[0]!) : rows[0]!;
  const iv = (atm.iv * 100).toFixed(0);
  const secs = Math.max(0, (market.expiry - now) / 1000);
  const countdown =
    secs >= 3600
      ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
      : `${Math.floor(secs / 60)}m ${Math.floor(secs % 60)}s`;

  return (
    <div className="flex flex-col h-full text-[11px]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary font-semibold">{market.asset}</span>
          {spot != null && (
            <span className="text-bullish-green font-bold" style={mono}>
              ${spot.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded-[4px] text-[9px] font-semibold" style={{ ...mono, background: 'rgba(128,125,254,0.15)', color: '#a6a3ff' }}>
            IV {iv}%
          </span>
        </div>
        <span className="text-text-quaternary" style={mono}>{countdown} · live</span>
      </div>

      <div className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-1 px-3 py-1.5 text-[9px] uppercase tracking-wider text-text-quaternary border-b border-border-subtle shrink-0">
        <span>Strike (≥)</span>
        <span className="text-right">Yes</span>
        <span className="text-right">No</span>
      </div>

      <div className="flex-1 overflow-auto no-scrollbar">
        {rows.map((r) => {
          const isAtm = r.strike === atm.strike;
          return (
            <div
              key={r.strike}
              className="grid grid-cols-[1fr_0.8fr_0.8fr] gap-1 items-center px-3 py-1.5"
              style={{
                borderLeft: isAtm ? '2px solid #807dfe' : '2px solid transparent',
                background: isAtm ? 'rgba(128,125,254,0.06)' : 'transparent',
              }}
            >
              <span className="text-text-secondary" style={mono}>
                ${r.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </span>
              <span className="relative text-right" style={mono}>
                <span className="absolute inset-y-0 right-0 rounded-[2px] pointer-events-none" style={{ width: `${r.yes}%`, background: 'rgba(11,153,129,0.16)' }} />
                <span className="relative text-bullish-green font-semibold">{r.yes.toFixed(0)}¢</span>
              </span>
              <span className="relative text-right" style={mono}>
                <span className="absolute inset-y-0 right-0 rounded-[2px] pointer-events-none" style={{ width: `${r.no}%`, background: 'rgba(242,53,70,0.14)' }} />
                <span className="relative text-bearish-red font-semibold">{r.no.toFixed(0)}¢</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-border-subtle text-[9px] text-text-quaternary shrink-0">
        server-derived · {new Date(atm.ts).toLocaleTimeString()}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full text-[11px] text-text-quaternary uppercase tracking-widest px-3 text-center">
      {children}
    </div>
  );
}
