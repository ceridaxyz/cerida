use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobLane {
    IntentExecutor,
    WindowLifecycle,
    RiskExecutor,
}

impl JobLane {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::IntentExecutor => "intent_executor",
            Self::WindowLifecycle => "window_lifecycle",
            Self::RiskExecutor => "risk_executor",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KeeperJob {
    pub id: i64,
    pub lane: String,
    pub job_type: String,
    pub status: String,
    pub priority: i32,
    pub attempts: i32,
    pub payload: Value,
}
