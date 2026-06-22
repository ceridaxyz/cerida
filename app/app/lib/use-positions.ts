import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { CERIDA_PKG, WINDOW_BOOK_ID } from './contracts';
import { getOracles } from './predict-api';

export interface GridPosition {
  objectId: string;
  epochId: number;
  bandIdx: number;
  lower: number | null;   // USD
  upper: number | null;   // USD
  qty: number;            // raw (1e6-scaled dUSDC)
  basis: number;          // USD (basis / 1e6) — cost paid
  payout: number;         // USD (qty / 1e6) — max payout if win
  oracleId: string | null;
  expiry: number | null;  // ms
  settlementPrice: number | null; // USD, null if not settled
  status: 'open' | 'settled';
}

function normalizeId(id: string): string {
  return id.startsWith('0x') ? id : '0x' + id;
}

export function usePositions() {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();

  return useQuery<GridPosition[]>({
    queryKey: ['positions', account?.address],
    enabled: !!account,
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      // 1. Owned BetTicket objects
      const owned = await suiClient.getOwnedObjects({
        owner: account!.address,
        filter: { StructType: `${CERIDA_PKG}::windows::BetTicket` },
        options: { showContent: true },
      });

      if (!owned.data.length) return [];

      // 2. EpochRolled events → epoch_id → oracle_id + strikes
      const events = await suiClient.queryEvents({
        query: { MoveEventType: `${CERIDA_PKG}::windows::EpochRolled` },
        limit: 50,
      });

      type EpochInfo = { oracleId: string; strikes: number[]; expiry: number };
      const epochMap = new Map<number, EpochInfo>();

      for (const ev of events.data) {
        const p = ev.parsedJson as {
          book_id: string;
          epoch_id: string;
          oracle_id: string;
          expiry: string;
          strikes: string[];
        };
        if (normalizeId(p.book_id) === WINDOW_BOOK_ID) {
          epochMap.set(Number(p.epoch_id), {
            oracleId: normalizeId(p.oracle_id),
            strikes: (p.strikes ?? []).map((s) => Number(s) / 1e9),
            expiry: Number(p.expiry),
          });
        }
      }

      // 3. Predict-server oracles for settlement status
      const oracles = await getOracles();
      const oracleMap = new Map(oracles.map((o) => [o.oracle_id, o]));

      // 4. Assemble
      const positions: GridPosition[] = [];
      for (const obj of owned.data) {
        const content = obj.data?.content;
        if (content?.dataType !== 'moveObject') continue;
        const f = content.fields as Record<string, string>;
        const epochId = Number(f['epoch_id']);
        const bandIdx = Number(f['band_idx']);
        const qty     = Number(f['qty']);
        const basis   = Number(f['basis']) / 1e6; // dUSDC → USD

        const epoch   = epochMap.get(epochId);
        const lower   = epoch ? (epoch.strikes[bandIdx] ?? null) : null;
        const upper   = epoch ? (epoch.strikes[bandIdx + 1] ?? null) : null;
        const oracleId = epoch?.oracleId ?? null;
        const oracle   = oracleId ? (oracleMap.get(oracleId) ?? null) : null;

        positions.push({
          objectId: obj.data!.objectId,
          epochId,
          bandIdx,
          lower,
          upper,
          qty,
          basis,
          payout: qty / 1e6,
          oracleId,
          expiry: oracle?.expiry ?? (epoch ? epoch.expiry : null),
          settlementPrice: oracle?.settlement_price != null ? oracle.settlement_price / 1e9 : null,
          status: oracle?.settlement_price != null ? 'settled' : 'open',
        });
      }

      return positions;
    },
  });
}
