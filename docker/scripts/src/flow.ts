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
  // Block until the fullnode has indexed this tx so the next tx can reference
  // objects created here (e.g. the vault) without a read-after-write race.
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
  await feedSviAndPrices(c, kp, predictPkg, oracle, need(m, 'oracleCap'), 'feed fresh oracle');

  m.oracleActivated = 'true';
  saveManifest(m);
  console.log('fresh oracle =', oracle, 'expiry =', new Date(Number(expiry)).toISOString());
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
    console.log('vault =', vault, '\nmanager =', manager);
  }

  const strike = 63_000n * PRICE_SCALE; // on-grid ($100 tick, ≥ $1,000)
  const qty = 100n * DUSDC_SCALE; // 100 contracts
  const escrow = 200n * DUSDC_SCALE; // slippage cap ($200; cost should be well under)

  // 2. request_mint_binary (continuous strike, UP).
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
        pay,
      ],
    });
    await exec(c, tx, kp, 'request_mint_binary');
    console.log('escrowed mint intent #0 (UP $63,000)');
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
    const ev = (r.events ?? []).find((e: any) =>
      e.type.endsWith('::vault::MintExecuted'),
    );
    console.log('MintExecuted:', ev?.parsedJson);
  }

  // 4. Find the issued PositionToken.
  const toks = await c.getOwnedObjects({
    owner: addr,
    filter: { StructType: `${cerida}::position_token::PositionToken` },
    options: { showType: true },
  });
  if (toks.data.length === 0) throw new Error('FAIL: no PositionToken issued');
  const token = toks.data[0].data!.objectId;
  console.log('PositionToken issued:', token);

  // 5. request_redeem + execute_redeem.
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::vault::request_redeem`,
      typeArguments: [dusdcType],
      arguments: [tx.object(vault), tx.object(token), tx.pure.u64(qty)],
    });
    await exec(c, tx, kp, 'request_redeem');
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
    const ev = (r.events ?? []).find((e: any) =>
      e.type.endsWith('::vault::RedeemExecuted'),
    );
    console.log('RedeemExecuted:', ev?.parsedJson);
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
        pay,
      ],
    });
    await exec(c, tx, kp, 'request_mint_range');
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
    const ev = (r.events ?? []).find((e: any) =>
      e.type.endsWith('::vault::MintExecuted'),
    );
    console.log('MintExecuted (range):', ev?.parsedJson);
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
    await exec(c, tx, kp, 'request_redeem (range)');
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
    const ev = (r.events ?? []).find((e: any) =>
      e.type.endsWith('::vault::RedeemExecuted'),
    );
    console.log('RedeemExecuted (range):', ev?.parsedJson);
  }

  // ── Leverage (Turbo Tickets): open→close, then open→liquidate on a crash.
  // Permissionless design: trader-signed open/close, anyone can liquidate
  // (health verified on-chain); no keeper, no manager, no debt.
  console.log('\n── leverage flow (turbo tickets) ──');
  const pool = need(m, 'marginPoolId');
  const book = need(m, 'leverageBookId');

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
        tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracle),
        tx.pure.id(oracle), tx.pure.u64(expiry), tx.pure.u64(63_000n * PRICE_SCALE), tx.pure.bool(true),
        mCoin, tx.pure.u64(100n * DUSDC_SCALE), tx.pure.u64(4500n),
        tx.pure.u64(0n), tx.pure.u64(0n), // tp_value, sl_value (disabled)
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'open_binary ticket (ATM)');
    const ev = (r.events ?? []).find((e: any) => e.type.endsWith('::leverage::TicketOpened'));
    console.log('TicketOpened (ATM):', ev?.parsedJson);
  }
  {
    await refreshOracle(c, kp, predictPkg, oracle, oracleCap);
    const tx = new Transaction();
    tx.moveCall({
      target: `${cerida}::leverage::close`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracle),
        tx.pure.u64(0n), tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'ticket close');
    const ev = (r.events ?? []).find((e: any) => e.type.endsWith('::leverage::TicketClosed'));
    console.log('TicketClosed:', ev?.parsedJson);
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
        tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracle),
        tx.pure.id(oracle), tx.pure.u64(expiry), tx.pure.u64(64_000n * PRICE_SCALE), tx.pure.bool(true),
        mCoin, tx.pure.u64(100n * DUSDC_SCALE), tx.pure.u64(4500n),
        tx.pure.u64(0n), tx.pure.u64(0n), // tp_value, sl_value (disabled)
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'open_binary ticket (OTM)');
    const ev = (r.events ?? []).find((e: any) => e.type.endsWith('::leverage::TicketOpened'));
    console.log('TicketOpened (OTM):', ev?.parsedJson);
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
        tx.object(pool), tx.object(book), tx.object(predict), tx.object(oracle),
        tx.pure.u64(1n), tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, 'ticket liquidate');
    const ev = (r.events ?? []).find((e: any) => e.type.endsWith('::leverage::TicketClosed'));
    console.log('TicketLiquidated:', ev?.parsedJson);
  }

  console.log(
    '\n✅ all flows complete: continuous binary + range + turbo-ticket leverage (close & liquidate, zero bad debt).',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
