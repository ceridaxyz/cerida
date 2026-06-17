use crate::jobs::KeeperJob;
use crate::predict::{Market, PredictSnapshot};
use crate::pricing::DerivedPrice;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

pub async fn connect(database_url: &str) -> Result<PgPool> {
    Ok(PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await?)
}

pub async fn migrate(pool: &PgPool) -> Result<()> {
    let statements = [
        "CREATE EXTENSION IF NOT EXISTS pgcrypto",
        "CREATE TABLE IF NOT EXISTS indexer_cursors (
            name TEXT PRIMARY KEY,
            cursor JSONB,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )",
        "CREATE TABLE IF NOT EXISTS predict_oracles (
            oracle_id TEXT PRIMARY KEY,
            asset TEXT NOT NULL,
            status TEXT NOT NULL,
            expiry TIMESTAMPTZ NOT NULL,
            tick_size DOUBLE PRECISION NOT NULL,
            min_strike DOUBLE PRECISION NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )",
        "CREATE TABLE IF NOT EXISTS market_snapshots (
            oracle_id TEXT NOT NULL,
            ts TIMESTAMPTZ NOT NULL,
            spot DOUBLE PRECISION NOT NULL,
            forward DOUBLE PRECISION NOT NULL,
            svi JSONB NOT NULL,
            PRIMARY KEY (oracle_id, ts)
        )",
        "CREATE TABLE IF NOT EXISTS derived_prices (
            oracle_id TEXT NOT NULL,
            ts TIMESTAMPTZ NOT NULL,
            strike DOUBLE PRECISION NOT NULL,
            yes_cents DOUBLE PRECISION NOT NULL,
            no_cents DOUBLE PRECISION NOT NULL,
            iv DOUBLE PRECISION NOT NULL,
            tenor_days DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (oracle_id, ts, strike)
        )",
        "CREATE TABLE IF NOT EXISTS cerida_events (
            id BIGSERIAL PRIMARY KEY,
            event_id JSONB NOT NULL,
            tx_digest TEXT,
            event_type TEXT NOT NULL,
            sender TEXT,
            payload JSONB NOT NULL,
            event_ts TIMESTAMPTZ,
            inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (event_id)
        )",
        "CREATE TABLE IF NOT EXISTS vaults (
            vault_id TEXT PRIMARY KEY,
            manager_id TEXT NOT NULL,
            keeper TEXT NOT NULL,
            quote_type TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )",
        "CREATE TABLE IF NOT EXISTS intents (
            vault_id TEXT NOT NULL,
            intent_id BIGINT NOT NULL,
            kind TEXT NOT NULL,
            user_address TEXT NOT NULL,
            oracle_id TEXT,
            expiry TIMESTAMPTZ,
            is_range BOOLEAN,
            qty NUMERIC,
            escrowed NUMERIC,
            status TEXT NOT NULL,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (vault_id, intent_id, kind)
        )",
        "CREATE TABLE IF NOT EXISTS window_epochs (
            book_id TEXT NOT NULL,
            epoch_id BIGINT NOT NULL,
            oracle_id TEXT,
            expiry TIMESTAMPTZ,
            strikes JSONB,
            status TEXT NOT NULL,
            winning_band BIGINT,
            settlement_price NUMERIC,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (book_id, epoch_id)
        )",
        "CREATE TABLE IF NOT EXISTS window_bets (
            vault_id TEXT NOT NULL DEFAULT '',
            book_id TEXT NOT NULL DEFAULT '',
            epoch_id BIGINT NOT NULL,
            band_idx BIGINT NOT NULL,
            qty NUMERIC NOT NULL DEFAULT 0,
            basis NUMERIC NOT NULL DEFAULT 0,
            payload JSONB,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (epoch_id, band_idx, vault_id, book_id)
        )",
        "CREATE TABLE IF NOT EXISTS leverage_positions (
            book_id TEXT,
            position_id BIGINT PRIMARY KEY,
            owner TEXT NOT NULL,
            oracle_id TEXT,
            expiry TIMESTAMPTZ,
            qty NUMERIC,
            margin NUMERIC,
            basis NUMERIC,
            reserved NUMERIC,
            tp_value NUMERIC,
            sl_value NUMERIC,
            status TEXT NOT NULL,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )",
        "CREATE TABLE IF NOT EXISTS limit_orders (
            limit_book_id TEXT NOT NULL,
            order_id BIGINT NOT NULL,
            owner TEXT NOT NULL,
            status TEXT NOT NULL,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (limit_book_id, order_id)
        )",
        "CREATE TABLE IF NOT EXISTS keeper_jobs (
            id BIGSERIAL PRIMARY KEY,
            lane TEXT NOT NULL,
            job_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            priority INTEGER NOT NULL DEFAULT 100,
            attempts INTEGER NOT NULL DEFAULT 0,
            payload JSONB NOT NULL,
            error TEXT,
            tx_digest TEXT,
            available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )",
        "CREATE INDEX IF NOT EXISTS idx_market_snapshots_oracle_ts ON market_snapshots (oracle_id, ts DESC)",
        "CREATE INDEX IF NOT EXISTS idx_derived_prices_oracle_ts ON derived_prices (oracle_id, ts DESC)",
        "CREATE INDEX IF NOT EXISTS idx_keeper_jobs_status_lane ON keeper_jobs (status, lane, available_at, priority)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_keeper_jobs_dedupe
            ON keeper_jobs (lane, job_type, md5(payload::text))
            WHERE status IN ('pending', 'simulating', 'submitted')",
    ];

    for statement in statements {
        sqlx::query(statement).execute(pool).await?;
    }

    let hypertables = [
        "SELECT create_hypertable('market_snapshots', 'ts', if_not_exists => TRUE)",
        "SELECT create_hypertable('derived_prices', 'ts', if_not_exists => TRUE)",
    ];
    for statement in hypertables {
        if let Err(err) = sqlx::query(statement).execute(pool).await {
            tracing::debug!(?err, "Timescale hypertable setup skipped");
        }
    }

    Ok(())
}

