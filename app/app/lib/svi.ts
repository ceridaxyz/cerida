// SVI surface → binary (yes/no) prices.
//
// SVI total variance at log-moneyness k:
//   w(k) = a + b·( rho·(k − m) + sqrt((k − m)² + sigma²) )
// w is TOTAL variance (σ²·T), so the digital "settles above K" price is just the
// Black-Scholes risk-neutral probability N(d2) with d2 = (ln(F/K) − w/2) / √w.
// (Undiscounted, matching Predict's settlement on testnet.)

// Minimal SVI params (decoupled from any API client).
export interface Svi {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x));
  return x >= 0 ? y : -y;
}
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

export function totalVar(svi: Svi, k: number): number {
  const d = k - svi.m;
  return svi.a + svi.b * (svi.rho * d + Math.sqrt(d * d + svi.sigma * svi.sigma));
}

// Annualized implied vol at strike, given total variance and time-to-expiry (yrs).
export function impliedVol(svi: Svi, forward: number, strike: number, tYears: number): number {
  const k = Math.log(strike / forward);
  return Math.sqrt(Math.max(0, totalVar(svi, k)) / Math.max(tYears, 1e-9));
}

// YES = P(settle ≥ strike), NO = 1 − YES. Both in [0,1] (= price per $1 payout).
export function yesNo(svi: Svi, forward: number, strike: number): { yes: number; no: number } {
  const k = Math.log(strike / forward);
  const w = Math.max(1e-9, totalVar(svi, k));
  const d2 = (-k - 0.5 * w) / Math.sqrt(w);
  const yes = Math.max(0, Math.min(1, normCdf(d2)));
  return { yes, no: 1 - yes };
}
