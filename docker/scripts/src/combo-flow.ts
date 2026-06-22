// Combo flow tests: portfolio + parlay + leverage-leg combos.
//
// Scenarios covered:
//   A) Portfolio combo (binary + range): settle at $62,999 → binary UP loses, range wins.
//      Claim only the range payout.
//   B) Parlay combo (binary + binary): first leg wins but second loses → zero payout.
//      Status = LOST immediately on leg-1 loss.
//   C) Leverage-leg combo (predict range + leverage position): portfolio mode.
//      Lock check: attempt to close the locked position (should fail).
//      settle_combo_leg + settle_combo_leverage_leg + claim_combo.
//   D) Leverage leg in parlay → should abort with ELeverageInParlay.
//
// All scenarios use a dedicated short-lived oracle (30s) to avoid waiting long.

import { Transaction } from '@mysten/sui/transactions';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  CLOCK,
  client,
  deployer,
  DUSDC_SCALE,
  fund,
  loadManifest,
  need,
  PRICE_SCALE,
  type Manifest,
} from './config.js';

declare const process: { exit(code?: number): void };

type TxResult = Awaited<ReturnType<SuiClient['signAndExecuteTransaction']>>;
type ParsedEvent = Record<string, unknown>;

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${msg}`);
}

function eventPayload(r: TxResult, suffix: string): ParsedEvent {
  const ev = (r.events ?? []).find((e: any) => e.type.endsWith(suffix));
  assert(ev, `missing event ${suffix}`);
  assert(ev.parsedJson, `event ${suffix} missing parsedJson`);
  return ev.parsedJson as ParsedEvent;
}

function maybeEvent(r: TxResult, suffix: string): ParsedEvent | null {
  const ev = (r.events ?? []).find((e: any) => e.type.endsWith(suffix));
  return ev?.parsedJson ? (ev.parsedJson as ParsedEvent) : null;
}

function fieldBigInt(ev: ParsedEvent, key: string): bigint {
  const v = ev[key];
  assert(v !== undefined && v !== null, `missing event field ${key}`);
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  throw new Error(`event field ${key} is not bigint-like`);
}

function fieldBool(ev: ParsedEvent, key: string): boolean {
  const v = ev[key];
  assert(typeof v === 'boolean', `event field ${key} is not boolean`);
  return v;
}

async function exec(
  c: SuiClient, tx: Transaction, kp: Ed25519Keypair,
  label: string, opts: { gasBudget?: bigint | null; expectFail?: boolean } = {},
) {
  if (opts.gasBudget !== null) tx.setGasBudget(opts.gasBudget ?? 3_000_000_000n);
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: TxResult;
    try {
      r = await c.signAndExecuteTransaction({
        transaction: tx, signer: kp,
        options: { showEffects: true, showObjectChanges: true, showEvents: true },
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const retriable = msg.includes('needs to be rebuilt') || msg.includes('Internal error');
      if (attempt < 2 && retriable) {
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      throw e;
    }
    const ok = r!.effects?.status.status === 'success';
    if (opts.expectFail) {
      if (ok) throw new Error(`${label}: expected failure but succeeded`);
      console.log(`  ✓ ${label} correctly failed:`, r!.effects?.status.error?.slice(0, 120));
      return r!;
    }
    if (!ok) throw new Error(`${label} failed: ${JSON.stringify(r!.effects?.status)}`);
    await c.waitForTransaction({ digest: r!.digest });
    await new Promise((res) => setTimeout(res, 1500));
    return r!;
  }
  throw new Error(`${label}: unreachable`);
}

function createdObj(r: TxResult, needle: string): string {
  const hit = (r.objectChanges ?? []).find(
    (x: any) => x.type === 'created' && x.objectType?.includes(needle),
  );
  if (!hit) throw new Error(`no created object ~'${needle}'`);
  return (hit as any).objectId;
}

async function dusdcCoin(c: SuiClient, owner: string, dusdcType: string): Promise<string> {
  const coins = await c.getCoins({ owner, coinType: dusdcType });
  if (coins.data.length === 0) throw new Error('no dUSDC — run setup.ts');
  return coins.data[0].coinObjectId;
}

// ── Oracle helpers ────────────────────────────────────────────────────────────

async function createShortOracle(
  c: SuiClient, kp: Ed25519Keypair, m: Manifest,
  ttlMs: bigint, label = 'short oracle',
): Promise<{ oracleId: string; expiry: bigint }> {
  const predictPkg = need(m, 'predictPkg');
  const expiry = BigInt(Date.now()) + ttlMs;
  const spot = 63_000n * PRICE_SCALE;

  const tx = new Transaction();
  // create
  tx.moveCall({
    target: `${predictPkg}::registry::create_oracle`,
    arguments: [
      tx.object(need(m, 'registry')), tx.object(need(m, 'predict')),
      tx.object(need(m, 'adminCap')), tx.object(need(m, 'keeperOracleCapId')),
      tx.pure.string('BTC'), tx.pure.u64(expiry),
      tx.pure.u64(1_000n * PRICE_SCALE), tx.pure.u64(100n * PRICE_SCALE),
    ],
  });
  const r = await exec(c, tx, kp, `create ${label}`, { gasBudget: null });
  const ev = (r.events ?? []).find((e: any) => e.type?.endsWith('::registry::OracleCreated'));
  if (!ev?.parsedJson) throw new Error('OracleCreated event not found');
  const oracleId = (ev.parsedJson as any).oracle_id as string;

  // register cap + activate + feed SVI + spot
  const tx2 = new Transaction();
  const oracleObj = tx2.object(oracleId);
  const cap = tx2.object(need(m, 'keeperOracleCapId'));
  tx2.moveCall({ target: `${predictPkg}::registry::register_oracle_cap`, arguments: [oracleObj, tx2.object(need(m, 'adminCap')), cap] });
  tx2.moveCall({ target: `${predictPkg}::oracle::activate`, arguments: [oracleObj, cap, tx2.object(CLOCK)] });
  const pd = tx2.moveCall({ target: `${predictPkg}::oracle::new_price_data`, arguments: [tx2.pure.u64(spot), tx2.pure.u64(spot)] });
  tx2.moveCall({ target: `${predictPkg}::oracle::update_prices`, arguments: [oracleObj, cap, pd, tx2.object(CLOCK)] });
  const rho = tx2.moveCall({ target: `${predictPkg}::i64::from_parts`, arguments: [tx2.pure.u64(300_000_000n), tx2.pure.bool(true)] });
  const mm  = tx2.moveCall({ target: `${predictPkg}::i64::from_parts`, arguments: [tx2.pure.u64(0n), tx2.pure.bool(false)] });
  const svi = tx2.moveCall({ target: `${predictPkg}::oracle::new_svi_params`, arguments: [tx2.pure.u64(40_000_000n), tx2.pure.u64(100_000_000n), rho, mm, tx2.pure.u64(100_000_000n)] });
  tx2.moveCall({ target: `${predictPkg}::oracle::update_svi`, arguments: [oracleObj, cap, svi, tx2.object(CLOCK)] });
  await exec(c, tx2, kp, `activate + feed ${label}`);

  console.log(`  ${label}: ${oracleId}  expiry=${new Date(Number(expiry)).toISOString()}`);
  return { oracleId, expiry };
}

async function refreshOracle(
  c: SuiClient, kp: Ed25519Keypair, m: Manifest,
  oracleId: string, spotUsd = 63_000n,
) {
  const predictPkg = need(m, 'predictPkg');
  const spot = spotUsd * PRICE_SCALE;
  const tx = new Transaction();
  const pd = tx.moveCall({ target: `${predictPkg}::oracle::new_price_data`, arguments: [tx.pure.u64(spot), tx.pure.u64(spot)] });
  tx.moveCall({ target: `${predictPkg}::oracle::update_prices`, arguments: [tx.object(oracleId), tx.object(need(m, 'keeperOracleCapId')), pd, tx.object(CLOCK)] });
  await exec(c, tx, kp, `refresh oracle @$${spotUsd}`);
}

async function waitForExpiry(expiry: bigint, extraMs = 2_000) {
  const ms = Number(expiry) - Date.now() + extraMs;
  if (ms > 0) {
    console.log(`  waiting ${Math.ceil(ms / 1000)}s for oracle expiry…`);
    await new Promise((r) => setTimeout(r, ms));
  }
}

// ── Scenario A: Portfolio combo (binary UP + range) ───────────────────────────

async function scenarioA(
  c: SuiClient, kp: Ed25519Keypair, m: Manifest,
  vault: string, manager: string,
) {
  console.log('\n─── Scenario A: Portfolio combo (binary UP + range, settle $62,999) ───');
  const cerida    = need(m, 'ceridaPkg');
  const predict   = need(m, 'predict');
  const dusdcType = need(m, 'dusdcType');

  const { oracleId, expiry } = await createShortOracle(c, kp, m, 45_000n, 'scenario-A oracle');

  const strike  = 63_000n * PRICE_SCALE;  // binary UP: loses at $62,999 settlement
  const lower   = 62_000n * PRICE_SCALE;
  const higher  = 64_000n * PRICE_SCALE;  // range: wins ($62,999 is inside)
  const qty     = 50n * DUSDC_SCALE;
  const escrow  = 150n * DUSDC_SCALE;

  let comboId = 0n;
  {
    const coin = await dusdcCoin(c, kp.toSuiAddress(), dusdcType);
    const tx = new Transaction();
    const [e0, e1] = tx.splitCoins(tx.object(coin), [tx.pure.u64(escrow), tx.pure.u64(escrow)]);
    // begin_combo → add_binary_leg → add_range_leg → finalize_combo
    const [cid] = tx.moveCall({
      target: `${cerida}::vault::begin_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u8(0), tx.pure.u8(0)], // PORTFOLIO, SPREAD
    });
    tx.moveCall({
      target: `${cerida}::vault::add_binary_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid, tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(strike), tx.pure.bool(true), tx.pure.u64(qty), tx.pure.u64(0n), e0],
    });
    tx.moveCall({
      target: `${cerida}::vault::add_range_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid, tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(lower), tx.pure.u64(higher), tx.pure.u64(qty), tx.pure.u64(0n), e1],
    });
    tx.moveCall({
      target: `${cerida}::vault::finalize_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid],
    });
    const r = await exec(c, tx, kp, 'build combo (A)');
    const ev = eventPayload(r, '::combo::ComboCreated');
    comboId = fieldBigInt(ev, 'combo_id');
    assert(fieldBigInt(ev, 'leg_count') === 2n, 'combo has 2 legs');
    assert(fieldBigInt(ev, 'mode') === 0n, 'portfolio mode');
    console.log(`  ComboCreated: combo_id=${comboId} mode=PORTFOLIO legs=2`);
  }

  // Execute mint for each leg (keeper)
  await refreshOracle(c, kp, m, oracleId);
  for (const legIdx of [0n, 1n]) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_combo_mint`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault), tx.object(manager),
        tx.object(predict), tx.object(oracleId),
        tx.pure.u64(comboId), tx.pure.u64(legIdx), tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, `execute_combo_mint leg${legIdx} (A)`);
    const ev = eventPayload(r, '::combo::ComboMintExecuted');
    assert(fieldBigInt(ev, 'combo_id') === comboId, 'combo id matches');
    assert(fieldBigInt(ev, 'leg_index') === legIdx, `leg index is ${legIdx}`);
    console.log(`  ComboMintExecuted: leg=${legIdx}`);
  }

  // Wait for expiry, settle oracle at $62,999
  await waitForExpiry(expiry);
  await refreshOracle(c, kp, m, oracleId, 62_999n);

  // Settle each leg
  for (const legIdx of [0n, 1n]) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::settle_combo_leg`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault), tx.object(manager),
        tx.object(predict), tx.object(oracleId),
        tx.pure.u64(comboId), tx.pure.u64(legIdx), tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, `settle_combo_leg leg${legIdx} (A)`);
    const legEv = eventPayload(r, '::combo::ComboLegSettled');
    console.log(`  ComboLegSettled: leg=${legIdx} won=${fieldBool(legEv, 'won')} payout=${fieldBigInt(legEv, 'payout')}`);
    const doneEv = maybeEvent(r, '::combo::ComboSettled');
    if (doneEv) console.log(`  ComboSettled: status=${fieldBigInt(doneEv, 'status')} total=${fieldBigInt(doneEv, 'total_payout')}`);
  }

  // Claim
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::claim_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u64(comboId)],
    });
    const r = await exec(c, tx, kp, 'claim_combo (A)');
    const ev = eventPayload(r, '::vault::ComboClaimed');
    const payout = fieldBigInt(ev, 'payout');
    // Range won, binary lost → payout > 0 (range leg only), binary 0
    assert(payout > 0n, 'portfolio combo payout is positive (range leg won)');
    console.log(`  ✓ ComboClaimed: payout=$${(Number(payout) / 1e6).toFixed(2)} dUSDC`);
  }
  console.log('  ✓ Scenario A passed');
}

// ── Scenario B: Parlay combo (binary + binary, one loses → killed early) ──────

async function scenarioB(
  c: SuiClient, kp: Ed25519Keypair, m: Manifest,
  vault: string, manager: string,
) {
  console.log('\n─── Scenario B: Parlay combo (2× binary, leg-1 loses → combo killed) ───');
  const cerida    = need(m, 'ceridaPkg');
  const predict   = need(m, 'predict');
  const dusdcType = need(m, 'dusdcType');

  const { oracleId, expiry } = await createShortOracle(c, kp, m, 45_000n, 'scenario-B oracle');

  // At settlement $62,999:
  //   leg0 UP @ $62,000 → wins ($62,999 > $62,000)
  //   leg1 UP @ $63,500 → loses ($62,999 < $63,500) → kills parlay
  const qty    = 50n * DUSDC_SCALE;
  const escrow = 100n * DUSDC_SCALE;

  let comboId = 0n;
  {
    const coin = await dusdcCoin(c, kp.toSuiAddress(), dusdcType);
    const tx = new Transaction();
    const [e0, e1] = tx.splitCoins(tx.object(coin), [tx.pure.u64(escrow), tx.pure.u64(escrow)]);
    const [cid] = tx.moveCall({
      target: `${cerida}::vault::begin_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u8(1), tx.pure.u8(1)], // PARLAY, CONDOR
    });
    tx.moveCall({
      target: `${cerida}::vault::add_binary_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid, tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(62_000n * PRICE_SCALE), tx.pure.bool(true), tx.pure.u64(qty), tx.pure.u64(0n), e0],
    });
    tx.moveCall({
      target: `${cerida}::vault::add_binary_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid, tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(63_500n * PRICE_SCALE), tx.pure.bool(true), tx.pure.u64(qty), tx.pure.u64(0n), e1],
    });
    tx.moveCall({
      target: `${cerida}::vault::finalize_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid],
    });
    const r = await exec(c, tx, kp, 'request_combo (B)');
    const ev = eventPayload(r, '::combo::ComboCreated');
    comboId = fieldBigInt(ev, 'combo_id');
    assert(fieldBigInt(ev, 'mode') === 1n, 'parlay mode');
    console.log(`  ComboCreated: combo_id=${comboId} mode=PARLAY legs=2`);
  }

  // Mint both legs
  await refreshOracle(c, kp, m, oracleId);
  for (const legIdx of [0n, 1n]) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_combo_mint`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(manager), tx.object(predict), tx.object(oracleId), tx.pure.u64(comboId), tx.pure.u64(legIdx), tx.object(CLOCK)],
    });
    await exec(c, tx, kp, `execute_combo_mint leg${legIdx} (B)`);
    console.log(`  ComboMintExecuted: leg=${legIdx}`);
  }

  await waitForExpiry(expiry);
  await refreshOracle(c, kp, m, oracleId, 62_999n);

  // Settle leg 0 first (wins → parlay still alive)
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::settle_combo_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(manager), tx.object(predict), tx.object(oracleId), tx.pure.u64(comboId), tx.pure.u64(0n), tx.object(CLOCK)],
    });
    const r = await exec(c, tx, kp, 'settle_combo_leg leg0 (B)');
    const ev = eventPayload(r, '::combo::ComboLegSettled');
    assert(fieldBool(ev, 'won') === true, 'leg0 won');
    assert(maybeEvent(r, '::combo::ComboSettled') === null, 'parlay not yet killed after leg0 win');
    console.log('  leg0 won, parlay still alive');
  }

  // Settle leg 1 (loses → parlay killed, ComboSettled emitted immediately)
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::settle_combo_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(manager), tx.object(predict), tx.object(oracleId), tx.pure.u64(comboId), tx.pure.u64(1n), tx.object(CLOCK)],
    });
    const r = await exec(c, tx, kp, 'settle_combo_leg leg1 (B)');
    const legEv  = eventPayload(r, '::combo::ComboLegSettled');
    const doneEv = eventPayload(r, '::combo::ComboSettled');
    assert(fieldBool(legEv, 'won') === false, 'leg1 lost');
    assert(fieldBigInt(doneEv, 'status') === 2n, 'combo status=LOST (2)');
    assert(fieldBigInt(doneEv, 'total_payout') === 0n, 'parlay total payout is 0');
    console.log('  leg1 lost → ComboSettled status=LOST payout=0');
  }

  // Claim: payout = 0 (parlay lost)
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::claim_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u64(comboId)],
    });
    const r = await exec(c, tx, kp, 'claim_combo (B)');
    const ev = eventPayload(r, '::vault::ComboClaimed');
    assert(fieldBigInt(ev, 'payout') === 0n, 'parlay claim payout is 0');
    console.log('  ✓ ComboClaimed: payout=$0 (parlay lost, as expected)');
  }
  console.log('  ✓ Scenario B passed');
}

