use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct SuiRpcClient {
    rpc_url: String,
    http: reqwest::Client,
}

// ── Event types (used by indexer) ────────────────────────────────────────────

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SuiEvent {
    pub id: Value,
    #[serde(default)]
    pub package_id: Option<String>,
    #[serde(default)]
    pub transaction_module: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub parsed_json: Value,
    #[serde(default)]
    pub timestamp_ms: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RpcEnvelope<T> {
    result: Option<T>,
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct EventPage {
    data: Vec<SuiEvent>,
    #[serde(rename = "nextCursor")]
    next_cursor: Option<Value>,
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
}

// ── Coin types ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CoinObject {
    #[serde(rename = "coinObjectId")]
    pub coin_object_id: String,
    pub version: String,
    pub digest: String,
    pub balance: String,
}

#[derive(Debug, Deserialize)]
struct CoinPage {
    data: Vec<CoinObject>,
}

// ── Object types ─────────────────────────────────────────────────────────────

/// Shared-object metadata returned by `sui_getObject`.
#[derive(Debug, Deserialize)]
pub struct SharedObjectInfo {
    pub id: String,
    pub version: u64,
    pub initial_shared_version: u64,
}

// ── Dry-run / execution ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DryRunResult {
    pub effects: Value,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExecuteResult {
    pub digest: String,
    #[serde(default)]
    pub errors: Vec<String>,
}

// ── Client impl ──────────────────────────────────────────────────────────────

impl SuiRpcClient {
    pub fn new(rpc_url: impl Into<String>) -> Self {
        Self { rpc_url: rpc_url.into(), http: reqwest::Client::new() }
    }

    // ── Indexer methods ──────────────────────────────────────────────────────

    pub async fn query_package_events(
        &self,
        package: &str,
        cursor: Option<Value>,
        limit: u64,
    ) -> Result<(Vec<SuiEvent>, Option<Value>, bool)> {
        let params = json!([{ "Package": package }, cursor, limit, false]);
        let page: EventPage = self.rpc("suix_queryEvents", params).await?;
        Ok((page.data, page.next_cursor, page.has_next_page))
    }

    // ── Keeper methods ───────────────────────────────────────────────────────

    /// Current reference gas price in MIST.
    pub async fn get_reference_gas_price(&self) -> Result<u64> {
        let raw: Value = self.rpc("suix_getReferenceGasPrice", json!([])).await?;
        let price = raw
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| raw.as_u64())
            .context("parse reference gas price")?;
        Ok(price)
    }

    /// Fetch coin objects owned by `address` matching `coin_type`.
    pub async fn get_coins(&self, address: &str, coin_type: &str) -> Result<Vec<CoinObject>> {
        let page: CoinPage = self
            .rpc("suix_getCoins", json!([address, coin_type, null, 10]))
            .await?;
        Ok(page.data)
    }

    /// Return `(version, initial_shared_version)` for a shared object.
    /// Uses `sui_getObject` with `showOwner` option.
    pub async fn get_shared_object_info(&self, object_id: &str) -> Result<SharedObjectInfo> {
        let params = json!([object_id, { "showOwner": true }]);
        let resp: Value = self.rpc("sui_getObject", params).await?;

        let obj = resp.get("data").context("no data in getObject")?;
        let id = obj
            .pointer("/objectId")
            .and_then(Value::as_str)
            .unwrap_or(object_id)
            .to_string();
        let version: u64 = obj
            .pointer("/version")
            .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()))
            .context("no version")?;

        // initial_shared_version lives inside the owner field
        let initial_shared_version: u64 = obj
            .pointer("/owner/Shared/initial_shared_version")
            .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()))
            .unwrap_or(version);

        Ok(SharedObjectInfo { id, version, initial_shared_version })
    }

    /// Dry-run a base64-encoded BCS transaction.
    pub async fn dry_run_transaction(&self, tx_bytes_b64: &str) -> Result<DryRunResult> {
        let result: DryRunResult = self
            .rpc("sui_dryRunTransactionBlock", json!([tx_bytes_b64]))
            .await?;
        if let Some(err) = &result.error {
            bail!("dry-run error: {err}");
        }
        Ok(result)
    }

    /// Execute a signed transaction. Returns the tx digest.
    pub async fn execute_transaction(
        &self,
        tx_bytes_b64: &str,
        signature_b64: &str,
    ) -> Result<String> {
        let params = json!([
            tx_bytes_b64,
            [signature_b64],
            { "showEffects": true },
            "WaitForLocalExecution"
        ]);
        let result: ExecuteResult = self.rpc("sui_executeTransactionBlock", params).await?;
        if !result.errors.is_empty() {
            bail!("execute tx errors: {:?}", result.errors);
        }
        Ok(result.digest)
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    async fn rpc<T: for<'de> Deserialize<'de>>(&self, method: &str, params: Value) -> Result<T> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let envelope: RpcEnvelope<T> = self
            .http
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("call {method}"))?
            .error_for_status()?
            .json()
            .await?;
        match (envelope.result, envelope.error) {
            (Some(result), _) => Ok(result),
            (_, Some(error)) => bail!("Sui RPC {method} error: {error}"),
            _ => bail!("Sui RPC {method} returned no result"),
        }
    }
}

