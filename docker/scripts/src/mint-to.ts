// One-shot: mint dUSDC + fund SUI gas to a given address on localnet.
// Usage: RECIPIENT=0x... bun src/mint-to.ts [amount_usdc]

import { Transaction } from '@mysten/sui/transactions';
import { client, deployer, fund, loadManifest, need, DUSDC_SCALE } from './config.ts';

const recipient = process.env.RECIPIENT;
if (!recipient) {
  console.error('Set RECIPIENT=0x...');
  process.exit(1);
}

const usdcAmount = BigInt(process.argv[2] ?? '100000') * DUSDC_SCALE; // default 100k dUSDC
const m = loadManifest();
const c = client();
const kp = deployer();

console.log(`Funding SUI gas to ${recipient}…`);
await fund(recipient);
console.log('SUI faucet done.');

const tx = new Transaction();
const coin = tx.moveCall({
  target: '0x2::coin::mint',
  typeArguments: [need(m, 'dusdcType')],
  arguments: [tx.object(need(m, 'dusdcCap')), tx.pure.u64(usdcAmount)],
});
tx.transferObjects([coin], tx.pure.address(recipient));
tx.setGasBudget(10_000_000);

const r = await c.signAndExecuteTransaction({
  transaction: tx,
  signer: kp,
  options: { showEffects: true },
});

if (r.effects?.status.status !== 'success') {
  console.error('Mint failed:', r.effects?.status);
  process.exit(1);
}

console.log(`Minted ${Number(usdcAmount) / Number(DUSDC_SCALE)} dUSDC → ${recipient}`);
console.log('Digest:', r.digest);