// ── Scenario C: Leverage-leg combo (range predict + leverage, portfolio) ──────

async function scenarioC(
  c: SuiClient, kp: Ed25519Keypair, m: Manifest,
  vault: string, manager: string,
) {
  console.log('\n─── Scenario C: Leverage-leg combo (range + leverage, settle $63,500) ───');
  const cerida    = need(m, 'ceridaPkg');
  const predict   = need(m, 'predict');
  const dusdcType = need(m, 'dusdcType');
  const pool      = need(m, 'marginPoolId');
  const book      = need(m, 'leverageBookId');

  const { oracleId, expiry } = await createShortOracle(c, kp, m, 60_000n, 'scenario-C oracle');

  // Open a leverage position (UP @ $63,000 ATM) on the short oracle
  let positionId = 0n;
  {
    await refreshOracle(c, kp, m, oracleId);
    const tx = new Transaction();
    const [mCoin] = tx.splitCoins(
      tx.object(await dusdcCoin(c, kp.toSuiAddress(), dusdcType)),
      [tx.pure.u64(20n * DUSDC_SCALE)],
    );
    tx.moveCall({
      target: `${cerida}::leverage::open_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracleId),
        tx.pure.id(oracleId), tx.pure.u64(expiry),
        tx.pure.u64(63_000n * PRICE_SCALE), tx.pure.bool(true),
        mCoin, tx.pure.u64(100n * DUSDC_SCALE), tx.pure.u64(4500n),
        tx.pure.u64(0n), tx.pure.u64(0n), tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'open leverage position (C)');
    const ev = eventPayload(r, '::leverage::TicketOpened');
    positionId = fieldBigInt(ev, 'position_id');
    console.log(`  TicketOpened: position_id=${positionId}`);
  }

  // Create combo: predict range leg (leg 0) + leverage leg (leg 1)
  // Settlement $63,500 → range $62k-$64k WINS, leverage UP WINS
  const qty    = 50n * DUSDC_SCALE;
  const escrow = 150n * DUSDC_SCALE;
  let comboId = 0n;
  {
    const coin = await dusdcCoin(c, kp.toSuiAddress(), dusdcType);
    const tx = new Transaction();
    const [e0] = tx.splitCoins(tx.object(coin), [tx.pure.u64(escrow)]);
    const [cid] = tx.moveCall({
      target: `${cerida}::vault::begin_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u8(0), tx.pure.u8(6)], // PORTFOLIO, CUSTOM
    });
    tx.moveCall({
      target: `${cerida}::vault::add_range_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid, tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(62_000n * PRICE_SCALE), tx.pure.u64(64_000n * PRICE_SCALE), tx.pure.u64(qty), tx.pure.u64(0n), e0],
    });
    tx.moveCall({
      target: `${cerida}::vault::add_leverage_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(book), cid, tx.pure.u64(positionId), tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(100n * DUSDC_SCALE)],
    });
    tx.moveCall({
      target: `${cerida}::vault::finalize_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid],
    });
    const r = await exec(c, tx, kp, 'request_combo_with_leverage (C)');
    const ev = eventPayload(r, '::combo::ComboCreated');
    comboId = fieldBigInt(ev, 'combo_id');
    assert(fieldBigInt(ev, 'leg_count') === 2n, 'combo has 2 legs (1 predict + 1 leverage)');
    console.log(`  ComboCreated: combo_id=${comboId} legs=2 (range+leverage)`);
  }

  // Verify leverage position is now LOCKED: try to close it — must fail
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::leverage::close`,
      typeArguments: [dusdcType],
      arguments: [tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracleId), tx.pure.u64(positionId), tx.object(CLOCK)],
    });
    await exec(c, tx, kp, 'close locked leverage position (expect ELockedInCombo)', { expectFail: true });
  }

  // Execute mint for the predict leg (leg 0)
  await refreshOracle(c, kp, m, oracleId);
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_combo_mint`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(manager), tx.object(predict), tx.object(oracleId), tx.pure.u64(comboId), tx.pure.u64(0n), tx.object(CLOCK)],
    });
    await exec(c, tx, kp, 'execute_combo_mint leg0/range (C)');
    console.log('  ComboMintExecuted: leg=0 (range)');
  }

  // Wait for expiry, settle oracle at $63,500 (range wins, leverage UP wins)
  await waitForExpiry(expiry);
  await refreshOracle(c, kp, m, oracleId, 63_500n);

  // Settle predict leg (leg 0)
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::settle_combo_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(manager), tx.object(predict), tx.object(oracleId), tx.pure.u64(comboId), tx.pure.u64(0n), tx.object(CLOCK)],
    });
    const r = await exec(c, tx, kp, 'settle_combo_leg leg0/range (C)');
    const ev = eventPayload(r, '::combo::ComboLegSettled');
    assert(fieldBool(ev, 'won') === true, 'range leg won at $63,500');
    console.log(`  leg0 (range) won, payout=${fieldBigInt(ev, 'payout')}`);
  }

  // Settle leverage leg (leg 1) — equity sent directly to owner
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::settle_combo_leverage_leg`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault), tx.object(manager),
        tx.object(pool), tx.object(book),
        tx.object(predict), tx.object(oracleId),
        tx.pure.u64(comboId), tx.pure.u64(1n), tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'settle_combo_leverage_leg leg1 (C)');
    const legEv  = eventPayload(r, '::combo::ComboLegSettled');
    const closeEv = eventPayload(r, '::leverage::TicketClosed');
    const doneEv  = eventPayload(r, '::combo::ComboSettled');
    console.log(`  leg1 (leverage): won=${fieldBool(legEv, 'won')} equity_to_owner=${fieldBigInt(closeEv, 'to_owner')}`);
    console.log(`  ComboSettled: status=${fieldBigInt(doneEv, 'status')} total=${fieldBigInt(doneEv, 'total_payout')}`);
    // Equity was already transferred to owner; combo accumulated only has predict payout
    assert(fieldBigInt(doneEv, 'total_payout') > 0n, 'accumulated payout > 0 (range won)');
  }

  // Claim: only range payout claimable; leverage equity already received
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::claim_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u64(comboId)],
    });
    const r = await exec(c, tx, kp, 'claim_combo (C)');
    const ev = eventPayload(r, '::vault::ComboClaimed');
    const payout = fieldBigInt(ev, 'payout');
    assert(payout > 0n, 'claim payout > 0 (predict range leg)');
    console.log(`  ✓ ComboClaimed: predict payout=$${(Number(payout) / 1e6).toFixed(2)} dUSDC (leverage already paid)`);
  }
  console.log('  ✓ Scenario C passed');
}

