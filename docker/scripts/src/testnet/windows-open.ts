// Window bet (grid trading) — open side.
//
// Creates a WindowBook with 3 bands around BTC ATM, supplies LP, rolls an
// epoch, and places + executes a bet on the ATM-containing band.
//
// Lifecycle:
//   1. create_and_share  (WindowBook shared object)
//   2. windows::supply   ($50 LP)
//   3. windows::roll_epoch  (4 strikes bracketing forward)
//   4. vault::request_window_bet
//   5. vault::execute_window_bet (keeper)
//   → saves windowBookId / windowEpochId / windowBetTicketId / windowEpochExpiry
//
// After the oracle expires run:  bun src/testnet/windows-settle.ts
//
// Run: bun src/testnet/windows-open.ts

import { Transaction } from '@mysten/sui/transactions';
import {
  c, kp, ADDR,
  PREDICT_OBJ, DUSDC_TYPE, CLOCK,
  PRICE_SCALE, DUSDC_SCALE, PREDICT_SERVER,
  loadManifest, saveManifest, type Manifest,
} from './config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BAND_COUNT    = 3n;    // 3 bands → 4 strikes
const SPREAD_BPS    = 200n;  // 2% LP spread revenue per bet
const SKEW_BPS      = 100n;  // 1% skew sensitivity (inventory control)
const LP_SUPPLY     = 50n;   // dUSDC into the window pool
const BET_ESCROW    = 10n;   // dUSDC escrowed per bet (max_cost; refunds excess)
const BET_QTY       = 5n;    // contracts per bet

// Band widths are computed dynamically from the oracle's implied sigma so
// each band sits at ~30-40% probability. Fixed wide offsets fail because
// predict refuses to mint a range option priced > ~0.99 (essentially certain).
// We derive sigma from time-to-expiry using a 60% annual vol assumption:
//   sigma_usd = forward × 0.60 × √(tYears)
// Then set:
//   inner half-width = 0.5 × sigma  (~38% probability for the flat band)
//   outer reach      = 2.5 × sigma  (captures >99% of distribution)
const ANNUAL_VOL    = 0.60;  // 60% annualised vol assumption for BTC 0DTE
const BET_BAND_IDX  = 1;  // index of the ATM-containing band

// ── Helpers ──────────────────────────────────────────────────────────────────

type TxResult = Awaited<ReturnType<typeof c.signAndExecuteTransaction>>;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion: ${msg}`);
}

async function exec(tx: Transaction, label: string): Promise<TxResult> {
  tx.setGasBudget(2_000_000_000n);
  process.stdout.write(`  → ${label}… `);
  const r = await c.signAndExecuteTransaction({
    transaction: tx, signer: kp,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (r.effects?.status.status !== 'success') {
    console.log('FAILED');
    throw new Error(`${label} failed: ${JSON.stringify(r.effects?.status)}`);
  }
  await c.waitForTransaction({ digest: r.digest });
  console.log(`✓  (${r.digest})`);
  return r;
}

function findEvent(r: TxResult, typeSuffix: string): any {
  return (r.events ?? []).find((e: any) => String(e.type).includes(typeSuffix));
}

function findCreatedByType(r: TxResult, typeFragment: string): string | null {
  const obj = (r.objectChanges ?? []).find(
    (x: any) => x.type === 'created' && String(x.objectType).includes(typeFragment),
  ) as any;
  return obj?.objectId ?? null;
}

// ── Oracle: pick the soonest active oracle ────────────────────────────────────

async function fetchOracle() {
  const res  = await fetch(`${PREDICT_SERVER}/oracles`);
  const all: any[] = await res.json();
  const now  = Date.now();
  // Use the soonest oracle that hasn't expired yet and has at least 5 min left
  const candidates = all
    .filter(o => o.status === 'active' && o.expiry > now + 5 * 60_000)
    .sort((a, b) => a.expiry - b.expiry);
  assert(candidates.length > 0, 'No active oracle with ≥5 min remaining');

  const o      = candidates[0];
  const obj    = await c.getObject({ id: o.oracle_id, options: { showContent: true } });
  const fields = (obj.data?.content as any)?.fields ?? {};
  const forward = BigInt(fields.prices?.fields?.forward ?? 0);
  const tick    = BigInt(o.tick_size ?? 1_000_000_000n);
  const atm     = (forward / tick) * tick;

  return {
    oracleId: o.oracle_id as string,
    expiry:   o.expiry as number,
    forward,
    atm,
    tick,
  };
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function createWindowBook(ceridaPkg: string): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::windows::create_and_share`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.pure.u64(BAND_COUNT),
      tx.pure.u64(SPREAD_BPS),
      tx.pure.u64(SKEW_BPS),
    ],
  });
  const r = await exec(tx, `windows::create_and_share (${BAND_COUNT} bands, ${SPREAD_BPS}bps spread)`);
  const ev = findEvent(r, '::windows::WindowBookCreated');
  if (ev?.parsedJson?.book_id) return ev.parsedJson.book_id;
  // fallback: first created WindowBook object
  const id = findCreatedByType(r, 'WindowBook');
  assert(id, 'WindowBook object not found in tx');
  return id!;
}

