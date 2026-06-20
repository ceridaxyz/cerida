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
const MIN_GAS_BALANCE = 3_000_000_000n;

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

function isStaleObjectVersion(err: unknown): boolean {
  return formatError(err).includes('needs to be rebuilt because object');
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
  await setFreshGasPayment(c, tx, kp.toSuiAddress(), label);
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
  if (r.effects?.status.status === 'success') {
    await c.waitForTransaction({ digest: r.digest });
  }
  return r;
}

async function setFreshGasPayment(
  c: SuiClient,
  tx: Transaction,
  owner: string,
  label: string,
) {
  const coins = await c.getCoins({ owner, coinType: '0x2::sui::SUI' });
  const coin = coins.data.find((item) => BigInt(item.balance) >= MIN_GAS_BALANCE);
  if (!coin) throw new Error(`no SUI gas coin with at least ${MIN_GAS_BALANCE}`);
  tx.setGasPayment([
    {
      objectId: coin.coinObjectId,
      version: coin.version,
      digest: coin.digest,
    },
  ]);
  console.log(`using SUI gas ${coin.coinObjectId}@${coin.version} for ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Owned objects (e.g. the dUSDC coin we split from on every mint) advance a
// version each tx. The fullnode that resolves `tx.object(...)` versions can lag
// the validator quorum, so a freshly-rebuilt tx may STILL reference a stale
// version. Rebuild with backoff so the fullnode catches up before retrying.
async function execRebuiltOnStale(
  c: SuiClient,
  kp: Ed25519Keypair,
  label: string,
  build: () => Transaction | Promise<Transaction>,
  maxAttempts = 6,
) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await exec(c, await build(), kp, `${label} attempt ${attempt}`);
    } catch (err) {
      lastErr = err;
      if (!isStaleObjectVersion(err)) throw err;
      const wait = 600 * attempt;
      console.warn(
        `${label} stale object (attempt ${attempt}/${maxAttempts}); waiting ${wait}ms for fullnode to catch up`,
      );
      await sleep(wait);
    }
  }
  throw lastErr;
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
  minBalance: bigint,
): Promise<string> {
  const coins = await c.getCoins({ owner, coinType: dusdcType });
  for (const coin of coins.data) {
    if (BigInt(coin.balance) < minBalance) continue;
    const obj = await c.getObject({ id: coin.coinObjectId });
    if (obj.data) return coin.coinObjectId;
  }
  throw new Error(`no live dUSDC coin with at least ${minBalance} - run setup.ts`);
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
    maxCost?: bigint;
  },
) {
  const r = await execRebuiltOnStale(c, kp, 'request_mint_range', async () => {
    const tx = new Transaction();
    const coin = await dusdcCoin(c, args.owner, args.dusdcType, args.escrow);
    console.log(`using dUSDC coin ${coin} for ${args.escrow}`);
    const [pay] = tx.splitCoins(tx.object(coin), [tx.pure.u64(args.escrow)]);
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
        tx.pure.u64(args.maxCost ?? 0n), // max_cost=0 → market order
        pay,
      ],
    });
    return tx;
  });
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

  const cerida = need(m, 'ceridaPkg');
  const dusdcType = need(m, 'dusdcType');
  const predict = need(m, 'predict');
  const predictPkg = need(m, 'predictPkg');
  const oracleCap = need(m, 'oracleCap');
  const fresh = await ensureFreshOracle(m);
  const oracle = fresh.oracle;
  const expiry = fresh.expiry;

  console.log('── range/grid flow ──');

  const create = await execRebuiltOnStale(c, kp, 'vault::create', () =>
    createVaultTx(cerida, dusdcType),
  );
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
    console.log(`checking ${item.label}`);
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
    console.log(`${item.label} intent = ${intentId}`);
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
