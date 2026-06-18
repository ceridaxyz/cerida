use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use cerida_core::config::Config;
use cerida_core::db;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Column, PgPool, Row};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    bus: broadcast::Sender<Value>,
}

#[derive(Debug, Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct FlowQuery {
    oracle_id: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct IntentQuery {
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct PositionsQuery {
    owner: Option<String>,
    limit: Option<i64>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "cerida_api=info".into()))
        .init();

    let cfg = Config::from_env();
    let pool = db::connect(&cfg.database_url).await?;
    db::migrate(&pool).await?;

    let (bus, _) = broadcast::channel(1024);
    spawn_redis_bridge(cfg.redis_url.clone(), bus.clone());

    let state = AppState { pool, bus };
    let app = Router::new()
        .route("/health", get(health))
        .route("/markets", get(markets))
        .route("/markets/{oracle_id}/snapshot", get(snapshot))
        .route("/markets/{oracle_id}/history", get(history))
        .route("/markets/{oracle_id}/surface", get(surface))
        .route("/flow", get(flow))
        .route("/vaults/{vault_id}/intents", get(vault_intents))
        .route("/keeper/jobs", get(keeper_jobs))
        .route("/positions", get(positions))
        .route("/ws", get(ws))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", cfg.api_host, cfg.api_port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("api listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "cerida-api" }))
}