async function supplyLP(ceridaPkg: string, windowBookId: string, coinRef: any): Promise<void> {
  const tx   = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  const [payment] = tx.splitCoins(base, [tx.pure.u64(LP_SUPPLY * DUSDC_SCALE)]);
  const share = tx.moveCall({
    target: `${ceridaPkg}::windows::supply`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(windowBookId), payment],
  });
  tx.transferObjects([share], ADDR);
  await exec(tx, `windows::supply ${LP_SUPPLY} dUSDC`);
}

// Compute strikes so each band sits at ~30-40% probability.
// sigma_usd = forward × ANNUAL_VOL × √(tYears); inner half-width = 0.5σ,
// outer reach = 2.5σ. All values rounded to the oracle tick size.
function computeStrikes(atm: bigint, forward: bigint, expiry: number, tick: bigint): bigint[] {
  const tYears   = Math.max((expiry - Date.now()) / (365.25 * 24 * 3600 * 1000), 1 / 525_960);
  const fwdUsd   = Number(forward) / Number(PRICE_SCALE);
  const sigmaUsd = fwdUsd * ANNUAL_VOL * Math.sqrt(tYears);

  const innerDollar = Math.max(Math.round(sigmaUsd * 0.5), 1);
  const outerDollar = Math.max(Math.round(sigmaUsd * 2.5), innerDollar + 1);

  // d is in whole dollars; strikes are in raw PRICE_SCALE units.
  // snap: convert dollars → raw, then floor to nearest tick.
  const snap = (d: number) => (BigInt(Math.round(d)) * PRICE_SCALE / tick) * tick;

  return [
    atm - snap(outerDollar),   // s0: outer bear
    atm - snap(innerDollar),   // s1: inner bear/flat boundary
    atm + snap(innerDollar),   // s2: flat/bull boundary
    atm + snap(outerDollar),   // s3: outer bull
  ];
}