pub async fn upsert_oracle(pool: &PgPool, market: &Market) -> Result<()> {
    sqlx::query(
        "INSERT INTO predict_oracles (oracle_id, asset, status, expiry, tick_size, min_strike, updated_at)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, now())
         ON CONFLICT (oracle_id) DO UPDATE SET
           asset = EXCLUDED.asset,
           status = EXCLUDED.status,
           expiry = EXCLUDED.expiry,
           tick_size = EXCLUDED.tick_size,
           min_strike = EXCLUDED.min_strike,
           updated_at = now()",
    )
    .bind(&market.oracle_id)
    .bind(&market.asset)
    .bind(&market.status)
    .bind(market.expiry_ms as f64)
    .bind(market.tick_size)
    .bind(market.min_strike)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn insert_snapshot(pool: &PgPool, snapshot: &PredictSnapshot) -> Result<()> {
    sqlx::query(
        "INSERT INTO market_snapshots (oracle_id, ts, spot, forward, svi)
         VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5)
         ON CONFLICT (oracle_id, ts) DO UPDATE SET
           spot = EXCLUDED.spot,
           forward = EXCLUDED.forward,
           svi = EXCLUDED.svi",
    )
    .bind(&snapshot.oracle_id)
    .bind(snapshot.timestamp_ms as f64)
    .bind(snapshot.spot)
    .bind(snapshot.forward)
    .bind(serde_json::to_value(snapshot.svi)?)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn insert_derived_prices(
    pool: &PgPool,
    oracle_id: &str,
    ts_ms: i64,
    prices: &[DerivedPrice],
) -> Result<()> {
    for price in prices {
        sqlx::query(
            "INSERT INTO derived_prices
             (oracle_id, ts, strike, yes_cents, no_cents, iv, tenor_days)
             VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7)
             ON CONFLICT (oracle_id, ts, strike) DO UPDATE SET
               yes_cents = EXCLUDED.yes_cents,
               no_cents = EXCLUDED.no_cents,
               iv = EXCLUDED.iv,
               tenor_days = EXCLUDED.tenor_days",
        )
        .bind(oracle_id)
        .bind(ts_ms as f64)
        .bind(price.strike)
        .bind(price.yes_cents)
        .bind(price.no_cents)
        .bind(price.iv)
        .bind(price.tenor_days)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn get_cursor(pool: &PgPool, name: &str) -> Result<Option<Value>> {
    let row = sqlx::query("SELECT cursor FROM indexer_cursors WHERE name = $1")
        .bind(name)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get("cursor")))
}

