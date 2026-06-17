use crate::pricing::Svi;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const SCALE: f64 = 1_000_000_000.0;

#[derive(Clone)]
pub struct PredictClient {
    base_url: String,
    http: reqwest::Client,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PredictOracle {
    pub oracle_id: String,
    pub underlying_asset: String,
    pub status: String,
    pub expiry: i64,
    pub tick_size: i64,
    pub min_strike: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Market {
    pub oracle_id: String,
    pub asset: String,
    pub status: String,
    pub expiry_ms: i64,
    pub tick_size: f64,
    pub min_strike: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PredictSnapshot {
    pub oracle_id: String,
    pub spot: f64,
    pub forward: f64,
    pub svi: Svi,
    pub timestamp_ms: i64,
}

#[derive(Debug, Deserialize)]
struct PriceResponse {
    spot: i64,
    forward: i64,
}

#[derive(Debug, Deserialize)]
struct SviResponse {
    a: i64,
    b: i64,
    rho: i64,
    rho_negative: bool,
    m: i64,
    m_negative: bool,
    sigma: i64,
    onchain_timestamp: i64,
}

impl PredictClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn markets(&self) -> Result<Vec<Market>> {
        let oracles: Vec<PredictOracle> = self.get("/oracles").await?;
        let now = chrono::Utc::now().timestamp_millis();
        Ok(oracles
            .into_iter()
            .filter(|o| o.status == "active" && o.expiry > now)
            .map(|o| Market {
                oracle_id: o.oracle_id,
                asset: o.underlying_asset,
                status: o.status,
                expiry_ms: o.expiry,
                tick_size: o.tick_size as f64 / SCALE,
                min_strike: o.min_strike as f64 / SCALE,
            })
            .collect())
    }

    pub async fn snapshot(&self, oracle_id: &str) -> Result<PredictSnapshot> {
        let prices: PriceResponse = self
            .get(&format!("/oracles/{oracle_id}/prices/latest"))
            .await
            .with_context(|| format!("fetch latest prices for {oracle_id}"))?;
        let svi: SviResponse = self
            .get(&format!("/oracles/{oracle_id}/svi/latest"))
            .await
            .with_context(|| format!("fetch latest SVI for {oracle_id}"))?;

        Ok(PredictSnapshot {
            oracle_id: oracle_id.to_string(),
            spot: prices.spot as f64 / SCALE,
            forward: prices.forward as f64 / SCALE,
            svi: Svi {
                a: svi.a as f64 / SCALE,
                b: svi.b as f64 / SCALE,
                rho: signed(svi.rho, svi.rho_negative),
                m: signed(svi.m, svi.m_negative),
                sigma: svi.sigma as f64 / SCALE,
            },
            timestamp_ms: svi.onchain_timestamp,
        })
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let res = self
            .http
            .get(format!("{}{}", self.base_url, path))
            .header("accept", "application/json")
            .send()
            .await?
            .error_for_status()?;
        Ok(res.json().await?)
    }
}

fn signed(value: i64, negative: bool) -> f64 {
    let v = value as f64 / SCALE;
    if negative {
        -v
    } else {
        v
    }
}