async function rollEpoch(
  ceridaPkg: string, windowBookId: string,
  oracleId: string, expiry: number, atm: bigint, forward: bigint, tick: bigint,
): Promise<{ epochId: number; strikes: bigint[] }> {
  const strikes = computeStrikes(atm, forward, expiry, tick);
  const [s0, s1, s2, s3] = strikes;

  console.log(`  Strikes (sigma-adjusted):`);
  console.log(`    Band 0 BEAR: $${s0/PRICE_SCALE} – $${s1/PRICE_SCALE}`);
  console.log(`    Band 1 FLAT: $${s1/PRICE_SCALE} – $${s2/PRICE_SCALE}  ← betting here`);
  console.log(`    Band 2 BULL: $${s2/PRICE_SCALE} – $${s3/PRICE_SCALE}`);

  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::windows::roll_epoch`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(windowBookId),
      tx.pure.id(oracleId),
      tx.pure.u64(expiry),
      tx.pure.vector('u64', strikes),
      tx.object(CLOCK),
    ],
  });
  const r = await exec(tx, `windows::roll_epoch → oracle expiry ${new Date(expiry).toISOString()}`);
  const ev = findEvent(r, '::windows::EpochRolled');
  assert(ev?.parsedJson, 'EpochRolled event missing');
  return { epochId: Number((ev.parsedJson as any).epoch_id), strikes };
}

async function requestWindowBet(
  ceridaPkg: string, vaultId: string,
  windowEpochId: number, coinRef: any,
): Promise<number> {
  const tx   = new Transaction();
  const base = tx.object(coinRef.coinObjectId);
  const [payment] = tx.splitCoins(base, [tx.pure.u64(BET_ESCROW * DUSDC_SCALE)]);
  tx.moveCall({
    target: `${ceridaPkg}::vault::request_window_bet`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.pure.u64(windowEpochId),
      tx.pure.u64(BET_BAND_IDX),
      tx.pure.u64(BET_QTY),
      payment,
    ],
  });
  const r = await exec(tx, `request_window_bet epoch=${windowEpochId} band=${BET_BAND_IDX} qty=${BET_QTY}`);
  const ev = findEvent(r, '::vault::WindowBetRequested');
  assert(ev?.parsedJson, 'WindowBetRequested event missing');
  return Number((ev.parsedJson as any).intent_id);
}

async function executeWindowBet(
  ceridaPkg: string, vaultId: string, managerId: string,
  windowBookId: string, oracleId: string, intentId: number,
): Promise<{ betTicketId: string; sviAsk: bigint; totalBasis: bigint }> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ceridaPkg}::vault::execute_window_bet`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(vaultId),
      tx.object(managerId),
      tx.object(PREDICT_OBJ),
      tx.object(oracleId),
      tx.object(windowBookId),
      tx.pure.u64(intentId),
      tx.object(CLOCK),
    ],
  });
  const r = await exec(tx, `execute_window_bet intent #${intentId}`);

  const betTicketId = findCreatedByType(r, 'BetTicket');
  assert(betTicketId, 'BetTicket not found in object changes');

  const ev = findEvent(r, '::vault::WindowBetExecuted');
  const sviAsk    = BigInt((ev?.parsedJson as any)?.svi_ask    ?? 0);
  const totalBasis = BigInt((ev?.parsedJson as any)?.total_basis ?? 0);

  return { betTicketId: betTicketId!, sviAsk, totalBasis };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const m = loadManifest();
  assert(m.ceridaPkg,  'ceridaPkg missing — run deploy.ts first');
  assert(m.vaultId,    'vaultId missing   — run flow.ts first');
  assert(m.managerId,  'managerId missing — run flow.ts first');

  const { ceridaPkg, vaultId, managerId } = m as Required<Manifest>;

  console.log('\n═══ Cerida Window Bet (Grid) — Open ═══');
  console.log(`Address:   ${ADDR}`);
  console.log(`ceridaPkg: ${ceridaPkg}`);
  console.log(`vault:     ${vaultId}`);

  // Balance check
  const coinsRes = await c.getCoins({ owner: ADDR, coinType: DUSDC_TYPE });
  const coins    = coinsRes.data;
  const total    = coins.reduce((s, x) => s + BigInt(x.balance), 0n);
  console.log(`\ndUSDC balance: $${total / DUSDC_SCALE}`);
  const needed = (LP_SUPPLY + BET_ESCROW) * DUSDC_SCALE;
  assert(total >= needed, `Need ≥ $${needed / DUSDC_SCALE} dUSDC`);

  if (coins.length > 1) {
    const tx   = new Transaction();
    const base = tx.object(coins[0].coinObjectId);
    tx.mergeCoins(base, coins.slice(1).map(x => tx.object(x.coinObjectId)));
    await exec(tx, 'merge dUSDC coins');
  }
  const coinRef = (await c.getCoins({ owner: ADDR, coinType: DUSDC_TYPE })).data[0];

  // Oracle
  console.log('\n─── Oracle ───');
  const oracle = await fetchOracle();
  const mins   = Math.ceil((oracle.expiry - Date.now()) / 60_000);
  console.log(`  id      = ${oracle.oracleId}`);
  console.log(`  expiry  = ${new Date(oracle.expiry).toISOString()} (${mins} min)`);
  console.log(`  forward = $${oracle.forward / PRICE_SCALE}`);
  console.log(`  ATM     = $${oracle.atm / PRICE_SCALE}`);

  // 1. Create WindowBook (reuse if already created)
  let windowBookId = m.windowBookId ?? '';
  if (windowBookId) {
    console.log(`\n─── WindowBook (existing) ───`);
    console.log(`  windowBookId = ${windowBookId}`);
  } else {
    console.log('\n─── Create WindowBook ───');
    windowBookId = await createWindowBook(ceridaPkg);
    console.log(`  windowBookId = ${windowBookId}`);
    m.windowBookId = windowBookId;
    saveManifest(m);

    // 2. Supply LP (only needed when creating a fresh book)
    console.log('\n─── Supply LP ───');
    await supplyLP(ceridaPkg, windowBookId, coinRef);
  }

  // 3. Roll epoch
  console.log('\n─── Roll Epoch ───');
  const { epochId: windowEpochId, strikes } = await rollEpoch(
    ceridaPkg, windowBookId, oracle.oracleId, oracle.expiry, oracle.atm, oracle.forward, oracle.tick,
  );
  console.log(`  epoch_id = ${windowEpochId}`);

  // 4. Request bet
  console.log('\n─── Request Window Bet ───');
  const intentId = await requestWindowBet(ceridaPkg, vaultId, windowEpochId, coinRef);
  console.log(`  intent_id = ${intentId}`);

  // 5. Execute bet (keeper)
  console.log('\n─── Execute Window Bet ───');
  const { betTicketId, sviAsk, totalBasis } = await executeWindowBet(
    ceridaPkg, vaultId, managerId, windowBookId, oracle.oracleId, intentId,
  );
  console.log(`  betTicketId  = ${betTicketId}`);
  console.log(`  svi_ask      = ${sviAsk} raw (fair value → Predict hedge)`);
  console.log(`  total_basis  = ${totalBasis} raw (user paid)`);
  console.log(`  lp_revenue   = ${totalBasis - sviAsk} raw (spread+skew to pool)`);

  // Save state for settle script
  m.windowBookId       = windowBookId;
  m.windowEpochId      = windowEpochId;
  m.windowBetTicketId  = betTicketId;
  m.windowEpochExpiry  = oracle.expiry;
  m.windowOracleId     = oracle.oracleId;
  saveManifest(m);

  const [, s1, s2] = strikes;

  console.log(`
═══ Summary ═══
  Bet on:   Band 1 FLAT  $${s1/PRICE_SCALE} – $${s2/PRICE_SCALE}
  Qty:      ${BET_QTY} contracts
  Paid:     ${Number(totalBasis) / Number(DUSDC_SCALE)} dUSDC (incl. ${SPREAD_BPS}bps spread + ${SKEW_BPS}bps skew)
  Ticket:   ${betTicketId}

  Oracle expires: ${new Date(oracle.expiry).toISOString()} (${mins} min)

  ⏳  Wait until expiry, then run:
      bun src/testnet/windows-settle.ts
`);
}

main().catch(e => { console.error(e); process.exit(1); });
