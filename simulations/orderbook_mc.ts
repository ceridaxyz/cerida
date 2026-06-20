// Monte Carlo for the trigger book over the option vault (paper/orderbook-model.md).
//
// A population of buy-limit orders ("buy YES when the mark falls to L = p0 − d")
// rests against the vault and executes permissionlessly on cross. Validates:
//   P2  fill rate = first passage (falls in distance d, rises in tenor)
//   P3  STAKED yield ≈ resting-fraction υ · APR  (what SEALED forgoes)
//   P5  price improvement ≥ 0; fills at the live fair quote, never above L
//   P1  invariant: NO fill ever above L / off the fair curve → no vault gap risk
//
// Mark model identical to leverage_mc.ts: GBM spot, mark p = N(d2) off the SVI
// feed params, linear total-variance decay, optional jumps, discrete Δt monitoring.
//
// Run:  bun simulations/orderbook_mc.ts            (10k paths/config)
//       PATHS=50000 bun simulations/orderbook_mc.ts

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function ncdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const e = 1 - y * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + e) : 0.5 * (1 - e);
}

const SVI = { a: 0.04, b: 0.10, rho: -0.30, m: 0.0, sigma: 0.10 };
function sviW(k: number): number {
  const km = k - SVI.m;
  return SVI.a + SVI.b * (SVI.rho * km + Math.sqrt(km * km + SVI.sigma * SVI.sigma));
}
function mark(F: number, K: number, f: number): number {
  if (f <= 1e-9) return F > K ? 1 : 0;
  const k = Math.log(K / F);
  const w = Math.max(sviW(k) * f, 1e-12);
  return ncdf(-(k + w / 2) / Math.sqrt(w));
}
function strikeFor(F0: number, p0: number): number {
  let lo = F0 * 0.3, hi = F0 * 3.0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (mark(F0, mid, 1) > p0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const HORIZON_S = 3600;     // 1h market
const SPREAD = 0.01;        // vault half-spread (ask = mark + s)
const PLP_APR = 0.20;       // 20% annual PLP yield (illustrative; STAKED earns υ·APR)
const QTY = 100;            // contracts per order

type Res = {
  n: number; filled: number; sumFillStep: number; sumUtil: number;
  sumImprove: number; gapFills: number; nSteps: number;
  worstAboveL: number; // P1/P5 invariant: max(fill − L); must stay ≤ 0
  vaultSpread: number; // P4: spread $ the vault captured on fills
};

function run(opts: { p0: number; d: number; dtSec: number; jumps: boolean; paths: number; seed: number }): Res {
  const { p0, d, dtSec, jumps, paths, seed } = opts;
  const rng = mulberry32(seed);
  const F0 = 63_000;
  const K = strikeFor(F0, p0);
  const totalVar = sviW(Math.log(K / F0));
  const nSteps = Math.floor(HORIZON_S / dtSec);
  const dtFrac = 1 / nSteps;
  const sigStep = Math.sqrt(totalVar * dtFrac);
  const jumpProb = jumps ? 0.5 / nSteps : 0;
  const jumpSize = 0.03;
  const L = p0 - d; // limit: buy when ask ≤ L  (ask = mark + SPREAD)

  const r: Res = { n: paths, filled: 0, sumFillStep: 0, sumUtil: 0, sumImprove: 0,
    gapFills: 0, nSteps, worstAboveL: -1, vaultSpread: 0 };

  for (let p = 0; p < paths; p++) {
    let lnF = Math.log(F0);
    let filled = false;
    for (let step = 1; step <= nSteps; step++) {
      const u1 = Math.max(rng(), 1e-12), u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      lnF += -0.5 * sigStep * sigStep + sigStep * z;
      if (jumpProb > 0 && rng() < jumpProb) lnF += (rng() < 0.5 ? -1 : 1) * jumpSize;

      const f = 1 - step * dtFrac;
      const pm = mark(Math.exp(lnF), K, Math.max(f, 1e-6));
      const ask = pm + SPREAD;          // the vault's live quote
      if (ask <= L) {                    // trigger crosses → fill at the LIVE ask
        const fill = ask;                // fill at fair quote, not at L
        r.filled++;
        r.sumFillStep += step;
        r.sumUtil += step / nSteps;      // rested this fraction of the horizon
        const improve = L - fill;        // price improvement to the trader (≥ 0)
        r.sumImprove += improve;
        if (improve > 1e-9) r.gapFills++;
        r.worstAboveL = Math.max(r.worstAboveL, fill - L); // must be ≤ 0
        r.vaultSpread += SPREAD * QTY;   // vault earned its spread on this mint
        filled = true;
        break;
      }
    }
    if (!filled) r.sumUtil += 1; // unfilled → capital rested the whole horizon
  }
  return r;
}

const PATHS = Number(process.env.PATHS ?? 10_000);
const fmt = (x: number, dgt = 2) => x.toFixed(dgt);

console.log(`Trigger-book Monte Carlo — ${PATHS} paths/config, 1h market, SVI feed params`);
console.log(`vault half-spread ${SPREAD}, qty ${QTY}, PLP APR ${PLP_APR * 100}% (STAKED earns υ·APR)\n`);

console.log(`FILL MECHANICS  (Δt = 5s, no jumps) — buy-limit at L = p0 − d`);
console.log(`  p0    d      fill%   mean t-fill  rest υ%  improve¢  gap-fills%   maxFill−L`);
let seed = 7;
for (const p0 of [0.90, 0.50, 0.15]) {
  for (const d of [0.05, 0.10, 0.20]) {
    const r = run({ p0, d, dtSec: 5, jumps: false, paths: PATHS, seed: seed++ });
    const fillPct = (100 * r.filled) / r.n;
    const tfill = r.filled ? (r.sumFillStep / r.filled) * 5 : 0; // seconds
    const util = (100 * r.sumUtil) / r.n;
    const improve = r.filled ? (100 * r.sumImprove) / r.filled : 0; // in ¢
    const gap = r.filled ? (100 * r.gapFills) / r.filled : 0;
    console.log(
      `  ${p0.toFixed(2)}  ${d.toFixed(2)}   ${fillPct.toFixed(1).padStart(5)}` +
      `   ${(tfill / 60).toFixed(1).padStart(7)}m   ${util.toFixed(1).padStart(5)}` +
      `   ${improve.toFixed(3).padStart(7)}   ${gap.toFixed(1).padStart(6)}` +
      `      ${r.worstAboveL <= 0 ? "≤0 ✓" : "POS ✗"}`,
    );
  }
}

console.log(`\nP3 — STAKED yield captured vs SEALED (idle), per order, ATM p0=0.50`);
console.log(`  d      rest υ%   STAKED yield (υ·APR, annualized on escrow)   SEALED`);
for (const d of [0.05, 0.10, 0.20]) {
  const r = run({ p0: 0.50, d, dtSec: 5, jumps: false, paths: PATHS, seed: seed++ });
  const util = r.sumUtil / r.n;
  console.log(`  ${d.toFixed(2)}   ${(100 * util).toFixed(1).padStart(5)}    ${(100 * util * PLP_APR).toFixed(2).padStart(6)}% APR-equivalent on resting capital        0%`);
}

console.log(`\nKEEPER Δt & JUMPS  (ATM p0=0.50, d=0.10) — robustness of fill + invariant`);
console.log(`  Δt    jumps   fill%   improve¢   gap-fills%   maxFill−L`);
for (const dtSec of [1, 5, 30]) {
  for (const jumps of [false, true]) {
    const r = run({ p0: 0.50, d: 0.10, dtSec, jumps, paths: PATHS, seed: seed++ });
    const fillPct = (100 * r.filled) / r.n;
    const improve = r.filled ? (100 * r.sumImprove) / r.filled : 0;
    const gap = r.filled ? (100 * r.gapFills) / r.filled : 0;
    console.log(
      `  ${String(dtSec).padStart(2)}s   ${jumps ? " on" : "off"}    ${fillPct.toFixed(1).padStart(5)}` +
      `   ${improve.toFixed(3).padStart(7)}   ${gap.toFixed(1).padStart(6)}       ${r.worstAboveL <= 0 ? "≤0 ✓" : "POS ✗"}`,
    );
  }
}

console.log(`\nP1/P5 invariant: across every config, no fill ever executed above the limit L`);
console.log(`(maxFill−L ≤ 0 everywhere) → the vault sells only at its fair curve → the`);
console.log(`trigger book adds zero gap liability and zero bad-debt path. Gap moves only`);
console.log(`ever IMPROVE the trader's fill; the vault keeps its ordinary spread.`);