// ── Scenario D: Leverage leg in parlay → ELeverageInParlay ───────────────────

async function scenarioD(
  c: SuiClient, kp: Ed25519Keypair, m: Manifest,
  vault: string,
) {
  console.log('\n─── Scenario D: Leverage leg in parlay → should abort ───');
  const cerida    = need(m, 'ceridaPkg');
  const dusdcType = need(m, 'dusdcType');
  const book      = need(m, 'leverageBookId');
  const predict   = need(m, 'predict');
  const pool      = need(m, 'marginPoolId');

  const { oracleId, expiry } = await createShortOracle(c, kp, m, 120_000n, 'scenario-D oracle');

  // Open a leverage position to use as a leg
  let positionId = 0n;
  {
    await refreshOracle(c, kp, m, oracleId);
    const tx = new Transaction();
    const [mCoin] = tx.splitCoins(
      tx.object(await dusdcCoin(c, kp.toSuiAddress(), dusdcType)),
      [tx.pure.u64(10n * DUSDC_SCALE)],
    );
    tx.moveCall({
      target: `${cerida}::leverage::open_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracleId),
        tx.pure.id(oracleId), tx.pure.u64(expiry),
        tx.pure.u64(63_000n * PRICE_SCALE), tx.pure.bool(true),
        mCoin, tx.pure.u64(50n * DUSDC_SCALE), tx.pure.u64(4500n),
        tx.pure.u64(0n), tx.pure.u64(0n), tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'open leverage position (D)');
    positionId = fieldBigInt(eventPayload(r, '::leverage::TicketOpened'), 'position_id');
    console.log(`  TicketOpened: position_id=${positionId}`);
  }

  // Build a PARLAY combo with a leverage leg → finalize_combo should abort (ELeverageInParlay)
  {
    const coin = await dusdcCoin(c, kp.toSuiAddress(), dusdcType);
    const tx = new Transaction();
    const [e0] = tx.splitCoins(tx.object(coin), [tx.pure.u64(100n * DUSDC_SCALE)]);
    const [cid] = tx.moveCall({
      target: `${cerida}::vault::begin_combo`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u8(1), tx.pure.u8(6)], // PARLAY, CUSTOM
    });
    tx.moveCall({
      target: `${cerida}::vault::add_binary_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid, tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(63_000n * PRICE_SCALE), tx.pure.bool(true), tx.pure.u64(50n * DUSDC_SCALE), tx.pure.u64(0n), e0],
    });
    tx.moveCall({
      target: `${cerida}::vault::add_leverage_leg`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(book), cid, tx.pure.u64(positionId), tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(50n * DUSDC_SCALE)],
    });
    tx.moveCall({
      target: `${cerida}::vault::finalize_combo`, // ← aborts with ELeverageInParlay
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), cid],
    });
    await exec(c, tx, kp, 'finalize PARLAY combo with leverage leg (expect ELeverageInParlay)', { expectFail: true });
  }

  // Clean up: close the position (it was never locked — request failed before lock)
  {
    await refreshOracle(c, kp, m, oracleId);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::leverage::close`,
      typeArguments: [dusdcType],
      arguments: [tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracleId), tx.pure.u64(positionId), tx.object(CLOCK)],
    });
    await exec(c, tx, kp, 'close position after failed parlay lock (D)');
    console.log('  Position still closeable after failed parlay request ✓');
  }
  console.log('  ✓ Scenario D passed');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const c  = client();
  const kp = deployer();
  const m  = loadManifest();
  await fund(kp.toSuiAddress());

  // Reuse the vault + manager created by flow.ts (they persist in the manifest)
  let vault   = m['vault'];
  let manager = m['manager'];

  if (!vault || !manager) {
    console.log('No vault in manifest — creating fresh vault + manager…');
    const cerida    = need(m, 'ceridaPkg');
    const dusdcType = need(m, 'dusdcType');
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::create`,
      typeArguments: [dusdcType],
      arguments: [],
    });
    const r = await exec(c, tx, kp, 'vault::create');
    vault   = (r.objectChanges ?? []).find((x: any) => x.type === 'created' && x.objectType?.includes('::vault::CeridaVault'))?.objectId;
    manager = (r.objectChanges ?? []).find((x: any) => x.type === 'created' && x.objectType?.includes('::predict_manager::PredictManager'))?.objectId;
    if (!vault || !manager) throw new Error('failed to create vault/manager');
    m['vault'] = vault; m['manager'] = manager;
    console.log('vault =', vault, '\nmanager =', manager);
  } else {
    console.log('Using existing vault =', vault);
  }

  await scenarioA(c, kp, m, vault, manager);
  await scenarioB(c, kp, m, vault, manager);
  await scenarioC(c, kp, m, vault, manager);
  await scenarioD(c, kp, m, vault);

  console.log('\n═══ All combo scenarios passed ═══');
}

main().catch((e) => { console.error(e); process.exit(1); });
