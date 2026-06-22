// Publish the cerida package to testnet. Dependencies (predict, deepbook, token)
// are already live on testnet — only cerida itself needs publishing.
//
// Build trick: the local clones' Move.toml files have localnet published-at values.
// We temporarily patch all three (token, deepbook, predict) to their testnet addresses
// so the compiled bytecode's linkage table references the correct on-chain packages.
// Move.lock is deleted before the build (to bypass manifest_digest validation) and
// restored afterwards. sui client is switched to testnet so framework deps resolve
// from the testnet fullnode rather than git.
//
// Run: bun src/testnet/deploy.ts

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Transaction } from '@mysten/sui/transactions';
import { c, kp, ADDR, PREDICT_PKG, loadManifest, saveManifest } from './config.js';

const SUI_BIN          = '/Users/mac/Work/cerida/bin/sui';
const CERIDA_CONTRACTS = '/Users/mac/Work/cerida/contracts';
const CERIDA_MOVE_LOCK = '/Users/mac/Work/cerida/contracts/Move.lock';
const CLONES           = '/Users/mac/clones/deepbookv3-testnet-4-16/packages';

// Dependency files that need temporary patching
const DEPS = [
  {
    toml:     `${CLONES}/token/Move.toml`,
    localAddr:  '0x1a7ac157c68c2479eee3aa0c7c439ca414381bf06d13a5a1198c4d139b0dc944',
    testnetAddr:'0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8',
  },
  {
    toml:     `${CLONES}/deepbook/Move.toml`,
    localAddr:  '0x9bb5d1d905c8294069b568241e48e20527e5293002fb1345f5d2385fb16cc960',
    testnetAddr:'0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982',
  },
  {
    toml:     `${CLONES}/predict/Move.toml`,
    localAddr:  '0x19fcec7fca4fe78c10ea1fd54036143887d7e3fa438d5dc075113d9334b04b04',
    testnetAddr: PREDICT_PKG,
  },
];

async function main() {
  const m = loadManifest();
  if (m.ceridaPkg) {
    console.log('cerida already deployed:', m.ceridaPkg);
    return;
  }

  console.log('\n═══ Deploy cerida → testnet ═══');
  console.log('Deployer:', ADDR);

  // Check gas
  const coins = await c.getCoins({ owner: ADDR });
  const gas = coins.data.reduce((s, x) => s + BigInt(x.balance), 0n);
  if (gas < 2_000_000_000n) throw new Error(`Need ≥ 2 SUI for gas (have ${gas})`);
  console.log('SUI balance:', Number(gas) / 1e9, 'SUI');

  // Save originals
  const originals = DEPS.map(d => ({
    ...d,
    orig: existsSync(d.toml) ? readFileSync(d.toml, 'utf8') : null,
  }));
  const origMoveLock = existsSync(CERIDA_MOVE_LOCK)
    ? readFileSync(CERIDA_MOVE_LOCK, 'utf8')
    : null;

  try {
    // 1. Patch all dependency Move.toml files: local → testnet addresses
    for (const dep of originals) {
      if (!dep.orig) continue;
      const patched = dep.orig.replace(new RegExp(dep.localAddr, 'g'), dep.testnetAddr);
      writeFileSync(dep.toml, patched);
      console.log(`  patched ${dep.toml.split('/').slice(-2).join('/')}`);
    }

    // 2. Switch to testnet env (framework deps fetch from RPC, not git).
    //    Delete Move.lock to bypass manifest_digest validation on patched files.
    execFileSync(SUI_BIN, ['client', 'switch', '--env', 'testnet'], { encoding: 'utf8' });
    if (existsSync(CERIDA_MOVE_LOCK)) rmSync(CERIDA_MOVE_LOCK);

    // 3. Build
    console.log('\nBuilding cerida...');
    let buildOut: string;
    try {
      buildOut = execFileSync(
        SUI_BIN,
        ['move', 'build', '--build-env', 'testnet', '--dump-bytecode-as-base64', '--path', CERIDA_CONTRACTS],
        { encoding: 'utf8', maxBuffer: 1 << 28 },
      );
    } catch (e: any) {
      throw new Error(`Build failed:\n${(e.stdout ?? e.message ?? '').trim()}`);
    }

    const obj = JSON.parse(buildOut);
    // deepbook is transitively referenced through predict's type signatures but
    // the CLI doesn't emit it in the dependencies array — add it manually.
    const DEEPBOOK_CURRENT = '0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8';
    const dependencies = [...obj.dependencies, DEEPBOOK_CURRENT];
    console.log('dependencies:', dependencies);

    // 4. Publish via SDK (CLI publish enforces env gate we don't need)
    console.log('Publishing...');
    const tx = new Transaction();
    const cap = tx.publish({ modules: obj.modules, dependencies });
    tx.transferObjects([cap], ADDR);
    tx.setGasBudget(2_000_000_000n);

    const r = await c.signAndExecuteTransaction({
      transaction: tx, signer: kp,
      options: { showObjectChanges: true, showEffects: true },
    });

    if (r.effects?.status.status !== 'success') {
      throw new Error(`Publish failed: ${JSON.stringify(r.effects?.status)}`);
    }

    const published = (r.objectChanges ?? []).find((x: any) => x.type === 'published');
    if (!published) throw new Error('No published package in tx');

    m.ceridaPkg = (published as any).packageId as string;
    saveManifest(m);

    console.log('\n✓ cerida deployed!');
    console.log('  ceridaPkg =', m.ceridaPkg);
    console.log('  digest    =', r.digest);

  } finally {
    // 5. Restore all originals and switch back to local env
    for (const dep of originals) {
      if (dep.orig) writeFileSync(dep.toml, dep.orig);
    }
    if (origMoveLock) writeFileSync(CERIDA_MOVE_LOCK, origMoveLock);
    try { execFileSync(SUI_BIN, ['client', 'switch', '--env', 'local'], { encoding: 'utf8' }); } catch {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
