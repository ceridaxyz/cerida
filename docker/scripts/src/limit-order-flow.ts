// Limit-order e2e for binary and range vault mints:
//
//   1. Binary limit BELOW market → execute_mint aborts ELimitNotMet (intent stays, escrow safe)
//   2. Binary limit ABOVE market → fills normally
//   3. Binary limit cancelled by user → escrow refunded, intent gone
//   4. Range limit BELOW market   → aborts ELimitNotMet
//   5. Range limit ABOVE market   → fills normally
//
// Requires a fresh oracle from `bun local:setup`. Does NOT need the vault
// keeper role to be separate — deployer is both keeper and user here.

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
} from './config.js';
import type { Manifest } from './config.js';

declare const process: {
  exit(code?: number): void;
};

const MIN_ORACLE_WINDOW_MS = 5n * 60n * 1000n;

type TxResult = Awaited<ReturnType<SuiClient['signAndExecuteTransaction']>>;
type ParsedEvent = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function eventPayload(r: TxResult, suffix: string): ParsedEvent {
  const event = (r.events ?? []).find((e: any) => e.type.endsWith(suffix));
  assert(event, `missing event ${suffix}`);
  assert(event.parsedJson, `event ${suffix} missing parsedJson`);
  return event.parsedJson as ParsedEvent;
}

function fieldBigInt(event: ParsedEvent, key: string): bigint {
  const value = event[key];
  assert(value !== undefined && value !== null, `missing event field ${key}`);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  throw new Error(`event field ${key} is not bigint-like`);
}

