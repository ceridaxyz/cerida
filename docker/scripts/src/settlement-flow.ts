// One-minute settlement regression:
//   create short Predict oracle -> mint before expiry -> settle oracle after
//   expiry -> redeem through the settled path and assert is_settled.

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
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

const MARKET_MS = 60n * 1000n;
const SETTLEMENT_BUFFER_MS = 2500n;
const INITIAL_SPOT = 63_000n;
const SETTLEMENT_SPOT = 70_000n;

type TxResult = Awaited<ReturnType<SuiClient['signAndExecuteTransaction']>>;
type ParsedEvent = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function exec(
  c: SuiClient,
  tx: Transaction,
  kp: Ed25519Keypair,
  label: string,
  opts: { gasBudget?: bigint | null } = {},
) {
  if (opts.gasBudget !== null) {
    tx.setGasBudget(opts.gasBudget ?? 2_000_000_000n);
  }
  const r = await c.signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (r.effects?.status.status !== 'success') {
    throw new Error(`${label} failed: ${JSON.stringify(r.effects?.status)}`);
  }
  await c.waitForTransaction({ digest: r.digest });
  return r;
}

function created(r: any, needle: string): string {
  const hit = (r.objectChanges ?? []).find(
    (x: any) => x.type === 'created' && x.objectType?.includes(needle),
  );
  if (!hit) throw new Error(`no created object ~'${needle}'`);
  return hit.objectId;
}

async function dusdcCoin(
  c: SuiClient,
  owner: string,
  dusdcType: string,
): Promise<string> {
  const coins = await c.getCoins({ owner, coinType: dusdcType });
  if (coins.data.length === 0) throw new Error('no dUSDC - run setup.ts');
  return coins.data[0].coinObjectId;
}

async function ownedPositionTokenIds(
  c: SuiClient,
  owner: string,
  cerida: string,
): Promise<string[]> {
  const toks = await c.getOwnedObjects({
    owner,
    filter: { StructType: `${cerida}::position_token::PositionToken` },
    options: { showType: true },
  });
  return toks.data
    .map((item) => item.data?.objectId)
    .filter((id): id is string => Boolean(id));
}

async function updateOraclePrice(
  c: SuiClient,
  kp: Ed25519Keypair,
  predictPkg: string,
  oracle: string,
  oracleCap: string,
  spotUsd: bigint,
  label: string,
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
  await exec(c, tx, kp, label);
}

async function feedOracle(
  c: SuiClient,
  kp: Ed25519Keypair,
  predictPkg: string,
  oracle: string,
  oracleCap: string,
) {
  const tx = new Transaction();
  const oracleObj = tx.object(oracle);
  const cap = tx.object(oracleCap);
  const spot = INITIAL_SPOT * PRICE_SCALE;
  const pd = tx.moveCall({
    target: `${predictPkg}::oracle::new_price_data`,
    arguments: [tx.pure.u64(spot), tx.pure.u64(spot)],
  });
  tx.moveCall({
    target: `${predictPkg}::oracle::update_prices`,
    arguments: [oracleObj, cap, pd, tx.object(CLOCK)],
  });

  const rho = tx.moveCall({
    target: `${predictPkg}::i64::from_parts`,
    arguments: [tx.pure.u64(300_000_000n), tx.pure.bool(true)],
  });
  const m = tx.moveCall({
    target: `${predictPkg}::i64::from_parts`,
    arguments: [tx.pure.u64(0n), tx.pure.bool(false)],
  });
  const svi = tx.moveCall({
    target: `${predictPkg}::oracle::new_svi_params`,
    arguments: [
      tx.pure.u64(40_000_000n),
      tx.pure.u64(100_000_000n),
      rho,
      m,
      tx.pure.u64(100_000_000n),
    ],
  });
  tx.moveCall({
    target: `${predictPkg}::oracle::update_svi`,
    arguments: [oracleObj, cap, svi, tx.object(CLOCK)],
  });
  await exec(c, tx, kp, 'feed settlement oracle');
}

async function createSettlementOracle(
  c: SuiClient,
  kp: Ed25519Keypair,
  m: Manifest,
): Promise<{ oracle: string; expiry: bigint }> {
  const predictPkg = need(m, 'predictPkg');
  const expiry = BigInt(Date.now()) + MARKET_MS;

  const tx = new Transaction();
  tx.moveCall({
    target: `${predictPkg}::registry::create_oracle`,
    arguments: [
      tx.object(need(m, 'registry')),
      tx.object(need(m, 'predict')),
      tx.object(need(m, 'adminCap')),
      tx.object(need(m, 'oracleCap')),
      tx.pure.string('BTC'),
      tx.pure.u64(expiry),
      tx.pure.u64(1000n * PRICE_SCALE),
      tx.pure.u64(100n * PRICE_SCALE),
    ],
  });
  const r = await exec(c, tx, kp, 'create 1 minute oracle', {
    gasBudget: null,
  });
  const oracle = created(r, '::oracle::OracleSVI');

  const tx2 = new Transaction();
  const oracleObj = tx2.object(oracle);
  const cap = tx2.object(need(m, 'oracleCap'));
  tx2.moveCall({
    target: `${predictPkg}::registry::register_oracle_cap`,
    arguments: [oracleObj, tx2.object(need(m, 'adminCap')), cap],
  });
  tx2.moveCall({
    target: `${predictPkg}::oracle::activate`,
    arguments: [oracleObj, cap, tx2.object(CLOCK)],
  });
  await exec(c, tx2, kp, 'register + activate 1 minute oracle');
  await feedOracle(c, kp, predictPkg, oracle, need(m, 'oracleCap'));

  console.log(
    'settlement oracle =',
    oracle,
    'expiry =',
    new Date(Number(expiry)).toISOString(),
  );
  return { oracle, expiry };
}

