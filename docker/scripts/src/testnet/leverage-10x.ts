// 10x leverage test against the cerida vault on testnet.
//
// Turbo Ticket math:
//   - qty = 1000 contracts (each pays $1 dUSDC if ITM)
//   - margin = $50 dUSDC
//   - At ATM binary (~50% price): basis ≈ 500, reserved ≈ 500
//   - If ITM:  user gains reserved ≈ $500 on $50 margin → ~10x ✓
//   - If OTM:  user loses margin ($50)
//
// Pool needs enough liquidity to fund basis (~$500). We top-up the existing
// pool with $1000 additional LP before opening the position.
//
// Prereqs: bun src/testnet/deploy.ts + bun src/testnet/flow.ts (vault + pool + book created)
//
// Run: bun src/testnet/leverage-10x.ts

import { Transaction } from '@mysten/sui/transactions';
import {
  c, kp, ADDR,
  PREDICT_OBJ, DUSDC_TYPE, CLOCK,
  PRICE_SCALE, DUSDC_SCALE, PREDICT_SERVER,
  loadManifest, type Manifest,
} from './config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const LEV_MARGIN   = 50n;   // dUSDC margin ($50)
const QUANTITY     = 1000n; // contracts — at 50% binary: basis≈500, reserved≈500 → ~10x
const MAINT_BPS    = 500n;  // 5% maintenance margin (min_margin = 5% of basis = $25)
const LP_TOP_UP    = 100n;  // extra dUSDC to pool (existing pool already has $500; $600 total > $500 basis)

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

// ── Oracle: pick ATM strike for maximum basis (closest to 50/50 binary) ─────

async function fetchAtmOracle() {
  const res  = await fetch(`${PREDICT_SERVER}/oracles`);
  const all: any[] = await res.json();
  const now  = Date.now();
  const candidates = all
    .filter(o => o.status === 'active' && o.expiry > now + 30 * 60_000)
    .sort((a, b) => a.expiry - b.expiry);
  assert(candidates.length > 0, 'No active oracle with ≥30 min remaining');

  const o     = candidates[0];
  const obj   = await c.getObject({ id: o.oracle_id, options: { showContent: true } });
  const fields = (obj.data?.content as any)?.fields ?? {};
  const forward = BigInt(fields.prices?.fields?.forward ?? 0);
  const tick    = BigInt(o.tick_size ?? 1_000_000_000n);
  const atm     = (forward / tick) * tick;

  return {
    oracleId:  o.oracle_id as string,
    expiry:    o.expiry as number,
    atmStrike: atm,
    forward,
  };
}

// ── Leverage flow ─────────────────────────────────────────────────────────────

async function addLP(poolId: string, coinRef: any): Promise<void> {
  const m = loadManifest();
  const ceridaPkg = m.ceridaPkg!;
  const tx   = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  const [payment] = tx.splitCoins(base, [tx.pure.u64(LP_TOP_UP * DUSDC_SCALE)]);
  const share = tx.moveCall({
    target: `${ceridaPkg}::leverage::supply`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(poolId), payment],
  });
  tx.transferObjects([share], ADDR);
  await exec(tx, `leverage::supply ${LP_TOP_UP} dUSDC (pool top-up)`);
}

async function requestLeverage(
  ceridaPkg: string, vaultId: string,
  oracle: Awaited<ReturnType<typeof fetchAtmOracle>>,
  coinRef: any,
): Promise<number> {
  const tx   = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  const [margin] = tx.splitCoins(base, [tx.pure.u64(LEV_MARGIN * DUSDC_SCALE)]);

  tx.moveCall({
    target: `${ceridaPkg}::vault::request_leverage_binary`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.pure.id(oracle.oracleId),
      tx.pure.u64(oracle.expiry),
      tx.pure.u64(oracle.atmStrike),
      tx.pure.bool(true),     // is_up (long binary)
      tx.pure.u64(QUANTITY),
      tx.pure.u64(MAINT_BPS),
      tx.pure.u64(0),         // tp
      tx.pure.u64(0),         // sl
      margin,
    ],
  });
  const r = await exec(tx, `request_leverage_binary UP @ $${oracle.atmStrike / PRICE_SCALE} qty=${QUANTITY}`);
  const ev = findEvent(r, '::vault::LeverageOpenRequested');
  assert(ev?.parsedJson, 'LeverageOpenRequested event missing');
  return Number((ev.parsedJson as any).intent_id);
}

