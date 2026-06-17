use anyhow::Result;
use cerida_core::config::Config;
use cerida_core::db;
use cerida_core::predict::PredictClient;
use cerida_core::pricing::surface_points;
use cerida_core::sui::SuiRpcClient;
use redis::AsyncCommands;
use serde_json::json;
use sqlx::PgPool;
use tokio::time;
use tracing::{info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "cerida_indexer=info,cerida_core=info".into()),
        )
        .init();

    let cfg = Config::from_env();
    let pool = db::connect(&cfg.database_url).await?;
    db::migrate(&pool).await?;

    let predict = PredictClient::new(cfg.predict_base_url.clone());
    let sui = SuiRpcClient::new(cfg.sui_rpc_url.clone());
    let redis = redis::Client::open(cfg.redis_url.clone())?;

    info!("indexer started");
    let mut ticker = time::interval(cfg.poll_interval());

    loop {
        ticker.tick().await;
        if let Err(err) = poll_predict(&pool, &redis, &predict).await {
            warn!(?err, "predict poll failed");
        }
        if let Some(package) = &cfg.cerida_package_id {
            if let Err(err) = poll_sui_events(&pool, &redis, &sui, package).await {
                warn!(?err, "sui event poll failed");
            }
        }
    }
}

async fn poll_predict(pool: &PgPool, redis: &redis::Client, predict: &PredictClient) -> Result<()> {
    let markets = predict.markets().await?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    for market in markets {
        db::upsert_oracle(pool, &market).await?;
        match predict.snapshot(&market.oracle_id).await {
            Ok(snapshot) => {
                db::insert_snapshot(pool, &snapshot).await?;
                let prices = surface_points(
                    snapshot.svi,
                    snapshot.forward,
                    market.expiry_ms,
                    now_ms,
                    market.min_strike,
                    market.tick_size,
                );
                db::insert_derived_prices(pool, &market.oracle_id, snapshot.timestamp_ms, &prices)
                    .await?;
                publish(
                    redis,
                    "markets",
                    json!({
                        "type": "market_snapshot",
                        "oracle_id": market.oracle_id,
                        "asset": market.asset,
                        "expiry": market.expiry_ms,
                        "spot": snapshot.spot,
                        "forward": snapshot.forward,
                        "ts": snapshot.timestamp_ms,
                    }),
                )
                .await?;
                publish(
                    redis,
                    &format!("surface:{}", market.oracle_id),
                    json!({
                        "type": "surface",
                        "oracle_id": market.oracle_id,
                        "ts": snapshot.timestamp_ms,
                        "points": prices,
                    }),
                )
                .await?;
            }
            Err(err) => warn!(oracle_id = %market.oracle_id, ?err, "snapshot skipped"),
        }
    }
    Ok(())
}

async fn poll_sui_events(
    pool: &PgPool,
    redis: &redis::Client,
    sui: &SuiRpcClient,
    package: &str,
) -> Result<()> {
    let cursor_name = format!("sui_events:{package}");
    let mut cursor = db::get_cursor(pool, &cursor_name).await?;

    for _ in 0..5 {
        let (events, next_cursor, has_next_page) = sui
            .query_package_events(package, cursor.clone(), 50)
            .await?;
        if events.is_empty() {
            break;
        }

        for event in events {
            let ts = event
                .timestamp_ms
                .as_ref()
                .and_then(|s| s.parse::<i64>().ok());
            let inserted = db::insert_event(
                pool,
                event.id.clone(),
                &event.event_type,
                event.sender.as_deref(),
                event.parsed_json.clone(),
                ts,
            )
            .await?;
            if inserted {
                db::upsert_event_side_effects(pool, &event.event_type, &event.parsed_json).await?;
                publish(
                    redis,
                    "flow",
                    json!({
                        "type": "cerida_event",
                        "event_type": event.event_type,
                        "payload": event.parsed_json,
                        "ts": ts,
                    }),
                )
                .await?;
            }
        }

        cursor = next_cursor;
        db::set_cursor(pool, &cursor_name, cursor.clone()).await?;
        if !has_next_page {
            break;
        }
    }

    Ok(())
}

async fn publish(redis: &redis::Client, channel: &str, payload: serde_json::Value) -> Result<()> {
    let mut conn = redis.get_multiplexed_async_connection().await?;
    let body = serde_json::to_string(&payload)?;
    let _: () = conn.publish(channel, body).await?;
    Ok(())
}
