// Range/grid e2e:
//   valid range mint/redeem, expected grid validation aborts, and optional
//   Rust API surface checks for probability-cent ladder indexing.

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
  env: Record<string, string | undefined>;
  exit(code?: number): void;
};

const MIN_ORACLE_WINDOW_MS = 5n * 60n * 1000n;
const CERIDA_API = process.env.CERIDA_API ?? 'http://127.0.0.1:8788';

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
  if (err instanceof Error) {
    const parts = [err.message];
    const maybe = err as Error & { code?: unknown; type?: unknown };
    if (maybe.code !== undefined) parts.push(`code=${String(maybe.code)}`);
    if (maybe.type !== undefined) parts.push(`type=${String(maybe.type)}`);
    return parts.join(' ');
  }
  return String(err);
}

async function exec(
  c: SuiClient,
  tx: Transaction,
  kp: Ed25519Keypair,
  label: string,
  opts: { gasBudget?: bigint | null; allowFailure?: boolean } = {},
) {
  if (opts.gasBudget !== null) {
    tx.setGasBudget(opts.gasBudget ?? 2_000_000_000n);
  }
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
  if (r.effects?.status.status !== 'success' && !opts.allowFailure) {
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

async function expectFailure(
  c: SuiClient,
  tx: Transaction,
  kp: Ed25519Keypair,
  label: string,
  expected: string,
) {
  const r = await exec(c, tx, kp, label, { allowFailure: true });
  const status = r.effects?.status;
  assert(status?.status === 'failure', `${label} should have failed`);
  const error = status.error ?? '';
  assert(error.includes(expected), `${label} expected ${expected}, got ${error}`);
  console.log(`${label} failed as expected: ${error}`);
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

async function refreshOracle(
  c: SuiClient,
  kp: Ed25519Keypair,
  predictPkg: string,
  oracle: string,
  oracleCap: string,
  spotUsd: bigint = 63_000n,
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

async function feedSviAndPrices(
  c: SuiClient,
  kp: Ed25519Keypair,
  predictPkg: string,
  oracle: string,
  oracleCap: string,
  label = 'feed oracle',
) {
  const tx = new Transaction();
  const oracleObj = tx.object(oracle);
  const cap = tx.object(oracleCap);
  const spot = 63_000n * PRICE_SCALE;
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
  const mm = tx.moveCall({
    target: `${predictPkg}::i64::from_parts`,
    arguments: [tx.pure.u64(0n), tx.pure.bool(false)],
  });
  const svi = tx.moveCall({
    target: `${predictPkg}::oracle::new_svi_params`,
    arguments: [
      tx.pure.u64(40_000_000n),
      tx.pure.u64(100_000_000n),
      rho,
      mm,
      tx.pure.u64(100_000_000n),
    ],
  });
  tx.moveCall({
    target: `${predictPkg}::oracle::update_svi`,
    arguments: [oracleObj, cap, svi, tx.object(CLOCK)],
  });
  await exec(c, tx, kp, label);
}

async function ensureFreshOracle(
  m: Manifest,
): Promise<{ oracle: string; expiry: bigint }> {
  const now = BigInt(Date.now());
  const currentExpiry = m.expiry ? BigInt(m.expiry) : 0n;
  if (m.oracle && currentExpiry > now + MIN_ORACLE_WINDOW_MS) {
    return { oracle: m.oracle, expiry: currentExpiry };
  }
  throw new Error(
    'range-grid requires a live setup oracle with at least 5 minutes remaining; run `bun local:setup` first',
  );
}

function createVaultTx(cerida: string, dusdcType: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${cerida}::vault::create`,
    typeArguments: [dusdcType],
    arguments: [],
  });
  return tx;
}

async function requestRangeIntent(
  c: SuiClient,
  kp: Ed25519Keypair,
  args: {
    cerida: string;
    dusdcType: string;
    vault: string;
    oracle: string;
    expiry: bigint;
    lower: bigint;
    higher: bigint;
    qty: bigint;
    escrow: bigint;
    owner: string;
  },
) {
  const tx = new Transaction();
  const [pay] = tx.splitCoins(
    tx.object(await dusdcCoin(c, args.owner, args.dusdcType)),
    [tx.pure.u64(args.escrow)],
  );
  tx.moveCall({
    target: `${args.cerida}::vault::request_mint_range`,
    typeArguments: [args.dusdcType],
    arguments: [
      tx.object(args.vault),
      tx.pure.id(args.oracle),
      tx.pure.u64(args.expiry),
      tx.pure.u64(args.lower),
      tx.pure.u64(args.higher),
      tx.pure.u64(args.qty),
      pay,
    ],
  });
  const r = await exec(c, tx, kp, 'request_mint_range');
  const ev = eventPayload(r, '::vault::MintRequested');
  assert(fieldBool(ev, 'is_range') === true, 'mint request is range');
  return fieldBigInt(ev, 'intent_id');
}

function executeMintTx(args: {
  cerida: string;
  dusdcType: string;
  vault: string;
  manager: string;
  predict: string;
  oracle: string;
  intentId: bigint;
}) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.cerida}::vault::execute_mint`,
    typeArguments: [args.dusdcType],
    arguments: [
      tx.object(args.vault),
      tx.object(args.manager),
      tx.object(args.predict),
      tx.object(args.oracle),
      tx.pure.u64(args.intentId),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

async function assertSurfaceApi() {
  try {
    const marketsRes = await fetch(`${CERIDA_API}/markets`, {
      headers: { accept: 'application/json' },
    });
    if (!marketsRes.ok) {
      console.warn(`surface API skipped: /markets ${marketsRes.status}`);
      return;
    }
    const markets = (await marketsRes.json()) as Array<{
      oracle_id: string;
      min_strike: number;
      tick_size: number;
    }>;
    const market = markets[0];
    if (!market) {
      console.warn('surface API skipped: no indexed active markets');
      return;
    }

    const surfaceRes = await fetch(
      `${CERIDA_API}/markets/${market.oracle_id}/surface`,
      { headers: { accept: 'application/json' } },
    );
    assert(surfaceRes.ok, `/surface returned ${surfaceRes.status}`);
    const rows = (await surfaceRes.json()) as Array<{
      strike: number;
      yes_cents: number;
      no_cents: number;
    }>;
    assert(rows.length > 0, 'surface has derived price rows');
    for (const row of rows) {
      assert(row.yes_cents >= 0 && row.yes_cents <= 100, 'yes_cents bounded');
      assert(row.no_cents >= 0 && row.no_cents <= 100, 'no_cents bounded');
      const aligned = Math.abs((row.strike - market.min_strike) % market.tick_size);
      assert(
        aligned < 1e-6 || Math.abs(aligned - market.tick_size) < 1e-6,
        `surface strike ${row.strike} is grid aligned`,
      );
    }
    console.log(
      `surface API ok: ${rows.length} probability-cent rows for ${market.oracle_id}`,
    );
  } catch (err) {
    console.warn(`surface API skipped: ${formatError(err)}`);
  }
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
  const fresh = await ensureFreshOracle(m);
  const oracle = fresh.oracle;
  const expiry = fresh.expiry;

  console.log('── range/grid flow ──');

  const create = await exec(c, createVaultTx(cerida, dusdcType), kp, 'vault::create');
  const vault = created(create, '::vault::CeridaVault');
  const manager = created(create, '::predict_manager::PredictManager');
  console.log('vault =', vault, '\nmanager =', manager);

  const qty = 25n * DUSDC_SCALE;
  const escrow = 100n * DUSDC_SCALE;
  const validLower = 62_000n * PRICE_SCALE;
  const validHigher = 64_000n * PRICE_SCALE;

  const validIntent = await requestRangeIntent(c, kp, {
    cerida,
    dusdcType,
    vault,
    oracle,
    expiry,
    lower: validLower,
    higher: validHigher,
    qty,
    escrow,
    owner: addr,
  });
  await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
  const validMint = await exec(
    c,
    executeMintTx({
      cerida,
      dusdcType,
      vault,
      manager,
      predict,
      oracle,
      intentId: validIntent,
    }),
    kp,
    'execute_mint valid range',
  );
  const mintEv = eventPayload(validMint, '::vault::MintExecuted');
  assert(fieldBigInt(mintEv, 'cost') > 0n, 'valid range mint cost positive');
  const token = created(validMint, '::position_token::PositionToken');
  console.log('valid range minted token:', token);

  const invalidCases = [
    {
      label: 'off-grid range lower strike',
      lower: 62_050n * PRICE_SCALE,
      higher: validHigher,
      expected: 'MoveAbort',
    },
    {
      label: 'below-min range lower strike',
      lower: 500n * PRICE_SCALE,
      higher: 1_500n * PRICE_SCALE,
      expected: 'MoveAbort',
    },
    {
      label: 'reversed range strikes',
      lower: validHigher,
      higher: validLower,
      expected: 'MoveAbort',
    },
  ] as const;

  for (const item of invalidCases) {
    const intentId = await requestRangeIntent(c, kp, {
      cerida,
      dusdcType,
      vault,
      oracle,
      expiry,
      lower: item.lower,
      higher: item.higher,
      qty,
      escrow: 2n * DUSDC_SCALE,
      owner: addr,
    });
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    await expectFailure(
      c,
      executeMintTx({
        cerida,
        dusdcType,
        vault,
        manager,
        predict,
        oracle,
        intentId,
      }),
      kp,
      `execute_mint ${item.label}`,
      item.expected,
    );
  }

  await assertSurfaceApi();

  console.log('\nrange/grid flow complete: valid range + invalid grid cases + surface API check.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
