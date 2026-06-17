use serde::{Deserialize, Serialize};

const DAYS_PER_YEAR: f64 = 365.0;
const MS_PER_DAY: f64 = 86_400_000.0;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Svi {
    pub a: f64,
    pub b: f64,
    pub rho: f64,
    pub m: f64,
    pub sigma: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DerivedPrice {
    pub strike: f64,
    pub yes_cents: f64,
    pub no_cents: f64,
    pub iv: f64,
    pub tenor_days: f64,
}

pub fn surface_points(
    svi: Svi,
    forward: f64,
    expiry_ms: i64,
    now_ms: i64,
    min_strike: f64,
    tick_size: f64,
) -> Vec<DerivedPrice> {
    if forward <= 0.0 || tick_size <= 0.0 {
        return Vec::new();
    }

    let tenor_days = ((expiry_ms - now_ms).max(1) as f64) / MS_PER_DAY;
    let center = (forward / tick_size).round() * tick_size;
    let start = (center - tick_size * 10.0).max(min_strike);

    (0..=20)
        .map(|i| start + tick_size * i as f64)
        .filter(|strike| *strike > 0.0)
        .map(|strike| {
            let yes = digital_yes_probability(svi, forward, strike);
            let no = (1.0 - yes).clamp(0.0, 1.0);
            let total_var = svi_total_variance(svi, forward, strike).max(1e-9);
            let years = (tenor_days / DAYS_PER_YEAR).max(1.0 / DAYS_PER_YEAR);
            DerivedPrice {
                strike,
                yes_cents: yes * 100.0,
                no_cents: no * 100.0,
                iv: (total_var / years).sqrt(),
                tenor_days,
            }
        })
        .collect()
}

pub fn digital_yes_probability(svi: Svi, forward: f64, strike: f64) -> f64 {
    let w = svi_total_variance(svi, forward, strike).max(1e-9);
    let d2 = ((forward / strike).ln() - 0.5 * w) / w.sqrt();
    normal_cdf(d2).clamp(0.0, 1.0)
}

fn svi_total_variance(svi: Svi, forward: f64, strike: f64) -> f64 {
    let k = (strike / forward).ln();
    let x = k - svi.m;
    svi.a + svi.b * (svi.rho * x + (x * x + svi.sigma * svi.sigma).sqrt())
}

fn normal_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / 2.0_f64.sqrt()))
}

fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0
        - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
            + 0.254829592)
            * t
            * (-x * x).exp();
    sign * y
}
