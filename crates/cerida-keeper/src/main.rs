use anyhow::Result;
use cerida_core::config::Config;
use cerida_core::db;
use cerida_core::jobs::JobLane;
use redis::AsyncCommands;
use sqlx::PgPool;
use tokio::time::{self, Duration};
use tracing::{info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "cerida_keeper=info".into()))
        .init();

    let cfg = Config::from_env();
    let pool = db::connect(&cfg.database_url).await?;
    db::migrate(&pool).await?;
    let redis = redis::Client::open(cfg.redis_url.clone())?;

    info!(dry_run = cfg.keeper_dry_run, "keeper started");

    tokio::try_join!(
        run_lane(
            pool.clone(),
            redis.clone(),
            cfg.clone(),
            JobLane::IntentExecutor
        ),
        run_lane(
            pool.clone(),
            redis.clone(),
            cfg.clone(),
            JobLane::WindowLifecycle
        ),
        run_lane(
            pool.clone(),
            redis.clone(),
            cfg.clone(),
            JobLane::RiskExecutor
        ),
    )?;
    Ok(())
}

async fn run_lane(pool: PgPool, redis: redis::Client, cfg: Config, lane: JobLane) -> Result<()> {
    let lane_name = lane.as_str();
    let mut ticker = time::interval(Duration::from_millis(750));
    loop {
        ticker.tick().await;
        match db::claim_job(&pool, lane_name).await {
            Ok(Some(job)) => {
                let result = execute_job(&cfg, &job).await;
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

async fn execute_job(cfg: &Config, job: &cerida_core::jobs::KeeperJob) -> Result<Option<String>> {
    if cfg.keeper_dry_run {
        info!(job_id = job.id, lane = %job.lane, job_type = %job.job_type, "dry-run keeper accepted job");
        return Ok(Some(format!("dry-run:{}", job.id)));
    }

    anyhow::bail!(
        "signed Sui execution is not enabled yet for lane={} job_type={}; set KEEPER_DRY_RUN=true for local indexing/API tests",
        job.lane,
        job.job_type
    )
}

async fn publish(redis: &redis::Client, payload: serde_json::Value) -> Result<()> {
    let mut conn = redis.get_multiplexed_async_connection().await?;
    let body = serde_json::to_string(&payload)?;
    let _: () = conn.publish("keeper", body).await?;
    Ok(())
}