async fn markets(State(state): State<AppState>) -> Json<Value> {
    let rows = sqlx::query(
        "SELECT po.oracle_id, po.asset, po.status, (extract(epoch from po.expiry) * 1000)::DOUBLE PRECISION AS expiry,
                po.tick_size, po.min_strike, ms.spot, ms.forward,
                (extract(epoch from ms.ts) * 1000)::DOUBLE PRECISION AS ts
         FROM predict_oracles po
         LEFT JOIN LATERAL (
           SELECT * FROM market_snapshots ms
           WHERE ms.oracle_id = po.oracle_id
           ORDER BY ms.ts DESC LIMIT 1
         ) ms ON TRUE
         WHERE po.status = 'active' AND po.expiry > now()
         ORDER BY po.expiry ASC",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    Json(Value::Array(rows.into_iter().map(row_to_json).collect()))
}

async fn snapshot(
    State(state): State<AppState>,
    axum::extract::Path(oracle_id): axum::extract::Path<String>,
) -> Json<Value> {
    let row = sqlx::query(
        "SELECT oracle_id, (extract(epoch from ts) * 1000)::DOUBLE PRECISION AS ts, spot, forward, svi
         FROM market_snapshots WHERE oracle_id = $1 ORDER BY ts DESC LIMIT 1",
    )
    .bind(oracle_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    Json(row.map(row_to_json).unwrap_or(Value::Null))
}

async fn history(
    State(state): State<AppState>,
    axum::extract::Path(oracle_id): axum::extract::Path<String>,
    Query(query): Query<LimitQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(500).clamp(1, 2_000);
    let rows = sqlx::query(
        "SELECT oracle_id, (extract(epoch from ts) * 1000)::DOUBLE PRECISION AS ts, spot, forward, svi
         FROM market_snapshots WHERE oracle_id = $1 ORDER BY ts DESC LIMIT $2",
    )
    .bind(oracle_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    Json(Value::Array(
        rows.into_iter().rev().map(row_to_json).collect(),
    ))
}

async fn surface(
    State(state): State<AppState>,
    axum::extract::Path(oracle_id): axum::extract::Path<String>,
) -> Json<Value> {
    let rows = sqlx::query(
        "WITH latest AS (
           SELECT ts FROM derived_prices WHERE oracle_id = $1 ORDER BY ts DESC LIMIT 1
         )
         SELECT oracle_id, (extract(epoch from ts) * 1000)::DOUBLE PRECISION AS ts, strike, yes_cents, no_cents, iv, tenor_days
         FROM derived_prices WHERE oracle_id = $1 AND ts = (SELECT ts FROM latest)
         ORDER BY strike ASC",
    )
    .bind(oracle_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    Json(Value::Array(rows.into_iter().map(row_to_json).collect()))
}

async fn flow(State(state): State<AppState>, Query(query): Query<FlowQuery>) -> Json<Value> {
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows = if let Some(oracle_id) = query.oracle_id {
        sqlx::query(
            "SELECT event_type, payload, (extract(epoch from inserted_at) * 1000)::DOUBLE PRECISION AS ts
             FROM cerida_events
             WHERE payload->>'oracle_id' = $1
             ORDER BY inserted_at DESC LIMIT $2",
        )
        .bind(oracle_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query(
            "SELECT event_type, payload, (extract(epoch from inserted_at) * 1000)::DOUBLE PRECISION AS ts
             FROM cerida_events ORDER BY inserted_at DESC LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    };
    Json(Value::Array(rows.into_iter().map(row_to_json).collect()))
}

async fn vault_intents(
    State(state): State<AppState>,
    axum::extract::Path(vault_id): axum::extract::Path<String>,
    Query(query): Query<IntentQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query(
        "SELECT vault_id, intent_id, kind, user_address, oracle_id,
                (extract(epoch from expiry) * 1000)::DOUBLE PRECISION AS expiry, is_range, qty, escrowed, status, payload
         FROM intents WHERE vault_id = $1 ORDER BY updated_at DESC LIMIT $2",
    )
    .bind(vault_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    Json(Value::Array(rows.into_iter().map(row_to_json).collect()))
}

async fn keeper_jobs(
    State(state): State<AppState>,
    Query(query): Query<LimitQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query(
        "SELECT id, lane, job_type, status, priority, attempts, payload, error, tx_digest,
                (extract(epoch from available_at) * 1000)::DOUBLE PRECISION AS available_at,
                (extract(epoch from updated_at) * 1000)::DOUBLE PRECISION AS updated_at
         FROM keeper_jobs ORDER BY updated_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    Json(Value::Array(rows.into_iter().map(row_to_json).collect()))
}

async fn positions(
    State(state): State<AppState>,
    Query(query): Query<PositionsQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows = if let Some(owner) = query.owner {
        sqlx::query(
            "SELECT * FROM leverage_positions WHERE owner = $1 ORDER BY updated_at DESC LIMIT $2",
        )
        .bind(owner)
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query("SELECT * FROM leverage_positions ORDER BY updated_at DESC LIMIT $1")
            .bind(limit)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default()
    };
    Json(Value::Array(rows.into_iter().map(row_to_json).collect()))
}

async fn ws(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_session(socket, Arc::new(state)))
}

async fn ws_session(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.bus.subscribe();

    if sender
        .send(Message::Text(json!({ "type": "ready" }).to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            inbound = receiver.next() => {
                match inbound {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(value) => {
                        if sender.send(Message::Text(value.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

fn spawn_redis_bridge(redis_url: String, bus: broadcast::Sender<Value>) {
    tokio::spawn(async move {
        loop {
            if let Err(err) = redis_bridge_once(&redis_url, &bus).await {
                warn!(?err, "redis bridge disconnected");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    });
}

async fn redis_bridge_once(redis_url: &str, bus: &broadcast::Sender<Value>) -> anyhow::Result<()> {
    let client = redis::Client::open(redis_url)?;
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe("markets").await?;
    pubsub.subscribe("flow").await?;
    pubsub.subscribe("keeper").await?;
    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        let payload: String = msg.get_payload()?;
        if let Ok(value) = serde_json::from_str::<Value>(&payload) {
            let _ = bus.send(value);
        }
    }
    Ok(())
}

fn row_to_json(row: sqlx::postgres::PgRow) -> Value {
    let mut out = serde_json::Map::new();
    for column in row.columns() {
        let name = column.name();
        let value = if let Ok(v) = row.try_get::<String, _>(name) {
            json!(v)
        } else if let Ok(v) = row.try_get::<i64, _>(name) {
            json!(v)
        } else if let Ok(v) = row.try_get::<i32, _>(name) {
            json!(v)
        } else if let Ok(v) = row.try_get::<f64, _>(name) {
            json!(v)
        } else if let Ok(v) = row.try_get::<bool, _>(name) {
            json!(v)
        } else if let Ok(v) = row.try_get::<Value, _>(name) {
            v
        } else {
            Value::Null
        };
        out.insert(name.to_string(), value);
    }
    Value::Object(out)
}
