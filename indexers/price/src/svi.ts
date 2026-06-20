// SVI surface → binary (yes/no) price in cents.
//
// w(k) = a + b·( rho·(k−m) + sqrt((k−m)² + sigma²) )   (total variance, σ²·T)
// YES (settles ≥ strike) = N(d2), d2 = (ln(F/K) − w/2) / √w.  NO = 1 − YES.
// Undiscounted digital, matching Predict's settlement.

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

// YES probability in [0,1] that spot settles ≥ strike.
export function yesProb(svi: Svi, forward: number, strike: number): number {
  const k = Math.log(strike / forward);
  const w = Math.max(1e-9, totalVar(svi, k));
  const d2 = (-k - 0.5 * w) / Math.sqrt(w);
  return Math.max(0, Math.min(1, normCdf(d2)));
}

// YES/NO in cents (0–99.x), the tradeable binary price.
export function yesNoCents(svi: Svi, forward: number, strike: number): { yes: number; no: number } {
  const yes = yesProb(svi, forward, strike) * 100;
  return { yes, no: 100 - yes };
}
