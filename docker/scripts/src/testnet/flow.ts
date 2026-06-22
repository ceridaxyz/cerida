// Cerida vault flow on testnet: creates a CeridaVault, then tests binary,
// range, and combo mint via the vault (request → execute). No settlement —
// just verifying every tx lands. Run with: bun src/testnet/flow.ts
//
// Prereq: bun src/testnet/deploy.ts must have run first (sets ceridaPkg).

import { Transaction } from '@mysten/sui/transactions';
import {
  c, kp, ADDR,
  PREDICT_PKG, PREDICT_OBJ, DUSDC_TYPE, CLOCK,
  PRICE_SCALE, DUSDC_SCALE, PREDICT_SERVER,
  loadManifest, saveManifest, type Manifest,
} from './config.js';

const QUANTITY    = 5n;    // contracts per leg
const LEG_ESCROW  = 10n;   // dUSDC escrowed per leg (market order, no limit)

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  console.log(`✓  (${r.digest.slice(0, 12)}…)`);
  return r;
}

async function fetchOracle() {
  const res  = await fetch(`${PREDICT_SERVER}/oracles`);
  const all: any[] = await res.json();
  const now  = Date.now();
  const candidates = all
    .filter(o => o.status === 'active' && o.expiry > now + 30 * 60_000)
    .sort((a, b) => a.expiry - b.expiry);
  assert(candidates.length > 0, 'No active oracle with 30+ min remaining');
  const o = candidates[0];

  const obj    = await c.getObject({ id: o.oracle_id, options: { showContent: true } });
  const fields = (obj.data?.content as any)?.fields ?? {};
  const forward = BigInt(fields.prices?.fields?.forward ?? 0);
  const tick    = BigInt(o.tick_size ?? 1_000_000_000n);
  const atm     = (forward / tick) * tick;

  return {
    oracleId:  o.oracle_id as string,
    expiry:    o.expiry as number,
    atmStrike: atm,
    lower:     atm - 500n * PRICE_SCALE,
    upper:     atm + 500n * PRICE_SCALE,
  };
}

function findEvent(r: TxResult, typeSuffix: string): any {
  return (r.events ?? []).find((e: any) => String(e.type).includes(typeSuffix));
}

// ── Vault setup ───────────────────────────────────────────────────────────────

async function ensureVault(m: Manifest, ceridaPkg: string): Promise<{ vaultId: string; managerId: string }> {
  if (m.vaultId && m.managerId) {
    console.log(`Vault: ${m.vaultId} (existing)`);
    return { vaultId: m.vaultId, managerId: m.managerId };
  }

  console.log('\n─── Create CeridaVault ───');
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::vault::create`,
    typeArguments: [DUSDC_TYPE],
    arguments: [],
  });
  const r = await exec(tx, 'vault::create');

  const ev = findEvent(r, '::vault::VaultCreated');
  assert(ev?.parsedJson, 'VaultCreated event missing');
  const { vault_id, manager_id } = ev.parsedJson as any;
  assert(vault_id && manager_id, 'VaultCreated missing vault_id/manager_id');

  m.vaultId   = vault_id;
  m.managerId = manager_id;
  saveManifest(m);
  console.log(`  vaultId   = ${vault_id}`);
  console.log(`  managerId = ${manager_id}`);
  return { vaultId: vault_id, managerId: manager_id };
}

// ── Mint helpers ──────────────────────────────────────────────────────────────

async function requestBinaryMint(
  ceridaPkg: string, vaultId: string,
  oracle: Awaited<ReturnType<typeof fetchOracle>>,
  coinRef: any, isUp: boolean,
): Promise<number> {
  const tx  = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  const [payment] = tx.splitCoins(base, [tx.pure.u64(LEG_ESCROW * DUSDC_SCALE)]);

  const intentId = tx.moveCall({
    target: `${ceridaPkg}::vault::request_mint_binary`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.pure.id(oracle.oracleId),
      tx.pure.u64(oracle.expiry),
      tx.pure.u64(oracle.atmStrike),
      tx.pure.bool(isUp),
      tx.pure.u64(QUANTITY),
      tx.pure.u64(0), // max_cost = 0 (market order)
      tx.pure.u64(0), // tp
      tx.pure.u64(0), // sl
      payment,
    ],
  });
  // intent_id is returned but we can also read it from event
  const side = isUp ? 'UP' : 'DOWN';
  const r = await exec(tx, `request_mint_binary ${side} $${oracle.atmStrike / PRICE_SCALE}`);
  const ev = findEvent(r, '::vault::MintRequested');
  assert(ev?.parsedJson, 'MintRequested event missing');
  return Number((ev.parsedJson as any).intent_id);
}

async function executeMint(
  ceridaPkg: string, vaultId: string, managerId: string,
  oracle: Awaited<ReturnType<typeof fetchOracle>>,
  intentId: number,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::vault::execute_mint`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.object(managerId),
      tx.object(PREDICT_OBJ),
      tx.object(oracle.oracleId),
      tx.pure.u64(intentId),
      tx.object(CLOCK),
    ],
  });
  await exec(tx, `execute_mint intent #${intentId}`);
}

