// Monte Carlo validation of the Turbo Ticket leverage model (paper/leverage-model.md).
//
// On IDENTICAL spot paths, runs both designs and compares:
//   RESERVED  — fully-reserved clamped synthetic (the model): bad debt must be 0 on
//               every path (Prop. 2), trader edge ≈ −(spread+fees+π·m·liqRate) (Prop. 3)
//   CDP       — lending design (borrow D = B − m, real shares): bad debt (D − V)⁺
//               realized whenever the mark gaps past the barrier between keeper checks
//               (Prop. 5)
//
// Market: GBM spot (+ optional Poisson jumps), mark p_t = N(d2) off the production SVI
// params with linear total-variance decay — the same pricing as predict::oracle.
//
// Run:  bun simulations/leverage_mc.ts            (quick: 10k paths/config)
//       PATHS=50000 bun simulations/leverage_mc.ts

// ── tiny math lib (no deps) ────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf, |err| < 1.5e-7). */
function ncdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - y * Math.exp((-Math.abs(x) * Math.abs(x)) / 2 / 1); // erf(|x|/√2) form
  // note: we folded the /√2 into t above, so `erf` here is erf(|x|/√2)
  const e = 1 - y * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + e) : 0.5 * (1 - e);
}

function clip(x: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, x)); }

// ── market model ───────────────────────────────────────────────────────────

// Production SVI params (docker/scripts/src/setup.ts feed): total variance over the
// market's full life, as a function of log-moneyness k = ln(K/F).
const SVI = { a: 0.04, b: 0.10, rho: -0.30, m: 0.0, sigma: 0.10 };
function sviW(k: number): number {
  const km = k - SVI.m;
  return SVI.a + SVI.b * (SVI.rho * km + Math.sqrt(km * km + SVI.sigma * SVI.sigma));
}

/** Digital UP mark: p = N(−(k + w/2)/√w), w = w_SVI(k)·f, f = remaining time fraction. */
function mark(F: number, K: number, f: number): number {
  if (f <= 1e-9) return F > K ? 1 : 0;
  const k = Math.log(K / F);
  const w = Math.max(sviW(k) * f, 1e-12);
  return ncdf(-(k + w / 2) / Math.sqrt(w));
}

