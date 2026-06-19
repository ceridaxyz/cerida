use std::env;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    // ── infrastructure ──────────────────────────────────────────────────────
    pub database_url: String,
    pub redis_url: String,
    pub predict_base_url: String,
    pub sui_rpc_url: String,
    pub poll_ms: u64,
    // ── api ─────────────────────────────────────────────────────────────────
    pub api_host: String,
    pub api_port: u16,
    // ── indexer ─────────────────────────────────────────────────────────────
    pub cerida_package_id: Option<String>,
    // ── keeper execution ────────────────────────────────────────────────────
    /// Set false to actually sign and submit transactions.
    pub keeper_dry_run: bool,
    /// Bech32 Sui private key (`suiprivkey1...`). Required when dry_run=false.
    pub keeper_private_key: Option<String>,
    /// Gas budget in MIST (default 50_000_000 = 0.05 SUI).
    pub gas_budget: u64,
    // ── deployed object IDs ─────────────────────────────────────────────────
    /// The shared `CeridaVault` object ID.
    pub vault_id: Option<String>,
    /// The shared `Predict` singleton object ID (from DeepBook).
    pub predict_object_id: Option<String>,
    /// The shared `MarginPool` object ID for the leverage product.
    pub margin_pool_id: Option<String>,
    /// The shared `LeverageBook` object ID.
    pub leverage_book_id: Option<String>,
    /// The shared `WindowBook` object ID.
    pub window_book_id: Option<String>,
    /// Move type string for the vault's Quote coin, e.g. `0x2::sui::SUI`.
    pub quote_coin_type: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/cerida".into()),
            redis_url: env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".into()),
            predict_base_url: env::var("PREDICT_BASE")
                .unwrap_or_else(|_| "https://predict-server.testnet.mystenlabs.com".into()),
            sui_rpc_url: env::var("SUI_RPC_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:9000".into()),
            poll_ms: env::var("POLL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3_000),
            api_host: env::var("API_HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            api_port: env::var("API_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8788),
            cerida_package_id: env::var("CERIDA_PACKAGE_ID").ok().filter(|v| !v.is_empty()),
            keeper_dry_run: env::var("KEEPER_DRY_RUN")
                .map(|v| v != "false" && v != "0")
                .unwrap_or(true),
            keeper_private_key: env::var("KEEPER_PRIVATE_KEY").ok().filter(|v| !v.is_empty()),
            gas_budget: env::var("GAS_BUDGET")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(50_000_000),
            vault_id: env::var("VAULT_ID").ok().filter(|v| !v.is_empty()),
            predict_object_id: env::var("PREDICT_OBJECT_ID").ok().filter(|v| !v.is_empty()),
            margin_pool_id: env::var("MARGIN_POOL_ID").ok().filter(|v| !v.is_empty()),
            leverage_book_id: env::var("LEVERAGE_BOOK_ID").ok().filter(|v| !v.is_empty()),
            window_book_id: env::var("WINDOW_BOOK_ID").ok().filter(|v| !v.is_empty()),
            quote_coin_type: env::var("QUOTE_COIN_TYPE")
                .unwrap_or_else(|_| "0x2::sui::SUI".into()),
        }
    }

    pub fn poll_interval(&self) -> Duration {
        Duration::from_millis(self.poll_ms)
    }
}