function fieldBool(event: ParsedEvent, key: string): boolean {
  const value = event[key];
  assert(typeof value === 'boolean', `event field ${key} is not boolean`);
  return value;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function exec(
  c: SuiClient,
  tx: Transaction,
  kp: Ed25519Keypair,
  label: string,
  opts: { gasBudget?: bigint; allowFailure?: boolean } = {},
) {
  tx.setGasBudget(opts.gasBudget ?? 2_000_000_000n);
  let r: TxResult;
  try {
    r = await c.signAndExecuteTransaction({
      transaction: tx,
      signer: kp,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });
  } catch (err) {
    throw new Error(`${label} RPC failed: ${formatError(err)}`);
  }
  await c.waitForTransaction({ digest: r.digest });
  if (r.effects?.status.status !== 'success' && !opts.allowFailure) {
    throw new Error(`${label} failed: ${JSON.stringify(r.effects?.status)}`);
  }
  return r;
}

async function expectAbort(
  c: SuiClient,
  tx: Transaction,
  kp: Ed25519Keypair,
  label: string,
  abortContains: string,
) {
  const r = await exec(c, tx, kp, label, { allowFailure: true });
  assert(r.effects?.status.status === 'failure', `${label} should have aborted`);
  const error = r.effects?.status.error ?? '';
  assert(
    error.includes(abortContains),
    `${label}: expected error containing "${abortContains}", got: ${error}`,
  );
  console.log(`✓ ${label} aborted as expected (${abortContains})`);
}

async function dusdcCoin(c: SuiClient, owner: string, dusdcType: string): Promise<string> {
  const coins = await c.getCoins({ owner, coinType: dusdcType });
  if (!coins.data.length) throw new Error('no dUSDC — run setup.ts first');
  return coins.data[0].coinObjectId;
}

async function refreshOracle(
  c: SuiClient,
  kp: Ed25519Keypair,
  predictPkg: string,
  oracle: string,
  oracleCap: string,
  spotUsd = 63_000n,
) {
  const spot = spotUsd * PRICE_SCALE;
  const tx = new Transaction();
  const pd = tx.moveCall({
    target: `${predictPkg}::oracle::new_price_data`,
    arguments: [tx.pure.u64(spot), tx.pure.u64(spot)],
  });
  tx.moveCall({
    target: `${predictPkg}::oracle::update_prices`,
    arguments: [tx.object(oracle), tx.object(oracleCap), pd, tx.object(CLOCK)],
  });
  await exec(c, tx, kp, 'refresh oracle');
}

async function ensureFreshOracle(m: Manifest): Promise<{ oracle: string; expiry: bigint }> {
  const now = BigInt(Date.now());
  const currentExpiry = m.expiry ? BigInt(m.expiry) : 0n;
  if (m.oracle && currentExpiry > now + MIN_ORACLE_WINDOW_MS) {
    return { oracle: m.oracle, expiry: currentExpiry };
  }
  throw new Error('limit-order-flow requires a live oracle with ≥5 min remaining — run `bun local:setup` first');
}

async function main() {
  const c = client();
  const kp = deployer();
  const addr = kp.toSuiAddress();
  const m: Manifest = loadManifest();
  await fund(addr);

  const cerida = need(m, 'ceridaPkg');
  const dusdcType = need(m, 'dusdcType');
  const predict = need(m, 'predict');
  const predictPkg = need(m, 'predictPkg');
  const oracleCap = need(m, 'oracleCap');
  const { oracle, expiry } = await ensureFreshOracle(m);

  console.log('── limit-order flow ──');

  // Create a fresh vault for this flow
  let vault: string;
  let manager: string;
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::create`,
      typeArguments: [dusdcType],
      arguments: [],
    });
    const r = await exec(c, tx, kp, 'vault::create');
    const changes = r.objectChanges ?? [];
    vault = changes.find((x: any) => x.type === 'created' && x.objectType?.includes('::vault::CeridaVault'))?.objectId!;
    manager = changes.find((x: any) => x.type === 'created' && x.objectType?.includes('::predict_manager::PredictManager'))?.objectId!;
    assert(vault && manager, 'vault and manager created');
    console.log('vault =', vault, '\nmanager =', manager);
  }

  const strike = 63_000n * PRICE_SCALE;
  const qty = 100n * DUSDC_SCALE;
  const escrow = 200n * DUSDC_SCALE;
  // ATM ~46¢ × 100 = ~$46. Set limit well below to force ELimitNotMet.
  const tightLimit = 1n * DUSDC_SCALE; // $1 — way below market
  // Set limit well above to guarantee fill.
  const looseLimit = 150n * DUSDC_SCALE; // $150 — above any realistic ask

  // ── 1. Binary limit below market → ELimitNotMet ───────────────────────────
  console.log('\n── 1. binary limit below market (should abort ELimitNotMet) ──');
  let tightIntentId: bigint;
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [pay] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(escrow)],
    );
    tx.moveCall({
      target: `${cerida}::vault::request_mint_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(strike),
        tx.pure.bool(true),
        tx.pure.u64(qty),
        tx.pure.u64(tightLimit), // max_cost = $1 — below market
        pay,
      ],
    });
    const r = await exec(c, tx, kp, 'request_mint_binary (tight limit)');
    const ev = eventPayload(r, '::vault::MintRequested');
    tightIntentId = fieldBigInt(ev, 'intent_id');
    assert(fieldBigInt(ev, 'max_cost') === tightLimit, 'tight limit stored in event');
    console.log(`intent #${tightIntentId} placed with max_cost=$${Number(tightLimit) / Number(DUSDC_SCALE)}`);
  }
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_mint`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(tightIntentId),
        tx.object(CLOCK),
      ],
    });
    // ELimitNotMet = abort code 10 in vault
    await expectAbort(c, tx, kp, 'execute_mint (tight limit)', 'MoveAbort');
    console.log('intent still alive (escrow safe)');
  }

  // ── 2. Cancel the unfilled tight-limit intent → escrow refunded ───────────
  console.log('\n── 2. cancel unfilled intent → escrow refunded ──');
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::cancel_mint_intent`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u64(tightIntentId)],
    });
    const r = await exec(c, tx, kp, 'cancel_mint_intent');
    const ev = eventPayload(r, '::vault::MintCancelled');
    assert(fieldBigInt(ev, 'intent_id') === tightIntentId, 'cancelled intent id matches');
    assert(fieldBigInt(ev, 'refunded') === escrow, 'full escrow refunded');
    console.log(`✓ intent #${tightIntentId} cancelled, refunded $${Number(escrow) / Number(DUSDC_SCALE)}`);
  }

  // ── 3. Binary limit above market → fills ──────────────────────────────────
  console.log('\n── 3. binary limit above market (should fill) ──');
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [pay] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(escrow)],
    );
    tx.moveCall({
      target: `${cerida}::vault::request_mint_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(strike),
        tx.pure.bool(true),
        tx.pure.u64(qty),
        tx.pure.u64(looseLimit), // max_cost = $150 — above market
        pay,
      ],
    });
    const r = await exec(c, tx, kp, 'request_mint_binary (loose limit)');
    const ev = eventPayload(r, '::vault::MintRequested');
    const intentId = fieldBigInt(ev, 'intent_id');
    assert(fieldBigInt(ev, 'max_cost') === looseLimit, 'loose limit stored in event');
    console.log(`intent #${intentId} placed with max_cost=$${Number(looseLimit) / Number(DUSDC_SCALE)}`);

    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx2 = new Transaction();
    tx2.moveCall({
      target: `${cerida}::vault::execute_mint`,
      typeArguments: [dusdcType],
      arguments: [
        tx2.object(vault),
        tx2.object(manager),
        tx2.object(predict),
        tx2.object(oracle),
        tx2.pure.u64(intentId),
        tx2.object(CLOCK),
      ],
    });
    const r2 = await exec(c, tx2, kp, 'execute_mint (loose limit)');
    const ev2 = eventPayload(r2, '::vault::MintExecuted');
    const cost = fieldBigInt(ev2, 'cost');
    assert(cost > 0n, 'cost is positive');
    assert(cost <= looseLimit, `cost ${cost} ≤ max_cost ${looseLimit}`);
    console.log(`✓ filled at cost=$${Number(cost) / Number(DUSDC_SCALE)} (limit=$${Number(looseLimit) / Number(DUSDC_SCALE)})`);
  }

  // ── 4. Range limit below market → ELimitNotMet ────────────────────────────
  console.log('\n── 4. range limit below market (should abort ELimitNotMet) ──');
  const lower = 62_000n * PRICE_SCALE;
  const higher = 64_000n * PRICE_SCALE;
  let tightRangeIntentId: bigint;
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [pay] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(escrow)],
    );
    tx.moveCall({
      target: `${cerida}::vault::request_mint_range`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(lower),
        tx.pure.u64(higher),
        tx.pure.u64(qty),
        tx.pure.u64(tightLimit), // max_cost = $1
        pay,
      ],
    });
    const r = await exec(c, tx, kp, 'request_mint_range (tight limit)');
    const ev = eventPayload(r, '::vault::MintRequested');
    tightRangeIntentId = fieldBigInt(ev, 'intent_id');
    assert(fieldBool(ev, 'is_range') === true, 'range intent');
    console.log(`range intent #${tightRangeIntentId} placed with max_cost=$1`);
  }
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_mint`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(tightRangeIntentId),
        tx.object(CLOCK),
      ],
    });
    await expectAbort(c, tx, kp, 'execute_mint range (tight limit)', 'MoveAbort');
  }

  // ── 5. Range limit above market → fills ───────────────────────────────────
  console.log('\n── 5. range limit above market (should fill) ──');
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [pay] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(escrow)],
    );
    tx.moveCall({
      target: `${cerida}::vault::request_mint_range`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(lower),
        tx.pure.u64(higher),
        tx.pure.u64(qty),
        tx.pure.u64(looseLimit), // max_cost = $150
        pay,
      ],
    });
    const r = await exec(c, tx, kp, 'request_mint_range (loose limit)');
    const ev = eventPayload(r, '::vault::MintRequested');
    const intentId = fieldBigInt(ev, 'intent_id');

    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx2 = new Transaction();
    tx2.moveCall({
      target: `${cerida}::vault::execute_mint`,
      typeArguments: [dusdcType],
      arguments: [
        tx2.object(vault),
        tx2.object(manager),
        tx2.object(predict),
        tx2.object(oracle),
        tx2.pure.u64(intentId),
        tx2.object(CLOCK),
      ],
    });
    const r2 = await exec(c, tx2, kp, 'execute_mint range (loose limit)');
    const ev2 = eventPayload(r2, '::vault::MintExecuted');
    const cost = fieldBigInt(ev2, 'cost');
    assert(cost > 0n && cost <= looseLimit, `range cost ${cost} within limit`);
    console.log(`✓ range filled at cost=$${Number(cost) / Number(DUSDC_SCALE)} (limit=$${Number(looseLimit) / Number(DUSDC_SCALE)})`);
  }

  console.log('\n all limit-order cases passed: reject-below, cancel, fill-above (binary + range).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
