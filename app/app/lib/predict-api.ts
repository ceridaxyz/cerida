// Minimal client for the DeepBook Predict indexer (testnet). CORS is open, so
// the browser fetches directly. All on-chain values are 1e9-scaled.

const BASE = 'https://predict-server.testnet.mystenlabs.com';
export const SCALE = 1e9;

export interface Oracle {
  predict_id: string;
  oracle_id: string;
  underlying_asset: string;
  expiry: number; // ms
  activated_at: number; // ms
  min_strike: number; // 1e9
  tick_size: number; // 1e9
  status: string;
  settlement_price: number | null;
}

export interface PricePoint {
  t: number; // ms
  spot: number; // $ float
}

export interface LatestPrice {
  spot: number; // $ float
  forward: number; // $ float
  timestamp: number; // ms
}

// Raw SVI from the indexer (1e9-scaled, with sign flags) → float params.
export interface Svi {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
  timestamp: number; // ms
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getOracles(): Promise<Oracle[]> {
  return get<Oracle[]>('/oracles');
}

// Active BTC oracles, soonest expiry first.
export async function getActiveLadder(): Promise<Oracle[]> {
  const all = await getOracles();
  return all
    .filter((o) => o.status === 'active' && o.underlying_asset === 'BTC')
    .sort((a, b) => a.expiry - b.expiry);
}

// Oracle for the price chart: the soonest FUTURE-expiry oracle. The protocol
// only streams fresh spot to the near-term ladder (far/expired oracles go
// stale), so this is the one with live, current BTC prices.
export async function getChartOracle(): Promise<Oracle | null> {
  const all = await getOracles();
  const now = Date.now();
  const live = all
    .filter((o) => o.status === 'active' && o.underlying_asset === 'BTC' && o.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);
  return live[0] ?? null;
}

// Spot price history (ascending by time).
export async function getPriceHistory(oracleId: string, limit = 400): Promise<PricePoint[]> {
  const r = await get<Array<{ checkpoint_timestamp_ms: number; spot: number }>>(
    `/oracles/${oracleId}/prices?limit=${limit}`,
  );
  return r
    .map((x) => ({ t: x.checkpoint_timestamp_ms, spot: x.spot / SCALE }))
    .sort((a, b) => a.t - b.t);
}

export async function getLatestPrice(oracleId: string): Promise<LatestPrice> {
  const r = await get<{ spot: number; forward: number; checkpoint_timestamp_ms: number }>(
    `/oracles/${oracleId}/prices/latest`,
  );
  return { spot: r.spot / SCALE, forward: r.forward / SCALE, timestamp: r.checkpoint_timestamp_ms };
}

export async function getLatestSvi(oracleId: string): Promise<Svi> {
  const r = await get<{
    a: number;
    b: number;
    rho: number;
    rho_negative: boolean;
    m: number;
    m_negative: boolean;
    sigma: number;
    onchain_timestamp: number;
  }>(`/oracles/${oracleId}/svi/latest`);
  return {
    a: r.a / SCALE,
    b: r.b / SCALE,
    rho: (r.rho_negative ? -r.rho : r.rho) / SCALE,
    m: (r.m_negative ? -r.m : r.m) / SCALE,
    sigma: r.sigma / SCALE,
    timestamp: r.onchain_timestamp,
  };
}
