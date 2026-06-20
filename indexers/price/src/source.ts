// Upstream price/SVI feed. Today this reads the public Predict indexer; swap
// PREDICT_BASE for a Sui RPC/event source to index the chain directly.

import type { Svi } from './svi.js';

const BASE = process.env.PREDICT_BASE ?? 'https://predict-server.testnet.mystenlabs.com';
const SCALE = 1e9;

export interface Market {
  oracleId: string;
  expiry: number; // ms
  tickSize: number; // $
  minStrike: number; // $
}

export interface Snapshot {
  spot: number;
  forward: number;
  svi: Svi;
  ts: number; // ms (SVI onchain timestamp)
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
}

// Active BTC markets whose expiry is still in the future (the protocol only
// feeds fresh spot/SVI to these), soonest expiry first.
export async function liveMarkets(): Promise<Market[]> {
  const all = await get<
    Array<{
      oracle_id: string;
      underlying_asset: string;
      status: string;
      expiry: number;
      tick_size: number;
      min_strike: number;
    }>
  >('/oracles');
  const now = Date.now();
  return all
    .filter((o) => o.status === 'active' && o.underlying_asset === 'BTC' && o.expiry > now)
    .sort((a, b) => a.expiry - b.expiry)
    .map((o) => ({
      oracleId: o.oracle_id,
      expiry: o.expiry,
      tickSize: o.tick_size / SCALE,
      minStrike: o.min_strike / SCALE,
    }));
}

export async function snapshot(oracleId: string): Promise<Snapshot> {
  const [p, s] = await Promise.all([
    get<{ spot: number; forward: number }>(`/oracles/${oracleId}/prices/latest`),
    get<{
      a: number;
      b: number;
      rho: number;
      rho_negative: boolean;
      m: number;
      m_negative: boolean;
      sigma: number;
      onchain_timestamp: number;
    }>(`/oracles/${oracleId}/svi/latest`),
  ]);
  return {
    spot: p.spot / SCALE,
    forward: p.forward / SCALE,
    svi: {
      a: s.a / SCALE,
      b: s.b / SCALE,
      rho: (s.rho_negative ? -s.rho : s.rho) / SCALE,
      m: (s.m_negative ? -s.m : s.m) / SCALE,
      sigma: s.sigma / SCALE,
    },
    ts: s.onchain_timestamp,
  };
}
