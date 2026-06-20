// Client for the local cerida-api (Rust). Values are already de-scaled to
// floats and yes/no/iv are server-derived, so the frontend no longer recomputes
// the SVI surface. Base is env-switchable for local vs hosted.

const BASE =
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_CERIDA_API as string) ||
  'http://localhost:8788';

export interface Svi {
  a: number;
  b: number;
  m: number;
  rho: number;
  sigma: number;
}

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
  no: number; // cents
  iv: number; // implied vol (fraction)
  tenorDays: number;
  ts: number;
}

export interface FlowEvent {
  type: string; // event_type, e.g. RangeMinted / PositionRedeemed
  payload: Record<string, unknown>;
  ts: number;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
}

export async function getMarkets(): Promise<Market[]> {
  const rows = await get<
    Array<{
      asset: string;
      oracle_id: string;
      status: string;
      expiry: number;
      tick_size: number;
      min_strike: number;
      spot: number;
      forward: number;
      ts: number;
    }>
  >('/markets');
  return rows.map((r) => ({
    asset: r.asset,
    oracleId: r.oracle_id,
    status: r.status,
    expiry: r.expiry,
    tickSize: r.tick_size,
    minStrike: r.min_strike,
    spot: r.spot,
    forward: r.forward,
    ts: r.ts,
  }));
}

// /markets is already active + future, soonest expiry first.
export async function getActiveLadder(): Promise<Market[]> {
  const now = Date.now();
  return (await getMarkets()).filter((m) => m.expiry > now).sort((a, b) => a.expiry - b.expiry);
}

export async function getSnapshot(oracleId: string): Promise<Snapshot | null> {
  const r = await get<{ oracle_id: string; spot: number; forward: number; svi: Svi; ts: number } | null>(
    `/markets/${oracleId}/snapshot`,
  );
  if (!r) return null;
  return { oracleId: r.oracle_id, spot: r.spot, forward: r.forward, svi: r.svi, ts: r.ts };
}

export async function getHistory(oracleId: string, limit = 500): Promise<HistPoint[]> {
  const rows = await get<Array<{ ts: number; spot: number; forward: number; svi: Svi }>>(
    `/markets/${oracleId}/history?limit=${limit}`,
  );
  return rows.map((r) => ({ t: r.ts, spot: r.spot, forward: r.forward, svi: r.svi }));
}

// Server-derived yes/no/iv per strike (latest snapshot). No client SVI math.
export async function getSurface(oracleId: string): Promise<SurfaceRow[]> {
  const rows = await get<
    Array<{ strike: number; yes_cents: number; no_cents: number; iv: number; tenor_days: number; ts: number }>
  >(`/markets/${oracleId}/surface`);
  return rows.map((r) => ({
    strike: r.strike,
    yes: r.yes_cents,
    no: r.no_cents,
    iv: r.iv,
    tenorDays: r.tenor_days,
    ts: r.ts,
  }));
}

export async function getFlow(limit = 100, oracleId?: string): Promise<FlowEvent[]> {
  const q = `?limit=${limit}${oracleId ? `&oracle_id=${oracleId}` : ''}`;
  const rows = await get<Array<{ event_type: string; payload: Record<string, unknown>; ts: number }>>(
    `/flow${q}`,
  );
  return rows.map((r) => ({ type: r.event_type, payload: r.payload, ts: r.ts }));
}

export async function getPositions(limit = 100): Promise<FlowEvent[]> {
  const rows = await get<Array<{ event_type: string; payload: Record<string, unknown>; ts: number }>>(
    `/positions?limit=${limit}`,
  );
  return rows.map((r) => ({ type: r.event_type, payload: r.payload, ts: r.ts }));
}

export { BASE as CERIDA_API_BASE };
