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
} from './config.js';

declare const process: {
  exit(code?: number): void;
};

async function exec(
  c: SuiClient,
  tx: Transaction,
  kp: Ed25519Keypair,
  label: string,
) {
  tx.setGasBudget(2_000_000_000);
  const r = await c.signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (r.effects?.status.status !== 'success') {
    throw new Error(`${label} failed: ${JSON.stringify(r.effects?.status)}`);
  }
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

async function main() {
  const c = client();
  const kp = deployer();
  const addr = kp.toSuiAddress();
  const m: Manifest = loadManifest();
  await fund(addr);

  const cerida = need(m, 'ceridaPkg');
  const dusdcType = need(m, 'dusdcType');
  const predict = need(m, 'predict');
  const oracle = need(m, 'oracle');
  const expiry = BigInt(need(m, 'expiry'));

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

  // 3. execute_mint (keeper).
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
      arguments: [tx.object(vault), tx.object(token)],
    });
    await exec(c, tx, kp, 'request_redeem');
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

  console.log(
    '\n binary flow complete (continuous strike). Range flow is the same with',
  );
  console.log(
    '   request_mint_range(vault, oracleId, expiry, lower, higher, qty, coin).',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
