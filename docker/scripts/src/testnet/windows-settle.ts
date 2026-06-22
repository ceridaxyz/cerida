// Window bet (grid trading) — settle + claim side.
//
// Run AFTER the oracle expires (i.e. after windowEpochExpiry in testnet.json).
//
// Steps:
//   1. windows::settle_epoch   (permissionless — records winning band)
//   2. vault::execute_epoch_payout  (keeper — redeems Predict position → vault.settlements)
//   3. vault::claim_window_bet (user — receives payout or $0 if wrong band)
//
// Run: bun src/testnet/windows-settle.ts

import { Transaction } from '@mysten/sui/transactions';
import {
  c, kp, ADDR,
  PREDICT_OBJ, DUSDC_TYPE, CLOCK,
  DUSDC_SCALE, PRICE_SCALE,
  loadManifest, type Manifest,
} from './config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

type TxResult = Awaited<ReturnType<typeof c.signAndExecuteTransaction>>;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion: ${msg}`);
}

async function exec(tx: Transaction, label: string): Promise<TxResult> {
  tx.setGasBudget(2_000_000_000n);
  process.stdout.write(`  → ${label}… `);
  const r = await c.signAndExecuteTransaction({
    transaction: tx, signer: kp,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (r.effects?.status.status !== 'success') {
    console.log('FAILED');
    throw new Error(`${label} failed: ${JSON.stringify(r.effects?.status)}`);
  }
  await c.waitForTransaction({ digest: r.digest });
  console.log(`✓  (${r.digest})`);
  return r;
}

function findEvent(r: TxResult, typeSuffix: string): any {
  return (r.events ?? []).find((e: any) => String(e.type).includes(typeSuffix));
}

// ── Settlement flow ───────────────────────────────────────────────────────────

async function settleEpoch(
  ceridaPkg: string, windowBookId: string,
  oracleId: string, epochId: number,
): Promise<{ winningBand: number | null; settlementPrice: bigint }> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::windows::settle_epoch`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(windowBookId),
      tx.object(oracleId),
      tx.pure.u64(epochId),
    ],
  });
  const r = await exec(tx, `windows::settle_epoch epoch=${epochId}`);
  const ev = findEvent(r, '::windows::EpochSettled');
  assert(ev?.parsedJson, 'EpochSettled event missing');

  const settlementPrice = BigInt((ev.parsedJson as any).settlement_price ?? 0);
  const winningBandRaw  = (ev.parsedJson as any).winning_band;
  const winningBand     = winningBandRaw?.Some !== undefined
    ? Number(winningBandRaw.Some)
    : winningBandRaw !== null && winningBandRaw !== undefined
      ? Number(winningBandRaw)
      : null;

  return { winningBand, settlementPrice };
}

async function executeEpochPayout(
  ceridaPkg: string, vaultId: string, managerId: string,
  windowBookId: string, oracleId: string, epochId: number,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::vault::execute_epoch_payout`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.object(managerId),
      tx.object(PREDICT_OBJ),
      tx.object(oracleId),
      tx.object(windowBookId),
      tx.pure.u64(epochId),
      tx.object(CLOCK),
    ],
  });
  await exec(tx, `vault::execute_epoch_payout epoch=${epochId}`);
}

async function claimWindowBet(
  ceridaPkg: string, vaultId: string,
  windowBookId: string, betTicketId: string,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::vault::claim_window_bet`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.object(windowBookId),
      tx.object(betTicketId),
    ],
  });
  const r = await exec(tx, 'vault::claim_window_bet');
  const ev = findEvent(r, '::vault::WindowBetClaimed');
  return BigInt((ev?.parsedJson as any)?.payout ?? 0);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const m = loadManifest();
  assert(m.ceridaPkg,           'ceridaPkg missing');
  assert(m.vaultId,             'vaultId missing');
  assert(m.managerId,           'managerId missing');
  assert(m.windowBookId,        'windowBookId missing — run windows-open.ts first');
  assert(m.windowOracleId,      'windowOracleId missing — run windows-open.ts first');
  assert(m.windowBetTicketId,   'windowBetTicketId missing — run windows-open.ts first');
  assert(m.windowEpochId !== undefined, 'windowEpochId missing — run windows-open.ts first');
  assert(m.windowEpochExpiry,   'windowEpochExpiry missing — run windows-open.ts first');

  const { ceridaPkg, vaultId, managerId,
          windowBookId, windowOracleId, windowBetTicketId,
          windowEpochId, windowEpochExpiry } = m as Required<Manifest>;

  const now = Date.now();
  if (now < windowEpochExpiry) {
    const remaining = Math.ceil((windowEpochExpiry - now) / 60_000);
    console.error(`\n⚠  Oracle hasn't expired yet. Wait ${remaining} more minute(s).`);
    console.error(`   Expiry: ${new Date(windowEpochExpiry).toISOString()}`);
    process.exit(1);
  }

  console.log('\n═══ Cerida Window Bet (Grid) — Settle ═══');
  console.log(`Address:      ${ADDR}`);
  console.log(`windowBook:   ${windowBookId}`);
  console.log(`epoch:        ${windowEpochId}`);
  console.log(`betTicket:    ${windowBetTicketId}`);
  console.log(`Expired at:   ${new Date(windowEpochExpiry).toISOString()}`);

  // 1. Settle epoch (permissionless)
  console.log('\n─── Settle Epoch ───');
  const { winningBand, settlementPrice } = await settleEpoch(
    ceridaPkg, windowBookId, windowOracleId, windowEpochId,
  );
  const priceUsd = Number(settlementPrice) / Number(PRICE_SCALE);
  console.log(`  settlement_price = $${priceUsd.toFixed(2)}`);
  if (winningBand !== null) {
    console.log(`  winning_band     = Band ${winningBand}`);
  } else {
    console.log(`  winning_band     = NONE (price outside all bands)`);
  }

  // 2. Execute epoch payout (keeper redeems Predict position)
  console.log('\n─── Execute Epoch Payout ───');
  await executeEpochPayout(
    ceridaPkg, vaultId, managerId, windowBookId, windowOracleId, windowEpochId,
  );

  // 3. Claim bet ticket
  console.log('\n─── Claim Window Bet ───');
  const payout = await claimWindowBet(ceridaPkg, vaultId, windowBookId, windowBetTicketId);
  const payoutUsd = Number(payout) / Number(DUSDC_SCALE);

  // ── Report ───────────────────────────────────────────────────────────────────

  const BET_BAND_IDX = 1; // from windows-open.ts — the band we bet on
  const won = winningBand === BET_BAND_IDX;

  console.log(`
═══ Settlement Summary ═══
  BTC settlement price: $${priceUsd.toFixed(2)}
  Winning band:         ${winningBand !== null ? `Band ${winningBand}` : 'NONE'}
  Our bet:              Band ${BET_BAND_IDX} (ATM flat band)
  Result:               ${won ? '🏆  WIN' : '❌  LOSS'}
  Payout:               $${payoutUsd.toFixed(6)} dUSDC
`);
}

main().catch(e => { console.error(e); process.exit(1); });
