use anyhow::Result;
use cerida_core::config::Config;
use cerida_core::db;
use cerida_core::jobs::JobLane;
use cerida_core::keeper_tx::{self, KeeperContext};
use cerida_core::sui::SuiRpcClient;
use redis::AsyncCommands;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::time::{self, Duration};
use tracing::{info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "cerida_keeper=info,cerida_core=info".into()),
        )
        .init();

    let cfg = Config::from_env();
    let pool = db::connect(&cfg.database_url).await?;
    db::migrate(&pool).await?;
    let redis = redis::Client::open(cfg.redis_url.clone())?;

    let sui = SuiRpcClient::new(cfg.sui_rpc_url.clone());
    let ctx = Arc::new(KeeperContext::new(sui, cfg.clone(), pool.clone()));

    info!(
        dry_run = cfg.keeper_dry_run,
        vault_id = ?cfg.vault_id,
        "keeper started"
    );

    // Parse default strikes from WINDOW_DEFAULT_STRIKES env (JSON array of u64).
    let default_strikes: Option<Vec<u64>> = cfg
        .window_default_strikes
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<u64>>(s).ok());
    db::ensure_window_epoch_scheduled(&pool, default_strikes.as_deref()).await?;

    tokio::try_join!(
        run_lane(pool.clone(), redis.clone(), ctx.clone(), JobLane::IntentExecutor),
        run_lane(pool.clone(), redis.clone(), ctx.clone(), JobLane::WindowLifecycle),
        run_lane(pool.clone(), redis.clone(), ctx.clone(), JobLane::RiskExecutor),
    )?;
    Ok(())
}

async fn run_lane(
    pool: PgPool,
    redis: redis::Client,
    ctx: Arc<KeeperContext>,
    lane: JobLane,
) -> Result<()> {
    let lane_name = lane.as_str();
    let mut ticker = time::interval(Duration::from_millis(750));
    loop {
        ticker.tick().await;
        match db::claim_job(&pool, lane_name).await {
            Ok(Some(job)) => {
                let result = keeper_tx::execute_job(&ctx, &job.job_type, &job.payload).await;
                match result {
                    Ok(digest) => {
                        db::complete_job(&pool, job.id, digest.as_deref()).await?;
                        publish(
                            &redis,
                            serde_json::json!({
                                "type": "keeper_job_confirmed",
                                "id": job.id,
                                "lane": job.lane,
                                "job_type": job.job_type,
                                "tx_digest": digest,
                            }),
                        )
                        .await?;
                    }
                    Err(err) => {
                        let retry = job.attempts < 8;
                        let message = err.to_string();
                        db::fail_job(&pool, job.id, &message, retry).await?;
                        warn!(job_id = job.id, retry, error = %message, "job failed");
                        publish(
                            &redis,
                            serde_json::json!({
                                "type": "keeper_job_failed",
                                "id": job.id,
                                "lane": job.lane,
                                "job_type": job.job_type,
                                "retry": retry,
                                "error": message,
                            }),
                        )
                        .await?;
                    }
                }
            }
            Ok(None) => {}
            Err(err) => warn!(lane = lane_name, ?err, "claim failed"),
        }
    }
}

async fn publish(redis: &redis::Client, payload: serde_json::Value) -> Result<()> {
    let mut conn = redis.get_multiplexed_async_connection().await?;
    let body = serde_json::to_string(&payload)?;
    let _: () = conn.publish("keeper", body).await?;
    Ok(())
}
