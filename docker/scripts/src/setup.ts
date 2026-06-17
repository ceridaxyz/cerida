// One-shot Predict setup on the local network:
//   create_predict<DUSDC> → mint dUSDC → oracle cap → oracle → activate → feed SVI+price
// Run after deploy.ts. Re-run the feed portion if the oracle drifts past staleness.

import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient } from "@mysten/sui/client";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  CLOCK,
  client,
  deployer,
  DUSDC_SCALE,
  fund,
  loadManifest,
  need,
  PRICE_SCALE,
  saveManifest,
  type Manifest,
} from "./config.js";

async function exec(c: SuiClient, tx: Transaction, kp: Ed25519Keypair, label: string) {
  // No setGasBudget: let the SDK auto-estimate via dry-run. create_oracle builds
  // a ~196-page dense strike matrix whose cost a fixed budget under-provisions;
  // the canonical Mysten scripts rely on auto-estimation here for the same reason.
  const r = await c.signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (r.effects?.status.status !== "success") {
    throw new Error(`${label} failed: ${JSON.stringify(r.effects?.status)}`);
  }
  // Block until the fullnode has indexed this tx, so the next tx can read its
  // outputs (objects created here) without a read-after-write race.
  await c.waitForTransaction({ digest: r.digest });
  return r;
}

function created(r: any, needle: string): string {
  const hit = (r.objectChanges ?? []).find(
    (c: any) => c.type === "created" && c.objectType?.includes(needle),
  );
  if (!hit) throw new Error(`no created object ~'${needle}'`);
  return hit.objectId;
}

