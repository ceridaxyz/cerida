// Adapter that implements the cerida-api contract on top of
// predict-server.testnet.mystenlabs.com. getSurface() is computed client-side
// via svi.ts; getFlow() and getPositions() return empty arrays until a
// cerida-api server is deployed.

import {
  getActiveLadder as predictGetActiveLadder,
  getLatestPrice,
  getLatestSvi,
  getPriceHistory,
} from './predict-api';
import { yesNo, impliedVol, type Svi } from './svi';

export type { Svi };

export interface Market {
  asset: string;
  oracleId: string;
  status: string;
  expiry: number; // ms
  tickSize: number;
  minStrike: number;
  spot: number;
  forward: number;
  ts: number; // ms
}

export interface Snapshot {
  oracleId: string;
  spot: number;
  forward: number;
  svi: Svi;
  ts: number;
}

export interface HistPoint {
  t: number; // ms
  spot: number;
  forward: number;
  svi: Svi;
}

export interface SurfaceRow {
  strike: number;
  yes: number; // cents (0–100)
  no: number;
  iv: number;
  tenorDays: number;
  ts: number;
}

export interface FlowEvent {
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

// ── Markets ───────────────────────────────────────────────────────────────────

export async function getMarkets(): Promise<Market[]> {
  const oracles = await predictGetActiveLadder();
  return Promise.all(
    oracles.map(async (o) => {
      let spot = 0;
      let forward = 0;
      let ts = o.activated_at;
      try {
        const p = await getLatestPrice(o.oracle_id);
        spot = p.spot;
        forward = p.forward;
        ts = p.timestamp;
      } catch {
        // price not yet available
      }
      return {
        asset: o.underlying_asset,
        oracleId: o.oracle_id,
        status: o.status,
        expiry: o.expiry,
        tickSize: o.tick_size / 1e9,
        minStrike: o.min_strike / 1e9,
        spot,
        forward,
        ts,
      };
    }),
  );
}

export async function getActiveLadder(): Promise<Market[]> {
  const now = Date.now();
  return (await getMarkets()).filter((m) => m.expiry > now).sort((a, b) => a.expiry - b.expiry);
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

export async function getSnapshot(oracleId: string): Promise<Snapshot | null> {
  try {
    const [price, svi] = await Promise.all([getLatestPrice(oracleId), getLatestSvi(oracleId)]);
    return {
      oracleId,
      spot: price.spot,
      forward: price.forward,
      svi,
      ts: price.timestamp,
    };
  } catch {
    return null;
  }
}

// ── History ───────────────────────────────────────────────────────────────────

export async function getHistory(oracleId: string, limit = 500): Promise<HistPoint[]> {
  const prices = await getPriceHistory(oracleId, limit);
  let svi: Svi = { a: 0, b: 0, rho: 0, m: 0, sigma: 0.001 };
  try {
    svi = await getLatestSvi(oracleId);
  } catch {
    // svi not yet published
  }
  return prices.map((p) => ({ t: p.t, spot: p.spot, forward: p.spot, svi }));
}

// ── Surface ───────────────────────────────────────────────────────────────────
// Computed client-side from the latest SVI + forward price. Builds a ladder of
// strikes around the forward price using the oracle's tick size.

export async function getSurface(oracleId: string): Promise<SurfaceRow[]> {
  const snapshot = await getSnapshot(oracleId);
  if (!snapshot) return [];

  const { forward, svi, ts } = snapshot;
  const now = Date.now();

  // Fetch oracle metadata for tick size / min strike via the markets list
  const markets = await getMarkets();
  const market = markets.find((m) => m.oracleId === oracleId);
  const tickSize = market?.tickSize ?? 1;
  const minStrike = market?.minStrike ?? Math.floor((forward * 0.5) / tickSize) * tickSize;
  const expiry = market?.expiry ?? now + 24 * 60 * 60 * 1000;
  const tYears = Math.max((expiry - now) / (365.25 * 24 * 60 * 60 * 1000), 1 / (365.25 * 24));
  const tenorDays = tYears * 365.25;

  // Generate ~100 strikes centred on the forward
  const strikesBelow = 50;
  const strikesAbove = 50;
  const startStrike = Math.max(
    minStrike,
    Math.floor((forward - strikesBelow * tickSize) / tickSize) * tickSize,
  );

  const rows: SurfaceRow[] = [];
  for (let i = 0; i <= strikesBelow + strikesAbove; i++) {
    const strike = startStrike + i * tickSize;
    if (strike < minStrike) continue;
    const { yes, no } = yesNo(svi, forward, strike);
    const iv = impliedVol(svi, forward, strike, tYears);
    rows.push({
      strike,
      yes: Math.round(yes * 100 * 100) / 100,
      no: Math.round(no * 100 * 100) / 100,
      iv,
      tenorDays,
      ts,
    });
  }

  return rows;
}

// ── Flow / Positions ──────────────────────────────────────────────────────────
// Not available on predict-server; return empty until cerida-api is deployed.

export async function getFlow(_limit = 100, _oracleId?: string): Promise<FlowEvent[]> {
  return [];
}

export async function getPositions(_limit = 100): Promise<FlowEvent[]> {
  return [];
}

export const CERIDA_API_BASE = 'https://predict-server.testnet.mystenlabs.com';