async function requestRangeMint(
  ceridaPkg: string, vaultId: string,
  oracle: Awaited<ReturnType<typeof fetchOracle>>,
  coinRef: any,
): Promise<number> {
  const tx  = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  const [payment] = tx.splitCoins(base, [tx.pure.u64(LEG_ESCROW * DUSDC_SCALE)]);

  tx.moveCall({
    target: `${ceridaPkg}::vault::request_mint_range`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.pure.id(oracle.oracleId),
      tx.pure.u64(oracle.expiry),
      tx.pure.u64(oracle.lower),
      tx.pure.u64(oracle.upper),
      tx.pure.u64(QUANTITY),
      tx.pure.u64(0),
      tx.pure.u64(0),
      tx.pure.u64(0),
      payment,
    ],
  });
  const r = await exec(tx, `request_mint_range $${oracle.lower / PRICE_SCALE}–$${oracle.upper / PRICE_SCALE}`);
  const ev = findEvent(r, '::vault::MintRequested');
  assert(ev?.parsedJson, 'MintRequested event missing');
  return Number((ev.parsedJson as any).intent_id);
}

// ── Combo ─────────────────────────────────────────────────────────────────────

async function requestCombo(
  ceridaPkg: string, vaultId: string,
  oracle: Awaited<ReturnType<typeof fetchOracle>>,
  coinRef: any,
): Promise<{ comboId: number; legCount: number }> {
  const tx   = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  // Two legs: binary UP + range — each needs LEG_ESCROW
  const [payment] = tx.splitCoins(base, [tx.pure.u64(LEG_ESCROW * 2n * DUSDC_SCALE)]);

  // Build ComboLegInput vector via Move constructors
  const binaryLeg = tx.moveCall({
    target: `${ceridaPkg}::vault::binary_leg_input`,
    arguments: [
      tx.pure.id(oracle.oracleId),
      tx.pure.u64(oracle.expiry),
      tx.pure.u64(oracle.atmStrike),
      tx.pure.bool(true),   // is_up
      tx.pure.u64(QUANTITY),
      tx.pure.u64(0),       // max_cost
      tx.pure.u64(LEG_ESCROW * DUSDC_SCALE),
    ],
  });
  const rangeLeg = tx.moveCall({
    target: `${ceridaPkg}::vault::range_leg_input`,
    arguments: [
      tx.pure.id(oracle.oracleId),
      tx.pure.u64(oracle.expiry),
      tx.pure.u64(oracle.lower),
      tx.pure.u64(oracle.upper),
      tx.pure.u64(QUANTITY),
      tx.pure.u64(0),
      tx.pure.u64(LEG_ESCROW * DUSDC_SCALE),
    ],
  });

  const legsVec = tx.makeMoveVec({
    type: `${ceridaPkg}::vault::ComboLegInput`,
    elements: [binaryLeg, rangeLeg],
  });

  // MODE_PORTFOLIO = 0, KIND_PREDICT = 0 (see combo.move constants)
  tx.moveCall({
    target: `${ceridaPkg}::vault::request_combo`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      legsVec,
      tx.pure.u8(0), // mode: portfolio
      tx.pure.u8(0), // kind: predict
      payment,
    ],
  });

  const r = await exec(tx, 'request_combo (binary UP + range)');

  // ComboCreated event contains combo_id; leg execution uses leg_index (0, 1, …)
  const comboEv = findEvent(r, '::combo::ComboCreated');
  assert(comboEv?.parsedJson, 'ComboCreated event missing');
  const comboId = Number((comboEv.parsedJson as any).combo_id);
  const legCount = Number((comboEv.parsedJson as any).leg_count);

  return { comboId, legCount };
}

