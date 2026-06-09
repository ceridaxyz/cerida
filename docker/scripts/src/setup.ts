// One-shot Predict setup on the local network:
//   create_predict<DUSDC> → mint dUSDC → oracle cap → oracle → activate → feed SVI+price
// Run after deploy.ts. Re-run the feed portion if the oracle drifts past staleness.

import { Inputs, Transaction } from "@mysten/sui/transactions";
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
  tx.setGasBudget(2_000_000_000);
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
    const cur = await c.getObject({ id: need(m, "dusdcCurrency"), options: {} });
    const d = cur.data!;
    tx.moveCall({
      target: "0x2::coin_registry::finalize_registration",
      typeArguments: [dusdcType],
      arguments: [
        tx.object("0xc"), // shared CoinRegistry system object
        tx.object(Inputs.ReceivingRef({ objectId: d.objectId, version: d.version, digest: d.digest })),
      ],
    });
    const r = await exec(c, tx, kp, "finalize_registration");
    m.dusdcCurrencyShared = created(r, "::coin_registry::Currency<");
    saveManifest(m);
    console.log("dusdcCurrencyShared =", m.dusdcCurrencyShared);
  }

  // 1. create_predict<DUSDC> — the shared Predict object.
  {
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

  // 2. Mint dUSDC to the deployer (acts as keeper AND user in the sim).
  {
    const tx = new Transaction();
    const coin = tx.moveCall({
      target: "0x2::coin::mint",
      typeArguments: [dusdcType],
      arguments: [tx.object(need(m, "dusdcCap")), tx.pure.u64(1_000_000n * DUSDC_SCALE)],
    });
    tx.transferObjects([coin], tx.pure.address(addr));
    await exec(c, tx, kp, "mint dusdc");
    console.log("minted 1,000,000 dUSDC to", addr);
  }

  // 3. Oracle cap.
  {
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

  // 4. Create the oracle (1h expiry, $1000 min strike, $100 tick).
  const expiry = BigInt(Date.now() + 60 * 60 * 1000);
  {
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

  // 5. Activate + push spot/forward + SVI so the oracle is quotable.
  {
    const tx = new Transaction();
    const oracle = tx.object(need(m, "oracle"));
    const cap = tx.object(need(m, "oracleCap"));
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
    await exec(c, tx, kp, "activate + feed oracle");
    console.log("oracle activated + fed (spot $63,000)");
  }

  console.log("\nsetup complete:\n", JSON.stringify(m, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