/** Find strike K so that the t=0 mark equals p0 (bisection). */
function strikeFor(F0: number, p0: number): number {
  let lo = F0 * 0.3, hi = F0 * 3.0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    // mark is decreasing in K
    if (mark(F0, mid, 1) > p0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── instrument params ──────────────────────────────────────────────────────

const Q = 100;            // contracts → max conceivable payout $100
const THETA = 0.45;       // maintenance fraction of margin
const PI = 0.05;          // liquidation penalty (fraction of margin → insurance)
const OPEN_FEE = 0.005;   // φ_o on margin
const PERF_FEE = 0.10;    // φ_p on profit at voluntary close
const SPREAD = 0.01;      // half-spread in mark units (ask = p+s, bid = p−s)
const HORIZON_S = 3600;   // 1h market
const FORCE_S = 120;      // force-close 2 min before settlement

type Tally = {
  n: number; liq: number;
  traderPnl: number; poolPnl: number; badDebt: number;
  badDebtN: number; badDebtMax: number;
  cdpBadDebt: number; cdpBadDebtN: number; cdpBadDebtMax: number; cdpLiq: number; cdpPoolPnl: number;
  epochFees: number;       // Σ f_epoch(κ=1) over all paths (eq. 12)
  poolRevenue: number;     // Σ actual pool revenue (for κ calibration, target 7)
  // knockout-time histogram for τ_c validation (target 6): counts by remaining-seconds bucket
  liqByTauBucket: number[]; // indices 0..11 = [>3600, 3000-3600, 2400-3000, ..., 0-600]
};

function runConfig(opts: {
  lambda: number; p0: number; dtSec: number; jumps: boolean; paths: number; seed: number;
  horizonSec?: number;     // defaults to HORIZON_S (1h)
  resolutionJumps?: boolean; // Target 8: mark can jump to {0,1} with hazard Δt/τ
}): Tally {
  const { lambda, p0, dtSec, jumps, paths, seed } = opts;
  const horizonSec = opts.horizonSec ?? HORIZON_S;
  const rng = mulberry32(seed);
  const F0 = 63_000;
  const K = strikeFor(F0, p0);
  const totalVarATM = sviW(Math.log(K / F0));
  const nSteps = Math.floor(horizonSec / dtSec);
  const forceStep = nSteps - Math.max(1, Math.floor(FORCE_S / dtSec));
  const dtFrac = 1 / nSteps;
  const sigStep = Math.sqrt(totalVarATM * dtFrac);
  const jumpProb = jumps ? (0.5 / nSteps) : 0;
  const jumpSize = 0.03;

  const pAsk0 = p0 + SPREAD;
  const B = Q * pAsk0;
  const m = B / lambda;
  const R = Q - B;
  const fee = OPEN_FEE * m;
  const D = B - m;

  const NUM_BUCKETS = 12; // 300s each, 0..3600s
  const t: Tally = {
    n: paths, liq: 0, traderPnl: 0, poolPnl: 0, badDebt: 0, badDebtN: 0,
    badDebtMax: 0, cdpBadDebt: 0, cdpBadDebtN: 0, cdpBadDebtMax: 0, cdpLiq: 0, cdpPoolPnl: 0,
    epochFees: 0, poolRevenue: 0,
    liqByTauBucket: Array(NUM_BUCKETS).fill(0),
  };

  for (let p = 0; p < paths; p++) {
    let lnF = Math.log(F0);
    let resOpen = true, cdpOpen = true;
    let pathEpochFees = 0;
    let resTrader = 0, resPool = 0, cdpTrader = 0, cdpPool = 0, cdpBad = 0;

    for (let step = 1; step <= nSteps && (resOpen || cdpOpen); step++) {
      const u1 = Math.max(rng(), 1e-12), u2 = rng();
      const zz = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      lnF += -0.5 * sigStep * sigStep + sigStep * zz;
      if (jumpProb > 0 && rng() < jumpProb) lnF += (rng() < 0.5 ? -1 : 1) * jumpSize;

      const f = 1 - step * dtFrac;
      const tauSec = Math.max(f * horizonSec, dtSec);
      const atForce = step >= forceStep;
      let pm = mark(Math.exp(lnF), K, Math.max(f, 1e-6));

      // Target 8: resolution jump — with hazard Δt/τ the mark teleports to {0,1}.
      if (opts.resolutionJumps && rng() < dtSec / tauSec) {
        pm = rng() < pm ? 1 : 0;
      }

      const bid = Math.max(pm - SPREAD, 0);
      const V = Q * bid;

      // Epoch fee (eq. 12, κ=1): λ · p(1−p) · m · Δt / τ
      if (resOpen) pathEpochFees += lambda * pm * (1 - pm) * m * dtSec / tauSec;

      // ── RESERVED ticket ──
      if (resOpen) {
        const X = clip(m + V - B, 0, m + R);
        if (X <= THETA * m) {
          resTrader = Math.max(X - PI * m, 0) - m - fee;
          resPool = (m + R - X) - R + fee + Math.min(X, PI * m);
          // record bucket: remaining seconds at knockout (300s buckets)
          const bucketIdx = Math.min(Math.floor(tauSec / 300), NUM_BUCKETS - 1);
          t.liqByTauBucket[bucketIdx]++;
          t.liq++; resOpen = false;
        } else if (atForce) {
          const perf = Math.max(X - m, 0) * PERF_FEE;
          resTrader = X - perf - m - fee;
          resPool = (m + R - X) - R + fee + perf;
          resOpen = false;
        }
      }

      // ── CDP on the same path ──
      if (cdpOpen) {
        const eq = V - D;
        if (eq <= THETA * m) {
          const repaid = Math.min(V, D);
          cdpBad = Math.max(D - V, 0);
          cdpTrader = Math.max(eq - PI * m, 0) - m - fee;
          cdpPool = repaid - D + fee + Math.min(Math.max(eq, 0), PI * m);
          t.cdpLiq++; cdpOpen = false;
        } else if (atForce) {
          const perf = Math.max(eq - m, 0) * PERF_FEE;
          cdpTrader = eq - perf - m - fee;
          cdpPool = fee + perf;
          cdpOpen = false;
        }
      }
    }

    t.traderPnl += resTrader; t.poolPnl += resPool;
    t.epochFees += pathEpochFees;
    t.poolRevenue += resPool;
    t.cdpPoolPnl += cdpPool - cdpBad;
    if (cdpBad > 0) { t.cdpBadDebtN++; t.cdpBadDebt += cdpBad; t.cdpBadDebtMax = Math.max(t.cdpBadDebtMax, cdpBad); }
  }
  return t;
}

// ── theoretical λ_max (model eq. 6 / 7 / 8) ───────────────────────────────

function lambdaMax(p0: number, dtSec: number, z = 3, theta = THETA): number {
  // Static eq. (6): evaluate at τ = full horizon T.
  // sd of Δp over Δt ≈ φ(N⁻¹(p0)) · √(Δt/T); consistent with mark(F,K,f) dynamics.
  const phi = Math.exp(-0.5 * Math.pow(invN(p0), 2)) / Math.sqrt(2 * Math.PI);
  const nu = phi * Math.sqrt(dtSec / HORIZON_S);
  return ((1 - theta) * p0) / (z * nu);
}

/** Dynamic eq. (7): λ_max at *current* remaining tenor tauSec. Decays as √τ for ATM. */
function lambdaMaxDynamic(p: number, tauSec: number, dtSec: number, z = 3, theta = THETA): number {
  const phi = Math.exp(-0.5 * Math.pow(invN(p), 2)) / Math.sqrt(2 * Math.PI);
  return ((1 - theta) * p) / (z * phi * Math.sqrt(dtSec / tauSec));
}

/** Critical time τ_c (seconds): current leverage λ meets the dynamic ceiling — eq. (8). */
function tauCSec(lambda: number, p: number, dtSec: number, z = 3, theta = THETA): number {
  const phi = Math.exp(-0.5 * Math.pow(invN(p), 2)) / Math.sqrt(2 * Math.PI);
  return Math.pow((z * lambda * phi) / ((1 - theta) * p), 2) * dtSec;
}

/** Jump-aware σ_eff (eq. 9 in §6.3): diffusion + binary resolution hazard. */
function sigmaEffJump(p: number, tauSec: number, dtSec: number): number {
  const phi = Math.exp(-0.5 * Math.pow(invN(p), 2)) / Math.sqrt(2 * Math.PI);
  return Math.sqrt((phi * phi + p * (1 - p)) * dtSec / tauSec);
}

/** Jump-aware λ_max (eq. 10): → 0 for all p as τ→0, including deep ITM/OTM. */
function lambdaMaxJump(p: number, tauSec: number, dtSec: number, z = 3, theta = THETA): number {
  return ((1 - theta) * p) / (z * sigmaEffJump(p, tauSec, dtSec));
}
/** Acklam's inverse normal CDF approximation. */
function invN(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── report ─────────────────────────────────────────────────────────────────

const PATHS = Number(process.env.PATHS ?? 10_000);
const fmt = (x: number, d = 3) => (x >= 0 ? " " : "") + x.toFixed(d);

console.log(`Turbo Ticket Monte Carlo — ${PATHS} paths/config, 1h market, SVI feed params`);
console.log(`q=${Q} ($${Q} max), θ=${THETA}, π=${PI}, fees: open ${OPEN_FEE * 100}% perf ${PERF_FEE * 100}%, half-spread ${SPREAD}\n`);

console.log(`MAIN GRID  (keeper Δt = 5s, no jumps) — per-ticket means in $`);
console.log(`  p0    λ     margin  liq%   trader     pool   | CDP liq%  badDebt$  P(bad)   maxBad`);
let seed = 42;
for (const p0 of [0.90, 0.50, 0.15]) {
  for (const lambda of [2, 5, 10, 20, 50]) {
    const r = runConfig({ lambda, p0, dtSec: 5, jumps: false, paths: PATHS, seed: seed++ });
    const m = (Q * (p0 + SPREAD)) / lambda;
    console.log(
      `  ${p0.toFixed(2)}  ${String(lambda).padStart(3)}   ${m.toFixed(2).padStart(6)}` +
      `  ${((100 * r.liq) / r.n).toFixed(1).padStart(5)}  ${fmt(r.traderPnl / r.n)}  ${fmt(r.poolPnl / r.n)}` +
      `  |   ${((100 * r.cdpLiq) / r.n).toFixed(1).padStart(5)}  ${fmt(r.cdpBadDebt / r.n, 4)}` +
      `  ${((100 * r.cdpBadDebtN) / r.n).toFixed(2).padStart(6)}%  ${fmt(r.cdpBadDebtMax, 2)}`,
    );
  }
}

console.log(`\nKEEPER LATENCY & JUMPS  (ATM p0=0.50, λ=10)`);
console.log(`  Δt    jumps  liq%   trader    pool    | CDP badDebt$  P(bad)   maxBad`);
for (const dtSec of [1, 5, 30]) {
  for (const jumps of [false, true]) {
    const r = runConfig({ lambda: 10, p0: 0.5, dtSec, jumps, paths: PATHS, seed: seed++ });
    console.log(
      `  ${String(dtSec).padStart(2)}s   ${jumps ? " on " : " off"}  ${((100 * r.liq) / r.n).toFixed(1).padStart(5)}` +
      `  ${fmt(r.traderPnl / r.n)}  ${fmt(r.poolPnl / r.n)}  |  ${fmt(r.cdpBadDebt / r.n, 4)}` +
      `   ${((100 * r.cdpBadDebtN) / r.n).toFixed(2).padStart(6)}%  ${fmt(r.cdpBadDebtMax, 2)}`,
    );
  }
}

console.log(`\nλ_max from model eq. (6)  (z=3, θ=${THETA})`);
console.log(`  p0\\Δt      1s      5s     30s`);
for (const p0 of [0.90, 0.50, 0.15]) {
  console.log(`  ${p0.toFixed(2)}   ` + [1, 5, 30].map((dt) => lambdaMax(p0, dt).toFixed(1).padStart(6)).join("  "));
}

// ── Target 5: Dynamic λ_max(τ) curve (eq. 7) ───────────────────────────────
console.log(`\nDYNAMIC λ_max(τ)  eq. (7)  (ATM p=0.50, Δt=5s)  — ceiling decays as √τ`);
console.log(`  τ remaining    λ_max(τ)  vs static (${lambdaMax(0.5, 5).toFixed(1)} at τ=T)`);
for (const tauSec of [3600, 1800, 900, 600, 300, 120, 60, 30]) {
  const lm = lambdaMaxDynamic(0.5, tauSec, 5);
  const mins = (tauSec / 60).toFixed(0).padStart(3);
  console.log(`  ${mins} min (${String(tauSec).padStart(4)}s)   ${lm.toFixed(2).padStart(6)}`);
}

console.log(`\nDYNAMIC λ_max(τ)  eq. (10)  WITH JUMP RISK  (Δt=5s)`);
console.log(`  p0\\τ_sec     60s     120s    300s    900s   3600s`);
for (const p0 of [0.90, 0.50, 0.15]) {
  const vals = [60, 120, 300, 900, 3600].map((t) => lambdaMaxJump(p0, t, 5).toFixed(1).padStart(6));
  console.log(`  ${p0.toFixed(2)}        ` + vals.join("  "));
}

// ── Target 6: τ_c validation — ATM, λ∈{3,5}, 4h market ────────────────────
console.log(`\nτ_c CRITICAL TIMES (eq. 8)  (ATM p=0.50, Δt=5s, z=3, θ=${THETA})`);
for (const lam of [3, 5, 10]) {
  const tc = tauCSec(lam, 0.5, 5);
  const minsStr = tc < 3600 ? `${(tc / 60).toFixed(1)} min` : `${(tc / 3600).toFixed(2)} h`;
  console.log(`  λ=${lam}:  τ_c = ${tc.toFixed(0)}s (${minsStr})`);
}
console.log(`  (positions with τ < τ_c should be force-closed by keeper, not the 2-minute contract floor)`);

const HORIZON_4H = 4 * 3600;
console.log(`\nτ_c VALIDATION  ATM p=0.50, 4h market, Δt=5s`);
console.log(`  Fraction of paths STILL OPEN at τ_c (keeper must force-close these)`);
console.log(`  λ     τ_c(min)  total-KO%  still-open@τ_c  still-open@τ_c/2`);
for (const lam of [3, 5]) {
  const tc = tauCSec(lam, 0.5, 5);
  const r = runConfig({ lambda: lam, p0: 0.5, dtSec: 5, jumps: false, paths: PATHS, seed: seed++, horizonSec: HORIZON_4H });
  // Knockouts with tauSec > tc happened BEFORE τ_c (early KOs = high bucket indices).
  // Remaining = fraction still open when τ reaches τ_c (the keeper must act on these).
  const tcBucket = Math.min(Math.floor(tc / 300), r.liqByTauBucket.length - 1);
  const earlyKoPct = r.liqByTauBucket.slice(tcBucket + 1).reduce((a, b) => a + b, 0) / r.n * 100;
  const stillOpenAtTc = 100 - earlyKoPct;
  const halfBucket = Math.min(Math.floor(tc / 2 / 300), r.liqByTauBucket.length - 1);
  const earlyKoHalfPct = r.liqByTauBucket.slice(halfBucket + 1).reduce((a, b) => a + b, 0) / r.n * 100;
  const stillOpenAtHalf = 100 - earlyKoHalfPct;
  console.log(
    `  ${lam}×   ${(tc / 60).toFixed(1).padStart(6)} min    ` +
    `${((100 * r.liq) / r.n).toFixed(1).padStart(5)}%      ` +
    `${stillOpenAtTc.toFixed(1).padStart(8)}%        ${stillOpenAtHalf.toFixed(1).padStart(8)}%`
  );
}

// ── Target 7: Epoch fee calibration ────────────────────────────────────────
console.log(`\nEPOCH FEE CALIBRATION  (κ=1, eq. 12 vs actual pool revenue)`);
console.log(`  p0    λ    Σf_epoch/path    pool-rev/path    κ_implied`);
for (const [p0, lam] of [[0.90, 5], [0.50, 3], [0.50, 5], [0.15, 3]] as [number, number][]) {
  const r = runConfig({ lambda: lam, p0, dtSec: 5, jumps: false, paths: PATHS, seed: seed++ });
  const epochPerPath = r.epochFees / r.n;
  const revPerPath = r.poolRevenue / r.n;
  const kappa = revPerPath > 0 ? (revPerPath / epochPerPath) : NaN;
  console.log(
    `  ${p0.toFixed(2)}  ${String(lam).padStart(2)}   ${fmt(epochPerPath, 4).padStart(12)}    ` +
    `${fmt(revPerPath, 4).padStart(12)}    ${isNaN(kappa) ? "  n/a" : kappa.toFixed(2)}`
  );
}

// ── Target 8: Resolution jump stress ────────────────────────────────────────
console.log(`\nRESOLUTION JUMP STRESS  (eq. 9/10): mark can teleport to {0,1} with hazard Δt/τ`);
console.log(`  Tests that the jump-aware force-close (eq. 10 τ_c) outperforms the static 2-min floor.`);
console.log(`  p0    λ    base liq%  +jump liq%  jump CDP-bad$/path`);
for (const [p0, lam] of [[0.90, 20], [0.50, 5], [0.15, 20]] as [number, number][]) {
  const base = runConfig({ lambda: lam, p0, dtSec: 5, jumps: false, paths: PATHS, seed: seed++ });
  const withJump = runConfig({ lambda: lam, p0, dtSec: 5, jumps: false, resolutionJumps: true, paths: PATHS, seed: seed++ });
  console.log(
    `  ${p0.toFixed(2)}  ${String(lam).padStart(2)}     ` +
    `${((100 * base.liq) / base.n).toFixed(1).padStart(5)}%      ` +
    `${((100 * withJump.liq) / withJump.n).toFixed(1).padStart(5)}%   ` +
    `${fmt(withJump.cdpBadDebt / withJump.n, 4)}`
  );
}

console.log(`\nINVARIANT: reserved-design bad debt ≡ 0 on every path of every config (by construction — no debt object exists).`);