async function executeComboMint(
  ceridaPkg: string, vaultId: string, managerId: string,
  oracle: Awaited<ReturnType<typeof fetchOracle>>,
  comboId: number, legIndex: number,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::vault::execute_combo_mint`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.object(managerId),
      tx.object(PREDICT_OBJ),
      tx.object(oracle.oracleId),
      tx.pure.u64(comboId),
      tx.pure.u64(legIndex),
      tx.object(CLOCK),
    ],
  });
  await exec(tx, `execute_combo_mint combo #${comboId} leg ${legIndex}`);
}

// ── Leverage ──────────────────────────────────────────────────────────────────

const LP_SUPPLY     = 500n;  // dUSDC LP deposit
const LEV_MARGIN    = 20n;   // dUSDC margin per leverage open
const MAINT_BPS     = 500n;  // 5% maintenance margin

async function ensureLeverageInfra(
  m: Manifest, ceridaPkg: string,
): Promise<{ poolId: string; bookId: string }> {
  if (m.poolId && m.bookId) {
    console.log(`Pool: ${m.poolId} (existing)`);
    console.log(`Book: ${m.bookId} (existing)`);
    return { poolId: m.poolId, bookId: m.bookId };
  }

  console.log('\n─── Create MarginPool + LeverageBook ───');
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::leverage::create_pool`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.pure.u64(1000n), // perf_bps  10%
      tx.pure.u64(500n),  // penalty_bps 5%
      tx.pure.u64(50n),   // open_fee_bps 0.5%
    ],
  });
  tx.moveCall({
    target: `${ceridaPkg}::leverage::create_book`,
    typeArguments: [DUSDC_TYPE],
    arguments: [],
  });
  const r = await exec(tx, 'create_pool + create_book');

  const poolEv = findEvent(r, '::leverage::PoolCreated');
  assert(poolEv?.parsedJson, 'PoolCreated event missing');

  // book ID from object changes (LeverageBook shared object)
  const created = (r.objectChanges ?? []).filter((x: any) => x.type === 'created');
  const bookObj = created.find((x: any) => String(x.objectType).includes('LeverageBook'));
  assert(bookObj, 'LeverageBook not found in object changes');

  m.poolId = (poolEv.parsedJson as any).pool_id;
  m.bookId = (bookObj as any).objectId;
  saveManifest(m);
  console.log(`  poolId = ${m.poolId}`);
  console.log(`  bookId = ${m.bookId}`);
  return { poolId: m.poolId!, bookId: m.bookId! };
}

async function supplyLP(ceridaPkg: string, poolId: string, coinRef: any): Promise<void> {
  const tx   = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  const [payment] = tx.splitCoins(base, [tx.pure.u64(LP_SUPPLY * DUSDC_SCALE)]);
  const share = tx.moveCall({
    target: `${ceridaPkg}::leverage::supply`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(poolId), payment],
  });
  tx.transferObjects([share], ADDR);
  await exec(tx, `leverage::supply ${LP_SUPPLY} dUSDC`);
}

async function requestLeverageBinary(
  ceridaPkg: string, vaultId: string,
  oracle: Awaited<ReturnType<typeof fetchOracle>>,
  coinRef: any, isUp: boolean,
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
      tx.pure.bool(isUp),
      tx.pure.u64(QUANTITY),
      tx.pure.u64(MAINT_BPS),
      tx.pure.u64(0), // tp
      tx.pure.u64(0), // sl
      margin,
    ],
  });
  const r = await exec(tx, `request_leverage_binary ${isUp ? 'UP' : 'DOWN'}`);
  const ev = findEvent(r, '::vault::LeverageOpenRequested');
  assert(ev?.parsedJson, 'LeverageOpenRequested event missing');
  return Number((ev.parsedJson as any).intent_id);
}

async function executeLeverageOpen(
  ceridaPkg: string, vaultId: string, managerId: string,
  poolId: string, bookId: string,
  oracle: Awaited<ReturnType<typeof fetchOracle>>,
  intentId: number,
): Promise<number> {
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
  const ev = findEvent(r, '::vault::LeverageOpenExecuted');
  assert(ev?.parsedJson, 'LeverageOpenExecuted event missing');
  return Number((ev.parsedJson as any).position_id);
}

async function requestComboWithLeverage(
  ceridaPkg: string, vaultId: string, bookId: string,
  oracle: Awaited<ReturnType<typeof fetchOracle>>,
  positionId: number, coinRef: any,
): Promise<{ comboId: number; legCount: number }> {
  const tx   = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  const [payment] = tx.splitCoins(base, [tx.pure.u64(LEG_ESCROW * DUSDC_SCALE)]);

  // One predict binary leg + one existing leverage leg
  const binaryLeg = tx.moveCall({
    target: `${ceridaPkg}::vault::binary_leg_input`,
    arguments: [
      tx.pure.id(oracle.oracleId),
      tx.pure.u64(oracle.expiry),
      tx.pure.u64(oracle.atmStrike),
      tx.pure.bool(true),
      tx.pure.u64(QUANTITY),
      tx.pure.u64(0),
      tx.pure.u64(LEG_ESCROW * DUSDC_SCALE),
    ],
  });
  const predictLegsVec = tx.makeMoveVec({
    type: `${ceridaPkg}::vault::ComboLegInput`,
    elements: [binaryLeg],
  });

  const leverageLeg = tx.moveCall({
    target: `${ceridaPkg}::vault::leverage_leg_input`,
    arguments: [
      tx.pure.u64(positionId),
      tx.pure.id(oracle.oracleId),
      tx.pure.u64(oracle.expiry),
      tx.pure.u64(QUANTITY),
    ],
  });
  const leverageLegsVec = tx.makeMoveVec({
    type: `${ceridaPkg}::vault::LeverageLegInput`,
    elements: [leverageLeg],
  });

  tx.moveCall({
    target: `${ceridaPkg}::vault::request_combo_with_leverage`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.object(bookId),
      predictLegsVec,
      leverageLegsVec,
      tx.pure.u8(0), // mode: portfolio
      tx.pure.u8(0), // kind: predict
      payment,
    ],
  });
  const r = await exec(tx, 'request_combo_with_leverage (binary + leverage leg)');
  const comboEv = findEvent(r, '::combo::ComboCreated');
  assert(comboEv?.parsedJson, 'ComboCreated event missing');
  return {
    comboId:  Number((comboEv.parsedJson as any).combo_id),
    legCount: Number((comboEv.parsedJson as any).leg_count),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const m = loadManifest();
  const ceridaPkg = m.ceridaPkg;
  assert(ceridaPkg, 'ceridaPkg not set — run: bun src/testnet/deploy.ts first');

  console.log(`\n═══ Cerida Vault Flow — Testnet ═══`);
  console.log(`Address:    ${ADDR}`);
  console.log(`ceridaPkg:  ${ceridaPkg}`);

  // dUSDC balance
  const coinsRes = await c.getCoins({ owner: ADDR, coinType: DUSDC_TYPE });
  const coins    = coinsRes.data;
  const total    = coins.reduce((s, x) => s + BigInt(x.balance), 0n);
  console.log(`dUSDC:      ${total / DUSDC_SCALE}`);
  const minNeeded = (LEG_ESCROW * 4n + LP_SUPPLY + LEV_MARGIN) * DUSDC_SCALE;
  assert(total >= minNeeded, `Need ≥ ${minNeeded / DUSDC_SCALE} dUSDC`);

  // Merge coins if fragmented
  if (coins.length > 1) {
    const tx   = new Transaction();
    const base = tx.object(coins[0].coinObjectId);
    tx.mergeCoins(base, coins.slice(1).map(x => tx.object(x.coinObjectId)));
    await exec(tx, 'merge dUSDC coins');
  }

  // Refetch single coin after merge
  const coinRef = (await c.getCoins({ owner: ADDR, coinType: DUSDC_TYPE })).data[0];

  // 1. Vault
  const { vaultId, managerId } = await ensureVault(m, ceridaPkg);

  // 2. Oracle
  console.log('\n─── Oracle ───');
  const oracle = await fetchOracle();
  const mins   = Math.ceil((oracle.expiry - Date.now()) / 60_000);
  console.log(`  id     = ${oracle.oracleId}`);
  console.log(`  expiry = ${new Date(oracle.expiry).toISOString()} (${mins} min)`);
  console.log(`  ATM    = $${oracle.atmStrike / PRICE_SCALE}  range $${oracle.lower / PRICE_SCALE}–$${oracle.upper / PRICE_SCALE}`);

  // 3. Binary mint
  console.log('\n─── Binary Mint ───');
  const binaryIntentId = await requestBinaryMint(ceridaPkg, vaultId, oracle, coinRef, true);
  await executeMint(ceridaPkg, vaultId, managerId, oracle, binaryIntentId);

  // 4. Range mint
  console.log('\n─── Range Mint ───');
  const rangeIntentId = await requestRangeMint(ceridaPkg, vaultId, oracle, coinRef);
  await executeMint(ceridaPkg, vaultId, managerId, oracle, rangeIntentId);

  // 5. Combo (binary UP + range)
  console.log('\n─── Combo Mint ───');
  const { comboId, legCount } = await requestCombo(ceridaPkg, vaultId, oracle, coinRef);
  console.log(`  combo_id = ${comboId}  legs = ${legCount}`);
  for (let i = 0; i < legCount; i++) {
    await executeComboMint(ceridaPkg, vaultId, managerId, oracle, comboId, i);
  }

  // 6. Leverage infra (pool + book)
  console.log('\n─── Leverage Infrastructure ───');
  const { poolId, bookId } = await ensureLeverageInfra(m, ceridaPkg);
  await supplyLP(ceridaPkg, poolId, coinRef);

  // 7. Leverage open (binary)
  console.log('\n─── Leverage Open ───');
  const levIntentId  = await requestLeverageBinary(ceridaPkg, vaultId, oracle, coinRef, true);
  const positionId   = await executeLeverageOpen(ceridaPkg, vaultId, managerId, poolId, bookId, oracle, levIntentId);
  console.log(`  position_id = ${positionId}`);

  // 8. Combo with leverage leg (predict binary + existing leverage position)
  console.log('\n─── Combo with Leverage Leg ───');
  const { comboId: levComboId, legCount: levLegCount } =
    await requestComboWithLeverage(ceridaPkg, vaultId, bookId, oracle, positionId, coinRef);
  console.log(`  combo_id = ${levComboId}  legs = ${levLegCount}`);
  // Only the predict leg (index 0) needs execute_combo_mint; leverage leg is already open
  await executeComboMint(ceridaPkg, vaultId, managerId, oracle, levComboId, 0);

  console.log(`\n✓ All cerida flows verified. Oracle expires ${new Date(oracle.expiry).toISOString()}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