async function main() {
  const c = client();
  const kp = deployer();
  const addr = kp.toSuiAddress();
  const m = loadManifest();
  try {
    await fund(addr);
  } catch {
    console.warn('faucet unavailable; continuing with deployer gas');
  }

  const cerida = need(m, 'ceridaPkg');
  const dusdcType = need(m, 'dusdcType');
  const predict = need(m, 'predict');
  const predictPkg = need(m, 'predictPkg');
  const oracleCap = need(m, 'oracleCap');

  console.log('── settlement flow (1 minute market) ──');
  const settlement = await createSettlementOracle(c, kp, m);

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
    vault = created(r, '::vault::CeridaVault');
    manager = created(r, '::predict_manager::PredictManager');
    console.log('vault =', vault, '\nmanager =', manager);
  }

  const strike = 63_000n * PRICE_SCALE;
  const qty = 25n * DUSDC_SCALE;
  const escrow = 100n * DUSDC_SCALE;
  let intentId = 0n;
  let redeemId = 0n;
  let token: string;

  {
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
        tx.pure.id(settlement.oracle),
        tx.pure.u64(settlement.expiry),
        tx.pure.u64(strike),
        tx.pure.bool(true),
        tx.pure.u64(qty),
        pay,
      ],
    });
    const r = await exec(c, tx, kp, 'request_mint_binary');
    const ev = eventPayload(r, '::vault::MintRequested');
    intentId = fieldBigInt(ev, 'intent_id');
    assert(fieldBool(ev, 'is_range') === false, 'settlement mint is binary');
    assert(fieldBigInt(ev, 'qty') === qty, 'mint qty matches');
    console.log('MintRequested:', ev);
  }

  await updateOraclePrice(
    c,
    kp,
    predictPkg,
    settlement.oracle,
    oracleCap,
    INITIAL_SPOT,
    'refresh oracle before mint',
  );
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_mint`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(settlement.oracle),
        tx.pure.u64(intentId),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'execute_mint');
    const ev = eventPayload(r, '::vault::MintExecuted');
    assert(fieldBigInt(ev, 'intent_id') === intentId, 'mint id matches');
    assert(fieldBigInt(ev, 'cost') > 0n, 'mint cost is positive');
    token = created(r, '::position_token::PositionToken');
    console.log('MintExecuted:', ev);
  }

  const waitMs = Number(
    settlement.expiry + SETTLEMENT_BUFFER_MS - BigInt(Date.now()),
  );
  if (waitMs > 0) {
    console.log(`waiting ${Math.ceil(waitMs / 1000)}s for expiry`);
    await sleep(waitMs);
  }

  await updateOraclePrice(
    c,
    kp,
    predictPkg,
    settlement.oracle,
    oracleCap,
    SETTLEMENT_SPOT,
    'settle oracle at winning spot',
  );
  console.log('oracle settled at $70,000 spot');

  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::request_redeem`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(token), tx.pure.u64(qty)],
    });
    const r = await exec(c, tx, kp, 'request_redeem');
    const ev = eventPayload(r, '::vault::RedeemRequested');
    redeemId = fieldBigInt(ev, 'redeem_id');
    assert(fieldBigInt(ev, 'qty') === qty, 'redeem qty matches');
    console.log('RedeemRequested:', ev);
  }

  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_redeem`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(settlement.oracle),
        tx.pure.u64(redeemId),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'execute_redeem');
    const ev = eventPayload(r, '::vault::RedeemExecuted');
    assert(fieldBigInt(ev, 'redeem_id') === redeemId, 'redeem id matches');
    assert(fieldBigInt(ev, 'qty') === qty, 'redeem qty matches');
    assert(fieldBigInt(ev, 'payout') > 0n, 'settled payout is positive');
    assert(fieldBool(ev, 'is_settled') === true, 'redeem used settled path');
    assert(
      !(await ownedPositionTokenIds(c, addr, cerida)).includes(token),
      'PositionToken burned after settled redeem',
    );
    console.log('RedeemExecuted (settled):', ev);
  }

  console.log(
    '\nsettlement flow complete: one-minute market minted, expired, settled, and redeemed.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
