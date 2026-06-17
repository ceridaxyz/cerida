use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct SuiRpcClient {
    rpc_url: String,
    http: reqwest::Client,
}

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

impl SuiRpcClient {
    pub fn new(rpc_url: impl Into<String>) -> Self {
        Self {
            rpc_url: rpc_url.into(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn query_package_events(
        &self,
        package: &str,
        cursor: Option<Value>,
        limit: u64,
    ) -> Result<(Vec<SuiEvent>, Option<Value>, bool)> {
        let params = json!([
            { "Package": package },
            cursor,
            limit,
            false
        ]);
        let page: EventPage = self.rpc("suix_queryEvents", params).await?;
        Ok((page.data, page.next_cursor, page.has_next_page))
    }

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
            (_, Some(error)) => anyhow::bail!("Sui RPC {method} error: {error}"),
            _ => anyhow::bail!("Sui RPC {method} returned no result"),
        }
    }
}