pub async fn set_cursor(pool: &PgPool, name: &str, cursor: Option<Value>) -> Result<()> {
    sqlx::query(
        "INSERT INTO indexer_cursors (name, cursor, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()",
    )
    .bind(name)
    .bind(cursor)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn insert_event(
    pool: &PgPool,
    event_id: Value,
    event_type: &str,
    sender: Option<&str>,
    payload: Value,
    event_ts_ms: Option<i64>,
) -> Result<bool> {
    let ts: Option<DateTime<Utc>> =
        event_ts_ms.and_then(|ms| DateTime::<Utc>::from_timestamp_millis(ms));
    let result = sqlx::query(
        "INSERT INTO cerida_events (event_id, event_type, sender, payload, event_ts)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_id) DO NOTHING",
    )
    .bind(event_id)
    .bind(event_type)
    .bind(sender)
    .bind(payload)
    .bind(ts)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn ensure_job(
    pool: &PgPool,
    lane: &str,
    job_type: &str,
    priority: i32,
    payload: Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO keeper_jobs (lane, job_type, priority, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING",
    )
    .bind(lane)
    .bind(job_type)
    .bind(priority)
    .bind(payload)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn claim_job(pool: &PgPool, lane: &str) -> Result<Option<KeeperJob>> {
    let row = sqlx::query(
        "UPDATE keeper_jobs SET
           status = 'simulating',
           attempts = attempts + 1,
           updated_at = now()
         WHERE id = (
           SELECT id FROM keeper_jobs
           WHERE lane = $1 AND status = 'pending' AND available_at <= now()
           ORDER BY priority ASC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING id, lane, job_type, status, priority, attempts, payload",
    )
    .bind(lane)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| KeeperJob {
        id: r.get("id"),
        lane: r.get("lane"),
        job_type: r.get("job_type"),
        status: r.get("status"),
        priority: r.get("priority"),
        attempts: r.get("attempts"),
        payload: r.get("payload"),
    }))
}

pub async fn complete_job(pool: &PgPool, id: i64, tx_digest: Option<&str>) -> Result<()> {
    sqlx::query(
        "UPDATE keeper_jobs SET status = 'confirmed', tx_digest = $2, error = NULL, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(tx_digest)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn fail_job(pool: &PgPool, id: i64, error: &str, retry: bool) -> Result<()> {
    let status = if retry { "pending" } else { "dead" };
    sqlx::query(
        "UPDATE keeper_jobs SET
           status = $2,
           error = $3,
           available_at = CASE WHEN $2 = 'pending'
             THEN now() + make_interval(secs => LEAST(300, attempts * attempts * 5))
             ELSE available_at
           END,
           updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn upsert_event_side_effects(
    pool: &PgPool,
    event_type: &str,
    payload: &Value,
) -> Result<()> {
    if event_type.ends_with("::vault::VaultCreated") {
        sqlx::query(
            "INSERT INTO vaults (vault_id, manager_id, keeper)
             VALUES ($1, $2, $3)
             ON CONFLICT (vault_id) DO UPDATE SET manager_id = EXCLUDED.manager_id, keeper = EXCLUDED.keeper",
        )
        .bind(json_string(payload, "vault_id"))
        .bind(json_string(payload, "manager_id"))
        .bind(json_string(payload, "keeper"))
        .execute(pool)
        .await?;
    } else if event_type.ends_with("Requested") {
        let (kind, lane) = if event_type.contains("LeverageOpen") {
            ("leverage_open", "intent_executor")
        } else if event_type.contains("WindowBet") {
            ("window_bet", "intent_executor")
        } else if event_type.contains("Redeem") {
            ("redeem", "intent_executor")
        } else {
            ("mint", "intent_executor")
        };
        let vault_id = json_string(payload, "vault_id");
        let id_key = if event_type.contains("Redeem") {
            "redeem_id"
        } else {
            "intent_id"
        };
        let intent_id = json_i64(payload, id_key);
        sqlx::query(
            "INSERT INTO intents
             (vault_id, intent_id, kind, user_address, oracle_id, expiry, is_range, qty, escrowed, status, payload)
             VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6::DOUBLE PRECISION IS NULL THEN NULL ELSE to_timestamp($6 / 1000.0) END,
               $7, $8, $9, 'requested', $10)
             ON CONFLICT (vault_id, intent_id, kind) DO UPDATE SET status = 'requested', payload = EXCLUDED.payload, updated_at = now()",
        )
        .bind(&vault_id)
        .bind(intent_id)
        .bind(kind)
        .bind(json_string(payload, "user"))
        .bind(json_string(payload, "oracle_id"))
        .bind(json_f64(payload, "expiry"))
        .bind(payload.get("is_range").and_then(Value::as_bool))
        .bind(json_f64(payload, "qty"))
        .bind(json_f64(payload, "escrowed"))
        .bind(payload)
        .execute(pool)
        .await?;

        ensure_job(pool, lane, kind, 50, payload.clone()).await?;
    } else if event_type.ends_with("Executed") || event_type.ends_with("Closed") {
        ensure_job(pool, "risk_executor", "refresh_state", 200, payload.clone()).await?;
    } else if event_type.ends_with("::windows::EpochRolled") {
        sqlx::query(
            "INSERT INTO window_epochs (book_id, epoch_id, oracle_id, expiry, strikes, status)
             VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, 'rolled')
             ON CONFLICT (book_id, epoch_id) DO UPDATE SET status = 'rolled', strikes = EXCLUDED.strikes, updated_at = now()",
        )
        .bind(json_string(payload, "book_id"))
        .bind(json_i64(payload, "epoch_id"))
        .bind(json_string(payload, "oracle_id"))
        .bind(json_f64(payload, "expiry").unwrap_or(0.0))
        .bind(payload.get("strikes").cloned().unwrap_or(Value::Null))
        .execute(pool)
        .await?;
    } else if event_type.ends_with("::windows::EpochSettled") {
        sqlx::query(
            "UPDATE window_epochs SET status = 'settled', winning_band = $3, settlement_price = $4, updated_at = now()
             WHERE book_id = $1 AND epoch_id = $2",
        )
        .bind(json_string(payload, "book_id"))
        .bind(json_i64(payload, "epoch_id"))
        .bind(json_i64_opt(payload, "winning_band"))
        .bind(json_f64(payload, "settlement_price"))
        .execute(pool)
        .await?;
        ensure_job(
            pool,
            "window_lifecycle",
            "epoch_payout",
            40,
            payload.clone(),
        )
        .await?;
    }
    Ok(())
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn json_i64(value: &Value, key: &str) -> i64 {
    json_i64_opt(value, key).unwrap_or_default()
}

fn json_i64_opt(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    })
}

fn json_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    })
}
