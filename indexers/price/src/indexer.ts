// Poll loop: for each live market, derive the yes/no price (cents) from the
// SVI surface and persist it. The strike is fixed per oracle on first sight so
// each row is a consistent market's price over time.

import { liveMarkets, snapshot } from './source.js';
import { yesNoCents } from './svi.js';
import { insertTick } from './db.js';

const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const STRIKE_ROUND = Number(process.env.STRIKE_ROUND ?? 25); // $ grid for the tracked strike

// oracle_id → fixed strike we track yes/no for.
const strikes = new Map<string, number>();

async function pollOnce(): Promise<void> {
  const markets = await liveMarkets();
  await Promise.all(
    markets.map(async (m) => {
      try {
        const snap = await snapshot(m.oracleId);
        const strike =
          strikes.get(m.oracleId) ??
          (() => {
            const k = Math.round(snap.forward / STRIKE_ROUND) * STRIKE_ROUND;
            strikes.set(m.oracleId, k);
            return k;
          })();
        const { yes, no } = yesNoCents(snap.svi, snap.forward, strike);
        await insertTick({
          oracleId: m.oracleId,
          strike,
          ts: snap.ts,
          yes,
          no,
          spot: snap.spot,
          expiry: m.expiry,
        });
      } catch (e) {
        console.warn(`[indexer] ${m.oracleId.slice(0, 10)}… skipped:`, (e as Error).message);
      }
    }),
  );
}

export function startIndexer(): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const t0 = Date.now();
      try {
        await pollOnce();
      } catch (e) {
        console.error('[indexer] poll failed:', (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, Math.max(0, POLL_MS - (Date.now() - t0))));
    }
  };
  loop();
  console.log(`[indexer] polling yes/no every ${POLL_MS}ms`);
  return () => {
    stopped = true;
  };
}