async function executeLeverageOpen(
  ceridaPkg: string, vaultId: string, managerId: string,
  poolId: string, bookId: string,
  oracle: Awaited<ReturnType<typeof fetchAtmOracle>>,
  intentId: number,
): Promise<{ positionId: number; event: any }> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::vault::execute_leverage_open`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.object(managerId),
      tx.object(PREDICT_OBJ),
      tx.object(oracle.oracleId),
      tx.object(poolId),
      tx.object(bookId),
      tx.pure.u64(intentId),
      tx.object(CLOCK),
    ],
  });
  const r = await exec(tx, `execute_leverage_open intent #${intentId}`);

  // The raw on-chain TicketOpened event has the final basis/reserved
  const ticketEv = findEvent(r, '::leverage::TicketOpened');
  const openEv   = findEvent(r, '::vault::LeverageOpenExecuted');
  assert(openEv?.parsedJson, 'LeverageOpenExecuted event missing');

  return {
    positionId: Number((openEv.parsedJson as any).position_id),
    event: ticketEv?.parsedJson ?? null,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const m = loadManifest();
  assert(m.ceridaPkg,  'ceridaPkg missing — run deploy.ts first');
  assert(m.vaultId,    'vaultId missing  — run flow.ts first');
  assert(m.managerId,  'managerId missing — run flow.ts first');
  assert(m.poolId,     'poolId missing   — run flow.ts first');
  assert(m.bookId,     'bookId missing   — run flow.ts first');

  const { ceridaPkg, vaultId, managerId, poolId, bookId } = m as Required<Manifest>;

  console.log('\n═══ Cerida 10x Leverage Test — Testnet ═══');
  console.log(`Address:    ${ADDR}`);
  console.log(`ceridaPkg:  ${ceridaPkg}`);
  console.log(`vault:      ${vaultId}`);
  console.log(`pool:       ${poolId}`);
  console.log(`book:       ${bookId}`);
  console.log(`\nTarget position:`);
  console.log(`  margin   = $${LEV_MARGIN} dUSDC`);
  console.log(`  qty      = ${QUANTITY} contracts (face value ~$${QUANTITY})`);
  console.log(`  ATM ~50% → basis≈$${QUANTITY/2n}, reserved≈$${QUANTITY/2n} → ~${QUANTITY/2n/LEV_MARGIN}x max gain`);

  // Balance check
  const coinsRes = await c.getCoins({ owner: ADDR, coinType: DUSDC_TYPE });
  const coins    = coinsRes.data;
  const total    = coins.reduce((s, x) => s + BigInt(x.balance), 0n);
  console.log(`\ndUSDC balance: $${total / DUSDC_SCALE}`);
  const needed = (LP_TOP_UP + LEV_MARGIN) * DUSDC_SCALE;
  assert(total >= needed, `Need ≥ $${needed / DUSDC_SCALE} dUSDC (have $${total / DUSDC_SCALE})`);

  // Merge coins if fragmented
  if (coins.length > 1) {
    const tx   = new Transaction();
    const base = tx.object(coins[0].coinObjectId);
    tx.mergeCoins(base, coins.slice(1).map(x => tx.object(x.coinObjectId)));
    await exec(tx, 'merge dUSDC coins');
  }
  const coinRef = (await c.getCoins({ owner: ADDR, coinType: DUSDC_TYPE })).data[0];

  // Oracle
  console.log('\n─── Oracle ───');
  const oracle = await fetchAtmOracle();
  const mins   = Math.ceil((oracle.expiry - Date.now()) / 60_000);
  console.log(`  id      = ${oracle.oracleId}`);
  console.log(`  expiry  = ${new Date(oracle.expiry).toISOString()} (${mins} min)`);
  console.log(`  forward = $${oracle.forward / PRICE_SCALE}`);
  console.log(`  ATM     = $${oracle.atmStrike / PRICE_SCALE}`);

  // Top up pool liquidity
  console.log('\n─── Pool Top-up ───');
  console.log(`  Adding $${LP_TOP_UP} LP to ensure pool can fund ~$${QUANTITY/2n} basis`);
  await addLP(poolId, coinRef);

  // Request leverage open
  console.log('\n─── Leverage Open (request) ───');
  const intentId = await requestLeverage(ceridaPkg, vaultId, oracle, coinRef);
  console.log(`  intent_id = ${intentId}`);

  // Execute leverage open
  console.log('\n─── Leverage Open (execute) ───');
  const { positionId, event: ticketEv } = await executeLeverageOpen(
    ceridaPkg, vaultId, managerId, poolId, bookId, oracle, intentId,
  );

  // ── Report ───────────────────────────────────────────────────────────────────

  console.log('\n═══ Position Summary ═══');
  console.log(`  position_id = ${positionId}`);

  if (ticketEv) {
    const basis    = BigInt(ticketEv.basis    ?? 0);
    const reserved = BigInt(ticketEv.reserved ?? 0);
    const margin   = BigInt(ticketEv.margin   ?? 0);
    const qty      = BigInt(ticketEv.qty      ?? 0);

    // basis and reserved are in contract units (1 unit = 1 dUSDC at settlement)
    // margin is in raw dUSDC (÷ DUSDC_SCALE for dollars)
    const marginUsd   = Number(margin)   / Number(DUSDC_SCALE);
    const basisUsd    = Number(basis);    // contracts = dUSDC face
    const reservedUsd = Number(reserved); // contracts = dUSDC face

    const binaryPct   = qty > 0n ? (Number(basis) / Number(qty) * 100).toFixed(1) : 'n/a';
    const leverageX   = marginUsd > 0 ? (reservedUsd / marginUsd).toFixed(1) : 'n/a';
    const maxPayoutUsd = marginUsd + reservedUsd;

    console.log(`\n  qty          = ${qty} contracts`);
    console.log(`  basis        = ${basisUsd} dUSDC  (binary priced at ${binaryPct}%)`);
    console.log(`  reserved     = ${reservedUsd} dUSDC`);
    console.log(`  margin       = $${marginUsd.toFixed(2)} dUSDC (after open fee)`);
    console.log(`\n  ┌─────────────────────────────────────────┐`);
    console.log(`  │  Scenario    │  Payout        │  P&L       │`);
    console.log(`  ├─────────────────────────────────────────┤`);
    console.log(`  │  WIN (ITM)   │  $${maxPayoutUsd.toFixed(2).padEnd(12)}  │  +$${reservedUsd.toFixed(2).padEnd(7)} │`);
    console.log(`  │  LOSE (OTM)  │  $${Math.max(0, marginUsd - basisUsd).toFixed(2).padEnd(12)}  │  -$${Math.min(marginUsd, basisUsd).toFixed(2).padEnd(7)} │`);
    console.log(`  └─────────────────────────────────────────┘`);
    console.log(`\n  Leverage: ${leverageX}x  (reserved / margin)`);
    console.log(`  Maintenance BPS: ${ticketEv.maint_bps} (${Number(ticketEv.maint_bps) / 100}% of basis = liquidation threshold)`);
  } else {
    console.log('  (TicketOpened event not captured — check explorer)');
  }

  console.log(`\n✓ Done. Oracle expires ${new Date(oracle.expiry).toISOString()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