async function main() {
  const c = client();
  const kp = deployer();
  const addr = kp.toSuiAddress();
  const m: Manifest = loadManifest();
  await fund(addr);

  const predict = need(m, "predictPkg");
  const dusdcType = need(m, "dusdcType");

  // 0. finalize_registration<DUSDC> — dusdc::init transfer-to-object's its
  //    Currency to the CoinRegistry (0xc); this permissionless second step
  //    receives it and re-shares it at a derived address. Only then can it be
  //    passed by `&` reference (create_predict wants &Currency<Quote>).
  if (!m.dusdcCurrencyShared) {
    const tx = new Transaction();
    tx.moveCall({
      target: "0x2::coin_registry::finalize_registration",
      typeArguments: [dusdcType],
      arguments: [
        tx.object("0xc"), // shared CoinRegistry system object
        tx.object(need(m, "dusdcCurrency")), // TTO-owned initial Currency; SDK encodes as Receiving
      ],
    });
    const r = await exec(c, tx, kp, "finalize_registration");
    m.dusdcCurrencyShared = created(r, "::coin_registry::Currency<");
    saveManifest(m);
    console.log("dusdcCurrencyShared =", m.dusdcCurrencyShared);
  }

  // 1. create_predict<DUSDC> — the shared Predict object. Guarded: the registry
  //    asserts predict_id.is_none(), so this is one-shot.
  if (!m.predict) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${predict}::registry::create_predict`,
      typeArguments: [dusdcType],
      arguments: [
        tx.object(need(m, "registry")),
        tx.object(need(m, "adminCap")),
        tx.object(need(m, "dusdcCurrencyShared")),
        tx.object(need(m, "plpCap")),
        tx.object(CLOCK),
      ],
    });
    const r = await exec(c, tx, kp, "create_predict");
    m.predict = created(r, "::predict::Predict");
    saveManifest(m);
    console.log("predict =", m.predict);
  }

  // 2. Mint dUSDC to the deployer (acts as keeper AND user in the sim). Guarded
  //    so re-runs don't keep minting.
  if (!m.minted) {
    const tx = new Transaction();
    const coin = tx.moveCall({
      target: "0x2::coin::mint",
      typeArguments: [dusdcType],
      arguments: [tx.object(need(m, "dusdcCap")), tx.pure.u64(1_000_000n * DUSDC_SCALE)],
    });
    tx.transferObjects([coin], tx.pure.address(addr));
    await exec(c, tx, kp, "mint dusdc");
    m.minted = "true";
    saveManifest(m);
    console.log("minted 1,000,000 dUSDC to", addr);
  }

  // 3. Oracle cap.
  if (!m.oracleCap) {
    const tx = new Transaction();
    const cap = tx.moveCall({
      target: `${predict}::registry::create_oracle_cap`,
      arguments: [tx.object(need(m, "adminCap"))],
    });
    tx.transferObjects([cap], tx.pure.address(addr));
    const r = await exec(c, tx, kp, "create_oracle_cap");
    m.oracleCap = created(r, "::oracle::OracleSVICap");
    saveManifest(m);
  }

  // 4. Create the oracle (1h expiry, $1000 min strike, $100 tick). Guarded:
  //    create_oracle is not idempotent — each call mints a new OracleSVI.
  const expiry = BigInt(Date.now() + 60 * 60 * 1000);
  if (!m.oracle) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${predict}::registry::create_oracle`,
      arguments: [
        tx.object(need(m, "registry")),
        tx.object(need(m, "predict")),
        tx.object(need(m, "adminCap")),
        tx.object(need(m, "oracleCap")),
        tx.pure.string("BTC"),
        tx.pure.u64(expiry),
        tx.pure.u64(1000n * PRICE_SCALE), // min_strike $1,000
        tx.pure.u64(100n * PRICE_SCALE), // tick $100  (both satisfy the grid asserts)
      ],
    });
    const r = await exec(c, tx, kp, "create_oracle");
    m.oracle = created(r, "::oracle::OracleSVI");
    m.expiry = expiry.toString();
    saveManifest(m);
    console.log("oracle =", m.oracle, "expiry =", new Date(Number(expiry)).toISOString());
  }

  // 5. Register cap → activate → push spot/forward + SVI so the oracle is
  //    quotable. The oracle boots with an empty authorized-cap set; activate
  //    asserts the cap is authorized, so register_oracle_cap must come first
  //    (matches bootstrapOracleStep in services/oracle-feed/executor.ts).
  if (!m.oracleActivated) {
    const tx = new Transaction();
    const oracle = tx.object(need(m, "oracle"));
    const cap = tx.object(need(m, "oracleCap"));
    tx.moveCall({
      target: `${predict}::registry::register_oracle_cap`,
      arguments: [oracle, tx.object(need(m, "adminCap")), cap],
    });
    tx.moveCall({ target: `${predict}::oracle::activate`, arguments: [oracle, cap, tx.object(CLOCK)] });

    const spot = 63_000n * PRICE_SCALE;
    const pd = tx.moveCall({
      target: `${predict}::oracle::new_price_data`,
      arguments: [tx.pure.u64(spot), tx.pure.u64(spot)],
    });
    tx.moveCall({
      target: `${predict}::oracle::update_prices`,
      arguments: [oracle, cap, pd, tx.object(CLOCK)],
    });

    // SVI total-variance params (1e9 scale). rho, m are i64.
    const rho = tx.moveCall({
      target: `${predict}::i64::from_parts`,
      arguments: [tx.pure.u64(300_000_000n), tx.pure.bool(true)], // -0.30
    });
    const mm = tx.moveCall({
      target: `${predict}::i64::from_parts`,
      arguments: [tx.pure.u64(0n), tx.pure.bool(false)], // 0
    });
    const svi = tx.moveCall({
      target: `${predict}::oracle::new_svi_params`,
      arguments: [
        tx.pure.u64(40_000_000n), // a = 0.04
        tx.pure.u64(100_000_000n), // b = 0.10
        rho,
        mm,
        tx.pure.u64(100_000_000n), // sigma = 0.10
      ],
    });
    tx.moveCall({
      target: `${predict}::oracle::update_svi`,
      arguments: [oracle, cap, svi, tx.object(CLOCK)],
    });
    await exec(c, tx, kp, "register + activate + feed oracle");
    m.oracleActivated = "true";
    saveManifest(m);
    console.log("oracle registered + activated + fed (spot $63,000)");
  }

  // 6. Seed the Predict vault with PLP liquidity (mirrors supplyTx in
  //    simulations/runtime.ts). Without this the vault can't take the other
  //    side of a mint and execute_mint fails. Mint dUSDC → predict::supply →
  //    keep the PLP coin.
  if (!m.supplied) {
    const seed = 500_000n * DUSDC_SCALE;
    const tx = new Transaction();
    const [dusdc] = tx.moveCall({
      target: "0x2::coin::mint",
      typeArguments: [dusdcType],
      arguments: [tx.object(need(m, "dusdcCap")), tx.pure.u64(seed)],
    });
    const [plp] = tx.moveCall({
      target: `${predict}::predict::supply`,
      typeArguments: [dusdcType],
      arguments: [tx.object(need(m, "predict")), dusdc, tx.object(CLOCK)],
    });
    tx.transferObjects([plp], tx.pure.address(addr));
    await exec(c, tx, kp, "supply vault");
    m.supplied = "true";
    saveManifest(m);
    console.log(`seeded Predict vault with ${seed / DUSDC_SCALE} dUSDC`);
  }

  // 7. Leverage: create the Cerida MarginPool (lender + Earn vault) and the
  //    LeverageBook (custody of leveraged positions), then seed the pool with
  //    dUSDC so it can lend against margin. Guarded so re-runs don't re-create.
  if (!m.leverageSeeded) {
    const cerida = need(m, "ceridaPkg");

    const tx1 = new Transaction();
    tx1.moveCall({
      target: `${cerida}::leverage::create_pool`,
      typeArguments: [dusdcType],
      // fee schedule fixed at creation: perf 10%, liquidation penalty 5%, open 0.5%
      arguments: [tx1.pure.u64(1000n), tx1.pure.u64(500n), tx1.pure.u64(50n)],
    });
    tx1.moveCall({ target: `${cerida}::leverage::create_book`, typeArguments: [dusdcType], arguments: [] });
    tx1.moveCall({ target: `${cerida}::leverage::create_limit_book`, typeArguments: [dusdcType], arguments: [] });
    const r1 = await exec(c, tx1, kp, "create margin pool + book + limit book");
    m.marginPoolId = created(r1, "::leverage::MarginPool");
    m.leverageBookId = created(r1, "::leverage::LeverageBook");
    m.limitBookId = created(r1, "::leverage::LimitBook");

    const seed = 500_000n * DUSDC_SCALE;
    const tx2 = new Transaction();
    const [dusdc] = tx2.moveCall({
      target: "0x2::coin::mint",
      typeArguments: [dusdcType],
      arguments: [tx2.object(need(m, "dusdcCap")), tx2.pure.u64(seed)],
    });
    const [share] = tx2.moveCall({
      target: `${cerida}::leverage::supply`,
      typeArguments: [dusdcType],
      arguments: [tx2.object(m.marginPoolId), dusdc],
    });
    tx2.transferObjects([share], tx2.pure.address(addr));
    await exec(c, tx2, kp, "seed margin pool");

    m.leverageSeeded = "true";
    saveManifest(m);
    console.log(`margin pool ${m.marginPoolId} + book ${m.leverageBookId}, seeded ${seed / DUSDC_SCALE} dUSDC`);
  }

  console.log("\nsetup complete:\n", JSON.stringify(m, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
