// Publish to the local network via the SDK, in dependency order, each package
// as its OWN root (NO --with-unpublished-dependencies). That avoids the 0x0
// module-name collision (cerida::vault vs predict::vault, deepbook::registry vs
// predict::registry): with deps already published, they're binary references,
// not recompiled at 0x0 — the same model the unit tests use.
//
// Order: token → deepbook → predict → dusdc → cerida, pinning each address into
// its Move.toml so the next package resolves the deployed instance.

import {
  client,
  deployer,
  ensureBuildEnv,
  findCreated,
  fund,
  liveChainId,
  loadManifest,
  localizeDeepbookToken,
  onlyPackage,
  PKG,
  pinPubfile,
  pinPublished,
  publish,
  resetPin,
  saveManifest,
  stripEnvironments,
  tomlOf,
} from './config.js';

async function main() {
  stripEnvironments(); // classic resolution, each package a separate root
  localizeDeepbookToken(); // deepbook → local token (chain is all local-path)
  // Clear stale published-at pins from any prior (now-dead) localnet.
  resetPin(tomlOf(PKG.token), 'token');
  resetPin(tomlOf(PKG.deepbook), 'deepbook');
  resetPin(tomlOf(PKG.predict), 'deepbook_predict');
  resetPin(tomlOf(PKG.dusdc), 'dusdc');
  resetPin(tomlOf(PKG.cerida), 'cerida');
  ensureBuildEnv(); // active env = local (RPC); builds pass --build-env testnet

  const c = client();
  const kp = deployer();
  const addr = kp.toSuiAddress();
  console.log('deployer:', addr);
  const chainId = liveChainId();
  const m = loadManifest();

  // A fresh deploy means a fresh genesis: every object and flag that setup.ts
  // produced on the previous chain is now dead. setup.ts guards its stateful
  // steps on these flags (if (!m.minted) … etc.), so leaving them set would
  // make setup silently SKIP minting dUSDC, creating/activating the oracle, and
  // supplying — yet still report success, leaving flow.ts to fail with
  // "no dUSDC". Clear all setup-produced runtime state here so setup re-runs it.
  for (const k of [
    'predict',
    'minted',
    'supplied',
    'oracle',
    'oracleCap',
    'oracleActivated',
    'expiry',
    'dusdcCurrencyShared',
    'marginPoolId',
    'leverageBookId',
    'limitBookId',
    'leverageSeeded',
    'windowBookId',
    'keeperOracleCapId',
  ] as const) {
    delete (m as Record<string, unknown>)[k];
  }

  // 1. token (leaf)
  await fund(addr);
  console.log('publishing token…');
  m.tokenPkg = onlyPackage((await publish(c, kp, PKG.token)).packages);
  pinPublished(tomlOf(PKG.token), 'token', m.tokenPkg);
  saveManifest(m);
  console.log('  tokenPkg =', m.tokenPkg);

  // 2. deepbook (→ token)
  await fund(addr);
  console.log('publishing deepbook…');
  m.deepbookPkg = onlyPackage((await publish(c, kp, PKG.deepbook)).packages);
  pinPublished(tomlOf(PKG.deepbook), 'deepbook', m.deepbookPkg);
  pinPubfile(PKG.deepbook, m.deepbookPkg, chainId); // dependents read Published.toml
  saveManifest(m);
  console.log('  deepbookPkg =', m.deepbookPkg);

  // 3. predict (→ deepbook, token) — init mints Registry + AdminCap + PLP cap
  await fund(addr);
  console.log('publishing predict…');
  const p = await publish(c, kp, PKG.predict);
  m.predictPkg = onlyPackage(p.packages);
  m.registry = findCreated(p.created, '::registry::Registry');
  m.adminCap = findCreated(p.created, '::registry::AdminCap');
  // Match coin::TreasuryCap specifically — PLP also mints a coin_registry
  // Currency<PLP> (TTO'd to 0xc) whose type also ends in ::plp::PLP>.
  m.plpCap = findCreated(p.created, 'coin::TreasuryCap<');
  pinPublished(tomlOf(PKG.predict), 'deepbook_predict', m.predictPkg);
  saveManifest(m);
  console.log('  predictPkg =', m.predictPkg);

  // 4. dUSDC quote asset
  await fund(addr);
  console.log('publishing dusdc…');
  const d = await publish(c, kp, PKG.dusdc);
  m.dusdcPkg = onlyPackage(d.packages);
  m.dusdcType = `${m.dusdcPkg}::dusdc::DUSDC`;
  m.dusdcCap = findCreated(d.created, 'coin::TreasuryCap<'); // not Currency<…DUSDC>
  // Currency<DUSDC> is transfer-to-object'd to the CoinRegistry (0xc) by init;
  // setup.ts must finalize_registration to re-share it. Clear any stale shared id.
  m.dusdcCurrency = findCreated(d.created, 'Currency<');
  delete m.dusdcCurrencyShared;
  saveManifest(m);
  console.log('  dusdcPkg =', m.dusdcPkg);

  // 5. cerida (→ predict)
  await fund(addr);
  console.log('publishing cerida…');
  m.ceridaPkg = onlyPackage((await publish(c, kp, PKG.cerida)).packages);
  saveManifest(m);
  console.log('  ceridaPkg =', m.ceridaPkg);

  console.log('\nmanifest written to deployments/local.json:');
  console.log(JSON.stringify(m, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
