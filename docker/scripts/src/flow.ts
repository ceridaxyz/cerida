// Simulate the full Cerida flow against the local Predict deployment:
//   vault::create → request_mint_binary → execute_mint → request_redeem → execute_redeem
// then the same for a range. Asserts a PositionToken is issued and a payout returns.
//
// Single-key sim: the deployer is BOTH the vault keeper and the trading user
// (keeper == manager owner is what lets execute_* succeed).

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
  saveManifest,
} from './config.js';

declare const process: {
  exit(code?: number): void;
};

const ORACLE_TTL_MS = 6n * 60n * 60n * 1000n;
const ORACLE_REFRESH_WINDOW_MS = 30n * 60n * 1000n;

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

async function dusdcBalance(
  c: SuiClient,
  owner: string,
  dusdcType: string,
): Promise<bigint> {
  const balance = await c.getBalance({ owner, coinType: dusdcType });
  return BigInt(balance.totalBalance);
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
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: any;
    try {
      r = await c.signAndExecuteTransaction({
        transaction: tx,
        signer: kp,
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
    if (r.effects?.status.status !== 'success') {
      throw new Error(`${label} failed: ${JSON.stringify(r.effects?.status)}`);
    }
    await c.waitForTransaction({ digest: r.digest });
    await new Promise((res) => setTimeout(res, 1500));
    return r;
  }
  throw new Error(`${label}: unreachable`);
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
  if (coins.data.length === 0) throw new Error('no dUSDC — run setup.ts');
  return coins.data[0].coinObjectId;
}

// Push a fresh spot price so the oracle passes assert_live_oracle's 30s
// staleness check. setup.ts feeds the oracle once, but flow runs minutes later
// in a separate process; without a re-feed, execute_mint aborts with
// EOracleStale (oracle_config code 6). In production a feed service does this
// continuously — here we do it inline right before each price-sensitive call.
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
  c: SuiClient,
  kp: Ed25519Keypair,
  m: Manifest,
): Promise<{ oracle: string; expiry: bigint }> {
  const now = BigInt(Date.now());
  const currentExpiry = m.expiry ? BigInt(m.expiry) : 0n;
  if (m.oracle && currentExpiry > now + ORACLE_REFRESH_WINDOW_MS) {
    return { oracle: m.oracle, expiry: currentExpiry };
  }

  const predictPkg = need(m, 'predictPkg');
  const expiry = now + ORACLE_TTL_MS;
  console.log('saved oracle expired/near expiry; creating fresh local oracle');

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
  const r = await exec(c, tx, kp, 'create fresh oracle', { gasBudget: null });
  const oracle = created(r, '::oracle::OracleSVI');
  m.oracle = oracle;
  m.expiry = expiry.toString();
  delete m.oracleActivated;
  saveManifest(m);

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
  await exec(c, tx2, kp, 'register + activate fresh oracle');
  await feedSviAndPrices(
    c,
    kp,
    predictPkg,
    oracle,
    need(m, 'oracleCap'),
    'feed fresh oracle',
  );

  m.oracleActivated = 'true';
  saveManifest(m);
  console.log(
    'fresh oracle =',
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
  const m: Manifest = loadManifest();
  await fund(addr);

  const cerida = need(m, 'ceridaPkg');
  const dusdcType = need(m, 'dusdcType');
  const predict = need(m, 'predict');
  const predictPkg = need(m, 'predictPkg');
  const oracleCap = need(m, 'oracleCap');
  const fresh = await ensureFreshOracle(c, kp, m);
  const oracle = fresh.oracle;
  const expiry = fresh.expiry;
  const flowSummary: Record<string, unknown> = {
    oracle,
    expiry: expiry.toString(),
    user: addr,
  };
  const startingBalance = await dusdcBalance(c, addr, dusdcType);
  console.log('starting dUSDC balance =', startingBalance.toString());

  // 1. Create the vault (+ keeper-owned manager).
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
    const ev = eventPayload(r, '::vault::VaultCreated');
    assert(ev.vault_id === vault, 'VaultCreated vault id matches created object');
    assert(
      ev.manager_id === manager,
      'VaultCreated manager id matches created object',
    );
    console.log('vault =', vault, '\nmanager =', manager);
  }
  flowSummary.vault = vault;
  flowSummary.manager = manager;

  const strike = 63_000n * PRICE_SCALE; // on-grid ($100 tick, ≥ $1,000)
  const qty = 100n * DUSDC_SCALE; // 100 contracts
  const escrow = 200n * DUSDC_SCALE; // slippage cap ($200; cost should be well under)

  // 2. request_mint_binary (continuous strike, UP). max_cost=0 = market order.
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
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(strike),
        tx.pure.bool(true),
        tx.pure.u64(qty),
        tx.pure.u64(0n), // max_cost=0 → market order
        tx.pure.u64(0n), // tp_value=0
        tx.pure.u64(0n), // sl_value=0
        pay,
      ],
    });
    const r = await exec(c, tx, kp, 'request_mint_binary');
    const ev = eventPayload(r, '::vault::MintRequested');
    assert(fieldBigInt(ev, 'intent_id') === 0n, 'binary mint intent id is 0');
    assert(fieldBool(ev, 'is_range') === false, 'binary mint event is not range');
    assert(fieldBigInt(ev, 'qty') === qty, 'binary mint requested qty matches');
    assert(fieldBigInt(ev, 'escrowed') === escrow, 'binary mint escrow matches');
    assert(fieldBigInt(ev, 'max_cost') === 0n, 'binary mint max_cost is 0 (market)');
    console.log('escrowed mint intent #0 (UP $63,000, market order)');
  }

  // 3. execute_mint (keeper). Re-feed the oracle first so it passes the 30s
  //    staleness check (see refreshOracle).
  await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_mint`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(0n),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'execute_mint');
    const ev = eventPayload(r, '::vault::MintExecuted');
    assert(fieldBigInt(ev, 'intent_id') === 0n, 'binary mint executed id is 0');
    assert(fieldBigInt(ev, 'qty') === qty, 'binary mint executed qty matches');
    assert(fieldBigInt(ev, 'cost') > 0n, 'binary mint cost is positive');
    console.log('MintExecuted:', ev);
  }

  // 4. Find the issued PositionToken — read from tx objectChanges to avoid
  //    a getOwnedObjects indexer lag on localnet.
  const binaryTokens = await ownedPositionTokenIds(c, addr, cerida);
  let token: string;
  if (binaryTokens.length > 0) {
    token = binaryTokens[0]!;
  } else {
    // Fallback: query the tx directly for the created PositionToken.
    const txs = await c.queryTransactionBlocks({
      filter: { FromAddress: addr },
      options: { showObjectChanges: true },
      limit: 1,
      order: 'descending',
    });
    const changes = txs.data[0]?.objectChanges ?? [];
    const hit = changes.find(
      (x: any) => x.type === 'created' && x.objectType?.includes('::position_token::PositionToken'),
    ) as any;
    assert(hit?.objectId, 'binary PositionToken issued');
    token = hit.objectId;
  }
  console.log('PositionToken issued:', token);

  // 5. request_redeem + execute_redeem.
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::request_redeem`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(token), tx.pure.u64(qty)],
    });
    const r = await exec(c, tx, kp, 'request_redeem');
    const ev = eventPayload(r, '::vault::RedeemRequested');
    assert(fieldBigInt(ev, 'redeem_id') === 0n, 'binary redeem id is 0');
    assert(fieldBigInt(ev, 'qty') === qty, 'binary redeem qty matches');
  }
  // Re-feed before execute_redeem too — the oracle is still ACTIVE here (expiry
  // is ~1h out) so redeem prices off a live-and-fresh oracle.
  await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_redeem`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(0n),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'execute_redeem');
    const ev = eventPayload(r, '::vault::RedeemExecuted');
    assert(fieldBigInt(ev, 'redeem_id') === 0n, 'binary redeem executed id is 0');
    assert(fieldBigInt(ev, 'qty') === qty, 'binary redeem executed qty matches');
    assert(fieldBigInt(ev, 'payout') > 0n, 'binary redeem payout is positive');
    assert(fieldBool(ev, 'is_settled') === false, 'binary live redeem is unsettled');
    assert(
      !(await ownedPositionTokenIds(c, addr, cerida)).includes(token),
      'binary PositionToken burned after redeem',
    );
    console.log('RedeemExecuted:', ev);
  }

  console.log('\n binary flow complete (continuous strike).');

  // ── Range path: same vault/manager, vertical range (lower, higher]. ──
  // Reuses intent/redeem counters (mint intent #1, redeem #1).
  console.log('\n── range flow (vertical $62,000–$64,000] ──');
  const lower = 62_000n * PRICE_SCALE; // on-grid ($100 tick)
  const higher = 64_000n * PRICE_SCALE;

  // 6. request_mint_range.
  {
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
        tx.pure.u64(0n), // max_cost=0 → market order
        tx.pure.u64(0n), // tp_value=0
        tx.pure.u64(0n), // sl_value=0
        pay,
      ],
    });
    const r = await exec(c, tx, kp, 'request_mint_range');
    const ev = eventPayload(r, '::vault::MintRequested');
    assert(fieldBigInt(ev, 'intent_id') === 1n, 'range mint intent id is 1');
    assert(fieldBool(ev, 'is_range') === true, 'range mint event is range');
    assert(fieldBigInt(ev, 'qty') === qty, 'range mint requested qty matches');
    console.log('escrowed range mint intent #1');
  }

  // 7. execute_mint (range). Re-feed the oracle first (30s staleness).
  let rangeToken: string;
  await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_mint`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(1n),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'execute_mint (range)');
    const ev = eventPayload(r, '::vault::MintExecuted');
    assert(fieldBigInt(ev, 'intent_id') === 1n, 'range mint executed id is 1');
    assert(fieldBigInt(ev, 'qty') === qty, 'range mint executed qty matches');
    assert(fieldBigInt(ev, 'cost') > 0n, 'range mint cost is positive');
    console.log('MintExecuted (range):', ev);
    rangeToken = created(r, '::position_token::PositionToken');
    console.log('range PositionToken issued:', rangeToken);
  }

  // 8. request_redeem + execute_redeem (range).
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::request_redeem`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(rangeToken), tx.pure.u64(qty)],
    });
    const r = await exec(c, tx, kp, 'request_redeem (range)');
    const ev = eventPayload(r, '::vault::RedeemRequested');
    assert(fieldBigInt(ev, 'redeem_id') === 1n, 'range redeem id is 1');
    assert(fieldBigInt(ev, 'qty') === qty, 'range redeem qty matches');
  }
  await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_redeem`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(1n),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'execute_redeem (range)');
    const ev = eventPayload(r, '::vault::RedeemExecuted');
    assert(fieldBigInt(ev, 'redeem_id') === 1n, 'range redeem executed id is 1');
    assert(fieldBigInt(ev, 'qty') === qty, 'range redeem executed qty matches');
    assert(fieldBigInt(ev, 'payout') > 0n, 'range redeem payout is positive');
    assert(fieldBool(ev, 'is_settled') === false, 'range live redeem is unsettled');
    assert(
      !(await ownedPositionTokenIds(c, addr, cerida)).includes(rangeToken),
      'range PositionToken burned after redeem',
    );
    console.log('RedeemExecuted (range):', ev);
  }

  // ── Leverage (Turbo Tickets): open→close, then open→liquidate on a crash.
  // Permissionless design: trader-signed open/close, anyone can liquidate
  // (health verified on-chain); no keeper, no manager, no debt.
  console.log('\n── leverage flow (turbo tickets) ──');
  const pool = need(m, 'marginPoolId');
  const book = need(m, 'leverageBookId');
  let atmPositionId = 0n;
  let otmPositionId = 0n;

  // open → close: UP @ $63,000 ATM, $20 margin, 100 contracts (basis ~$46 ⇒ ~2.3×).
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [mCoin] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(20n * DUSDC_SCALE)],
    );
    tx.moveCall({
      target: `${cerida}::leverage::open_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool),
        tx.object(book),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(63_000n * PRICE_SCALE),
        tx.pure.bool(true),
        mCoin,
        tx.pure.u64(100n * DUSDC_SCALE),
        tx.pure.u64(4500n),
        tx.pure.u64(0n),
        tx.pure.u64(0n), // tp_value, sl_value (disabled)
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'open_binary ticket (ATM)');
    const ev = eventPayload(r, '::leverage::TicketOpened');
    atmPositionId = fieldBigInt(ev, 'position_id');
    assert(fieldBigInt(ev, 'basis') > 0n, 'ATM ticket basis is positive');
    console.log('TicketOpened (ATM):', ev);
  }
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::leverage::close`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool),
        tx.object(book),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(atmPositionId),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'ticket close');
    const ev = eventPayload(r, '::leverage::TicketClosed');
    assert(
      fieldBigInt(ev, 'position_id') === atmPositionId,
      'ATM ticket close id matches opened id',
    );
    assert(fieldBool(ev, 'liquidated') === false, 'ATM ticket close is not liquidation');
    console.log('TicketClosed:', ev);
  }

  // open → liquidate: UP @ $64,000 OTM, $10 margin (~4.4×), then crash to $55k.
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [mCoin] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(10n * DUSDC_SCALE)],
    );
    tx.moveCall({
      target: `${cerida}::leverage::open_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool),
        tx.object(book),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(64_000n * PRICE_SCALE),
        tx.pure.bool(true),
        mCoin,
        tx.pure.u64(100n * DUSDC_SCALE),
        tx.pure.u64(4500n),
        tx.pure.u64(0n),
        tx.pure.u64(0n), // tp_value, sl_value (disabled)
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'open_binary ticket (OTM)');
    const ev = eventPayload(r, '::leverage::TicketOpened');
    otmPositionId = fieldBigInt(ev, 'position_id');
    assert(fieldBigInt(ev, 'basis') > 0n, 'OTM ticket basis is positive');
    console.log('TicketOpened (OTM):', ev);
  }
  {
    // Adverse move: crash spot → UP @ $64k collapses → knockout. The pool keeps
    // the escrow (it GAINS the margin) — the CDP here ate $12.59 of bad debt.
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap, 55_000n);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::leverage::liquidate`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool),
        tx.object(book),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(otmPositionId),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'ticket liquidate');
    const ev = eventPayload(r, '::leverage::TicketClosed');
    assert(
      fieldBigInt(ev, 'position_id') === otmPositionId,
      'OTM liquidation id matches opened id',
    );
    assert(fieldBool(ev, 'liquidated') === true, 'OTM ticket was liquidated');
    console.log('TicketLiquidated:', ev);
  }

  // place → execute → close: binary limit order opens a ticket when ask <= limit.
  console.log('\n── limit order flow (place → execute → close) ──');
  const limitBook = need(m, 'limitBookId');
  let limitOrderId = 0n;
  let limitPositionId = 0n;
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [mCoin] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(20n * DUSDC_SCALE)],
    );
    tx.moveCall({
      target: `${cerida}::leverage::place_limit_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(limitBook),
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(63_000n * PRICE_SCALE),
        tx.pure.bool(true),
        tx.pure.u64(100n * DUSDC_SCALE),
        tx.pure.u64(4500n),
        tx.pure.u64(200n * DUSDC_SCALE),
        tx.pure.u64(expiry - 60_000n),
        tx.pure.u64(0n),
        tx.pure.u64(0n),
        mCoin,
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'place_limit_binary');
    const ev = eventPayload(r, '::leverage::LimitOrderPlaced');
    limitOrderId = fieldBigInt(ev, 'order_id');
    assert(fieldBool(ev, 'is_range') === false, 'limit order is binary');
    assert(fieldBigInt(ev, 'qty') === qty, 'limit order qty matches');
    console.log('LimitOrderPlaced:', ev);
  }
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::leverage::execute_limit`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool),
        tx.object(book),
        tx.object(limitBook),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(limitOrderId),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'execute_limit');
    const ev = eventPayload(r, '::leverage::LimitOrderExecuted');
    limitPositionId = fieldBigInt(ev, 'position_id');
    assert(
      fieldBigInt(ev, 'order_id') === limitOrderId,
      'executed limit order id matches placed id',
    );
    assert(fieldBigInt(ev, 'basis') > 0n, 'executed limit basis is positive');
    console.log('LimitOrderExecuted:', ev);
  }
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::leverage::close`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool),
        tx.object(book),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(limitPositionId),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'close limit-opened ticket');
    const ev = eventPayload(r, '::leverage::TicketClosed');
    assert(
      fieldBigInt(ev, 'position_id') === limitPositionId,
      'closed limit-opened ticket id matches',
    );
    assert(fieldBool(ev, 'liquidated') === false, 'limit-opened ticket close is not liquidation');
    console.log('TicketClosed (limit):', ev);
  }

  // ── Vault-based leverage: request_leverage_binary → execute_leverage_open → close.
  // Unlike the direct leverage flow above, this goes through the vault intent
  // system so the keeper (execute_leverage_open) reads the live Predict ask,
  // mints a Predict hedge, and opens the Turbo Ticket from remaining margin.
  console.log('\n── vault leverage flow (request → keeper execute → close) ──');
  let vaultLeveragePositionId = 0n;
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [mCoin] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(100n * DUSDC_SCALE)],
    );
    tx.moveCall({
      target: `${cerida}::vault::request_leverage_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(vault),
        tx.pure.id(oracle),
        tx.pure.u64(expiry),
        tx.pure.u64(63_000n * PRICE_SCALE),
        tx.pure.bool(true), // UP
        tx.pure.u64(100n * DUSDC_SCALE),
        tx.pure.u64(4500n), // maint_bps
        tx.pure.u64(0n),    // tp_value disabled
        tx.pure.u64(0n),    // sl_value disabled
        mCoin,
      ],
    });
    const r = await exec(c, tx, kp, 'request_leverage_binary');
    const ev = eventPayload(r, '::vault::LeverageOpenRequested');
    const vaultLevIntentId = fieldBigInt(ev, 'intent_id');
    assert(fieldBool(ev, 'is_range') === false, 'vault leverage intent is binary');
    assert(fieldBigInt(ev, 'escrowed') === 100n * DUSDC_SCALE, 'vault leverage escrowed matches');
    console.log('LeverageOpenRequested:', ev);

    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx2 = new Transaction();
    tx2.moveCall({
      target: `${cerida}::vault::execute_leverage_open`,
      typeArguments: [dusdcType],
      arguments: [
        tx2.object(vault),
        tx2.object(manager),
        tx2.object(predict),
        tx2.object(oracle),
        tx2.object(pool),
        tx2.object(book),
        tx2.pure.u64(vaultLevIntentId),
        tx2.object(CLOCK),
      ],
    });
    const r2 = await exec(c, tx2, kp, 'execute_leverage_open');
    const ev2 = eventPayload(r2, '::vault::LeverageOpenExecuted');
    vaultLeveragePositionId = fieldBigInt(ev2, 'position_id');
    assert(fieldBigInt(ev2, 'basis') > 0n, 'vault leverage basis is positive');
    console.log('LeverageOpenExecuted:', ev2);
  }
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::leverage::close`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool),
        tx.object(book),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(vaultLeveragePositionId),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'close vault-leverage ticket');
    const ev = eventPayload(r, '::leverage::TicketClosed');
    assert(fieldBigInt(ev, 'position_id') === vaultLeveragePositionId, 'vault leverage close id matches');
    assert(fieldBool(ev, 'liquidated') === false, 'vault leverage close is not liquidation');
    console.log('TicketClosed (vault leverage):', ev);
  }
  flowSummary.vault_leverage_position_id = vaultLeveragePositionId.toString();
  console.log('\n vault leverage flow complete.');

  // ── TP / SL flow: open → set_tp_sl → execute_tp (permissionless when condition met).
  console.log('\n── TP/SL flow (open → set TP → execute_tp) ──');
  {
    // Open ATM UP @ $63k with $20 margin. Set a TP at 90% of the initial bid·qty
    // so it fires immediately when we re-feed at the same price.
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [mCoin] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(20n * DUSDC_SCALE)],
    );
    tx.moveCall({
      target: `${cerida}::leverage::open_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracle),
        tx.pure.id(oracle), tx.pure.u64(expiry),
        tx.pure.u64(63_000n * PRICE_SCALE), tx.pure.bool(true),
        mCoin, tx.pure.u64(100n * DUSDC_SCALE), tx.pure.u64(4500n),
        tx.pure.u64(0n), tx.pure.u64(0n), // tp_value/sl_value — set below
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'open ticket for TP/SL test');
    const evOpen = eventPayload(r, '::leverage::TicketOpened');
    const tpPositionId = fieldBigInt(evOpen, 'position_id');
    console.log('TicketOpened (TP test):', evOpen);

    // Set TP at a low threshold so execute_tp will fire immediately
    // tp_value = 1 (fires as soon as bid·qty >= 1 — effectively always true at ATM)
    const tx2 = new Transaction();
    tx2.moveCall({
      target: `${cerida}::leverage::set_tp_sl`,
      typeArguments: [dusdcType],
      arguments: [tx2.object(book), tx2.pure.u64(tpPositionId), tx2.pure.u64(1n), tx2.pure.u64(0n)],
    });
    const r2 = await exec(c, tx2, kp, 'set_tp_sl');
    const evTpSl = eventPayload(r2, '::leverage::TpSlUpdated');
    assert(fieldBigInt(evTpSl, 'position_id') === tpPositionId, 'TpSlUpdated id matches');
    assert(fieldBigInt(evTpSl, 'tp_value') === 1n, 'TP set to 1');
    console.log('TpSlUpdated:', evTpSl);

    // execute_tp — permissionless; fires because bid·qty >= tp_value=1
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx3 = new Transaction();
    tx3.moveCall({
      target: `${cerida}::leverage::execute_tp`,
      typeArguments: [dusdcType],
      arguments: [tx3.object(pool), tx3.object(book), tx3.object(predict), tx3.object(oracle), tx3.pure.u64(tpPositionId), tx3.object(CLOCK)],
    });
    const r3 = await exec(c, tx3, kp, 'execute_tp');
    const evClose = eventPayload(r3, '::leverage::TicketClosed');
    assert(fieldBigInt(evClose, 'position_id') === tpPositionId, 'TP close position id matches');
    assert(fieldBool(evClose, 'liquidated') === false, 'TP close is not liquidation');
    console.log('TicketClosed (TP):', evClose);
  }

  // SL: open → set SL at a very high value → execute_sl fires (bid·qty <= sl_value always)
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    const [mCoin] = tx.splitCoins(
      tx.object(await dusdcCoin(c, addr, dusdcType)),
      [tx.pure.u64(20n * DUSDC_SCALE)],
    );
    tx.moveCall({
      target: `${cerida}::leverage::open_binary`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracle),
        tx.pure.id(oracle), tx.pure.u64(expiry),
        tx.pure.u64(63_000n * PRICE_SCALE), tx.pure.bool(true),
        mCoin, tx.pure.u64(100n * DUSDC_SCALE), tx.pure.u64(4500n),
        tx.pure.u64(0n), tx.pure.u64(0n),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'open ticket for SL test');
    const slPositionId = fieldBigInt(eventPayload(r, '::leverage::TicketOpened'), 'position_id');

    // Set SL at u64::MAX/2 so it always fires (bid·qty will be far below it)
    const slValue = 999_999_999_999_999_999n;
    const tx2 = new Transaction();
    tx2.moveCall({
      target: `${cerida}::leverage::set_tp_sl`,
      typeArguments: [dusdcType],
      arguments: [tx2.object(book), tx2.pure.u64(slPositionId), tx2.pure.u64(0n), tx2.pure.u64(slValue)],
    });
    await exec(c, tx2, kp, 'set_tp_sl (SL)');

    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx3 = new Transaction();
    tx3.moveCall({
      target: `${cerida}::leverage::execute_sl`,
      typeArguments: [dusdcType],
      arguments: [tx3.object(pool), tx3.object(book), tx3.object(predict), tx3.object(oracle), tx3.pure.u64(slPositionId), tx3.object(CLOCK)],
    });
    const r3 = await exec(c, tx3, kp, 'execute_sl');
    const evSl = eventPayload(r3, '::leverage::TicketClosed');
    assert(fieldBigInt(evSl, 'position_id') === slPositionId, 'SL close position id matches');
    assert(fieldBool(evSl, 'liquidated') === false, 'SL close is not liquidation');
    console.log('TicketClosed (SL):', evSl);
  }
  console.log('\n TP/SL flow complete.');

  // ── Window epoch flow: keeper creates a fresh 90s oracle, rolls epoch, bets, settles.
  // The keeper (deployer here) holds AdminCap + OracleSVICap to mint per-epoch oracles.
  await fund(addr); // replenish gas after the many txs above
  console.log('\n── window epoch flow (roll → bet → settle → payout → claim) ──');
  const wBookId         = need(m, 'windowBookId');
  const keeperOracleCap = need(m, 'keeperOracleCapId');
  const wEpochExpiry    = BigInt(Date.now()) + 10_000n; // 10s epoch
  const wStrikes        = [
    60_000n * PRICE_SCALE,
    61_500n * PRICE_SCALE,
    63_000n * PRICE_SCALE,
    64_500n * PRICE_SCALE,
    66_000n * PRICE_SCALE,
  ];

  // a) Create a 90s Predict oracle for this epoch.
  let wOracleId: string;
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${predictPkg}::registry::create_oracle`,
      arguments: [
        tx.object(need(m, 'registry')),
        tx.object(predict),
        tx.object(need(m, 'adminCap')),
        tx.object(keeperOracleCap),
        tx.pure.string('BTC'),
        tx.pure.u64(wEpochExpiry),
        tx.pure.u64(1_000n * PRICE_SCALE),
        tx.pure.u64(100n * PRICE_SCALE),
      ],
    });
    const r = await exec(c, tx, kp, 'create epoch oracle');
    const evt = (r.events ?? []).find((e: any) => e.type?.endsWith('::registry::OracleCreated'));
    if (!evt?.parsedJson) throw new Error('OracleCreated event not found');
    wOracleId = (evt.parsedJson as any).oracle_id as string;
    console.log('epoch oracle =', wOracleId, 'expiry =', new Date(Number(wEpochExpiry)).toISOString());
  }

  // b) Register keeper cap with new oracle, activate, feed SVI + prices, roll epoch.
  let wEpochId = 0n;
  {
    const spot = 62_999n * PRICE_SCALE; // $62,999 → band 1 wins at settlement
    const tx = new Transaction();
    const oracleObj = tx.object(wOracleId);
    const cap = tx.object(keeperOracleCap);
    tx.moveCall({
      target: `${predictPkg}::registry::register_oracle_cap`,
      arguments: [oracleObj, tx.object(need(m, 'adminCap')), cap],
    });
    tx.moveCall({ target: `${predictPkg}::oracle::activate`, arguments: [oracleObj, cap, tx.object(CLOCK)] });
    const pd = tx.moveCall({ target: `${predictPkg}::oracle::new_price_data`, arguments: [tx.pure.u64(spot), tx.pure.u64(spot)] });
    tx.moveCall({ target: `${predictPkg}::oracle::update_prices`, arguments: [oracleObj, cap, pd, tx.object(CLOCK)] });
    const rho = tx.moveCall({ target: `${predictPkg}::i64::from_parts`, arguments: [tx.pure.u64(300_000_000n), tx.pure.bool(true)] });
    const mm  = tx.moveCall({ target: `${predictPkg}::i64::from_parts`, arguments: [tx.pure.u64(0n), tx.pure.bool(false)] });
    const svi = tx.moveCall({ target: `${predictPkg}::oracle::new_svi_params`, arguments: [tx.pure.u64(40_000_000n), tx.pure.u64(100_000_000n), rho, mm, tx.pure.u64(100_000_000n)] });
    tx.moveCall({ target: `${predictPkg}::oracle::update_svi`, arguments: [oracleObj, cap, svi, tx.object(CLOCK)] });
    tx.moveCall({
      target: `${cerida}::windows::roll_epoch`,
      typeArguments: [dusdcType],
      arguments: [tx.object(wBookId), tx.pure.id(wOracleId), tx.pure.u64(wEpochExpiry), tx.pure.vector('u64', wStrikes.map(s => s)), tx.object(CLOCK)],
    });
    const r = await exec(c, tx, kp, 'activate + feed + roll_epoch');
    const ev = eventPayload(r, '::windows::EpochRolled');
    wEpochId = fieldBigInt(ev, 'epoch_id');
    console.log('EpochRolled: epoch_id =', wEpochId.toString());
  }

  // c) User requests a window bet on band 1 ($61,500–$63,000).
  const wBandIdx = 1n;
  const wBetQty  = 10n * DUSDC_SCALE;
  const wEscrow  = 50n * DUSDC_SCALE;
  let   wIntentId = 0n;
  {
    const tx = new Transaction();
    const [pay] = tx.splitCoins(tx.object(await dusdcCoin(c, addr, dusdcType)), [tx.pure.u64(wEscrow)]);
    tx.moveCall({
      target: `${cerida}::vault::request_window_bet`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.pure.u64(wEpochId), tx.pure.u64(wBandIdx), tx.pure.u64(wBetQty), pay],
    });
    const r = await exec(c, tx, kp, 'request_window_bet');
    const ev = eventPayload(r, '::vault::WindowBetRequested');
    wIntentId = fieldBigInt(ev, 'intent_id');
    assert(fieldBigInt(ev, 'band_idx') === wBandIdx, 'window bet band_idx matches');
    console.log('WindowBetRequested:', ev);
  }

  // d) Keeper executes the window bet (uses the long-lived vault oracle for Predict pricing).
  let wBetTicketId: string;
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_window_bet`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(manager), tx.object(predict), tx.object(oracle), tx.object(wBookId), tx.pure.u64(wIntentId), tx.object(CLOCK)],
    });
    const r = await exec(c, tx, kp, 'execute_window_bet');
    const ev = eventPayload(r, '::vault::WindowBetExecuted');
    assert(fieldBigInt(ev, 'svi_ask') > 0n, 'window bet svi_ask is positive');
    wBetTicketId = created(r, '::windows::BetTicket');
    console.log('WindowBetExecuted:', ev, '\nBetTicket:', wBetTicketId);
  }

  // e) Wait for the epoch oracle to expire.
  const msLeft = Number(wEpochExpiry) - Date.now() + 2_000;
  if (msLeft > 0) {
    console.log(`waiting ${Math.ceil(msLeft / 1000)}s for epoch oracle to expire...`);
    await new Promise((r) => setTimeout(r, msLeft));
  }

  // f) Push prices post-expiry → settles the epoch oracle at $62,999 (band 1 wins).
  {
    const settleSpot = 62_999n * PRICE_SCALE;
    const tx = new Transaction();
    const oracleObj = tx.object(wOracleId);
    const pd = tx.moveCall({ target: `${predictPkg}::oracle::new_price_data`, arguments: [tx.pure.u64(settleSpot), tx.pure.u64(settleSpot)] });
    tx.moveCall({ target: `${predictPkg}::oracle::update_prices`, arguments: [oracleObj, tx.object(keeperOracleCap), pd, tx.object(CLOCK)] });
    await exec(c, tx, kp, 'settle epoch oracle via update_prices');
    console.log('epoch oracle settled at $62,999 → band 1 wins');
  }

  // g) windows::settle_epoch (permissionless once oracle is settled).
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::windows::settle_epoch`,
      typeArguments: [dusdcType],
      arguments: [tx.object(wBookId), tx.object(wOracleId), tx.pure.u64(wEpochId)],
    });
    const r = await exec(c, tx, kp, 'windows::settle_epoch');
    const ev = eventPayload(r, '::windows::EpochSettled');
    console.log('EpochSettled:', ev);
  }

  // h) Vault keeper redeems the winning Predict position.
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::execute_epoch_payout`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(manager), tx.object(predict), tx.object(wOracleId), tx.object(wBookId), tx.pure.u64(wEpochId), tx.object(CLOCK)],
    });
    const r = await exec(c, tx, kp, 'execute_epoch_payout');
    console.log('EpochPayoutExecuted:', eventPayload(r, '::vault::EpochPayoutExecuted'));
  }

  // i) User claims their winning BetTicket.
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::claim_window_bet`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(wBookId), tx.object(wBetTicketId)],
    });
    const r = await exec(c, tx, kp, 'claim_window_bet');
    console.log('WindowBetClaimed:', eventPayload(r, '::vault::WindowBetClaimed'));
  }
  flowSummary.window_epoch_id = wEpochId.toString();
  flowSummary.window_bet_ticket = wBetTicketId!;
  console.log('\n window epoch flow complete.');

  const endingBalance = await dusdcBalance(c, addr, dusdcType);
  flowSummary.starting_dusdc = startingBalance.toString();
  flowSummary.ending_dusdc = endingBalance.toString();
  flowSummary.limit_position_id = limitPositionId.toString();
  flowSummary.completed_at = new Date().toISOString();
  console.log('\nflow summary:', JSON.stringify(flowSummary, null, 2));

  console.log(
    '\n all flows complete: binary + range + turbo-ticket leverage + limit order + vault leverage + TP/SL + window epoch.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
