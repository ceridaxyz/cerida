use std::env;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub predict_base_url: String,
    pub sui_rpc_url: String,
    pub cerida_package_id: Option<String>,
    pub poll_ms: u64,
    pub api_host: String,
    pub api_port: u16,
    pub keeper_dry_run: bool,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/cerida".into()),
            redis_url: env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".into()),
            predict_base_url: env::var("PREDICT_BASE")
                .unwrap_or_else(|_| "https://predict-server.testnet.mystenlabs.com".into()),
            sui_rpc_url: env::var("SUI_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:9000".into()),
            cerida_package_id: env::var("CERIDA_PACKAGE_ID").ok().filter(|v| !v.is_empty()),
            poll_ms: env::var("POLL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3_000),
            api_host: env::var("API_HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            api_port: env::var("API_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8788),
            keeper_dry_run: env::var("KEEPER_DRY_RUN")
                .map(|v| v != "false" && v != "0")
                .unwrap_or(true),
        }
    }

    pub fn poll_interval(&self) -> Duration {
        Duration::from_millis(self.poll_ms)
    }
}
