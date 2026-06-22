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
        "CREATE TABLE IF NOT EXISTS combos (
            vault_id    TEXT NOT NULL,
            combo_id    BIGINT NOT NULL,
            owner       TEXT NOT NULL,
            mode        SMALLINT NOT NULL,  -- 0=portfolio 1=parlay
            kind        SMALLINT NOT NULL,  -- 0-6
            leg_count   SMALLINT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'active',
            last_expiry TIMESTAMPTZ,
            payout      NUMERIC,
            tx_digest   TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (vault_id, combo_id)
        )",
        "CREATE TABLE IF NOT EXISTS combo_legs (
            vault_id    TEXT NOT NULL,
            combo_id    BIGINT NOT NULL,
            leg_index   SMALLINT NOT NULL,
            oracle_id   TEXT,
            expiry      TIMESTAMPTZ,
            is_range    BOOLEAN,
            intent_id   BIGINT,
            status      TEXT NOT NULL DEFAULT 'pending',
            won         BOOLEAN,
            payout      NUMERIC,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (vault_id, combo_id, leg_index)
        )",
        "CREATE TABLE IF NOT EXISTS monitored_positions (
            vault_id     TEXT NOT NULL,
            position_id  BIGINT NOT NULL,
            user_address TEXT NOT NULL,
            oracle_id    TEXT NOT NULL,
            expiry       TIMESTAMPTZ,
            qty          NUMERIC NOT NULL,
            tp_value     NUMERIC,
            sl_value     NUMERIC,
            status       TEXT NOT NULL DEFAULT 'active',
            exited_payout NUMERIC,
            hit_tp       BOOLEAN,
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (vault_id, position_id)
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

pub async fn schedule_job(
    pool: &PgPool,
    lane: &str,
    job_type: &str,
    priority: i32,
    delay_secs: i64,
    payload: Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO keeper_jobs (lane, job_type, priority, payload, available_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
         ON CONFLICT DO NOTHING",
    )
    .bind(lane)
    .bind(job_type)
    .bind(priority)
    .bind(payload)
    .bind(delay_secs)
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

        // Enrich with manager_id from vaults table — not present in on-chain event structs.
        let manager_id: Option<String> = sqlx::query_scalar(
            "SELECT manager_id FROM vaults WHERE vault_id = $1",
        )
        .bind(&vault_id)
        .fetch_optional(pool)
        .await?;
        let mut job_payload = payload.clone();
        if let (Some(obj), Some(mid)) = (job_payload.as_object_mut(), manager_id) {
            obj.insert("manager_id".into(), Value::String(mid));
        }
        ensure_job(pool, lane, kind, 50, job_payload).await?;
    } else if event_type.ends_with("::vault::LeverageOpenExecuted") {
        let vault_id_str = json_string(payload, "vault_id");
        let intent_id    = json_i64(payload, "intent_id");
        let position_id  = json_i64(payload, "position_id");
        // oracle_id was stored in the intents table when LeverageOpenRequested fired.
        let oracle_id: Option<String> = sqlx::query_scalar(
            "SELECT oracle_id FROM intents WHERE vault_id = $1 AND intent_id = $2 AND kind = 'leverage_open'",
        )
        .bind(&vault_id_str)
        .bind(intent_id)
        .fetch_optional(pool)
        .await?;
        let manager_id: Option<String> = sqlx::query_scalar(
            "SELECT manager_id FROM vaults WHERE vault_id = $1",
        )
        .bind(&vault_id_str)
        .fetch_optional(pool)
        .await?;
        if let Some(ref oid) = oracle_id {
            let job_payload = serde_json::json!({
                "vault_id":    vault_id_str,
                "position_id": position_id,
                "oracle_id":   oid,
                "manager_id":  manager_id,
            });
            ensure_job(pool, "risk_executor", "leverage_monitor", 60, job_payload).await?;
        } else {
            tracing::warn!(
                vault_id = %vault_id_str,
                intent_id,
                "LeverageOpenExecuted: no intent row found, cannot schedule leverage_monitor"
            );
        }
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
        // Schedule epoch_settle to fire ~15 s after expiry (oracle settles shortly after).
        let expiry_ms = json_f64(payload, "expiry").unwrap_or(0.0) as i64;
        let now_ms    = chrono::Utc::now().timestamp_millis();
        let delay_secs = ((expiry_ms - now_ms) / 1000 + 15).max(5);
        let settle_payload = serde_json::json!({
            "book_id":  json_string(payload, "book_id"),
            "epoch_id": json_i64(payload, "epoch_id"),
            "oracle_id": json_string(payload, "oracle_id"),
        });
        schedule_job(pool, "window_lifecycle", "epoch_settle", 40, delay_secs, settle_payload).await?;
    } else if event_type.ends_with("::combo::ComboCreated") {
        sqlx::query(
            "INSERT INTO combos (vault_id, combo_id, owner, mode, kind, leg_count, last_expiry, status)
             VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $7::DOUBLE PRECISION IS NULL THEN NULL ELSE to_timestamp($7 / 1000.0) END,
               'active')
             ON CONFLICT (vault_id, combo_id) DO NOTHING",
        )
        .bind(json_string(payload, "vault_id"))
        .bind(json_i64(payload, "combo_id"))
        .bind(json_string(payload, "owner"))
        .bind(payload.get("mode").and_then(|v| v.as_i64()).unwrap_or(0) as i16)
        .bind(payload.get("kind").and_then(|v| v.as_i64()).unwrap_or(0) as i16)
        .bind(payload.get("leg_count").and_then(|v| v.as_i64()).unwrap_or(0) as i16)
        .bind(json_f64(payload, "last_expiry"))
        .execute(pool)
        .await?;
        // Queue combo_execute_mints job for the keeper
        ensure_job(pool, "intent_executor", "combo_execute_mints", 40, payload.clone()).await?;
    } else if event_type.ends_with("::combo::ComboMintExecuted") {
        let vault_id_str = json_string(payload, "vault_id");
        let combo_id_val = json_i64(payload, "combo_id");
        let leg_idx      = payload.get("leg_index").and_then(|v| v.as_i64()).unwrap_or(0) as i16;
        sqlx::query(
            "UPDATE combo_legs SET status = 'minted', intent_id = $4, updated_at = now()
             WHERE vault_id = $1 AND combo_id = $2 AND leg_index = $3",
        )
        .bind(&vault_id_str)
        .bind(combo_id_val)
        .bind(leg_idx)
        .bind(json_i64(payload, "intent_id"))
        .execute(pool)
        .await?;
        // Schedule combo_settle_leg to fire at leg expiry.
        let leg_row = sqlx::query(
            "SELECT oracle_id, extract(epoch from expiry) * 1000 AS expiry_ms
             FROM combo_legs WHERE vault_id = $1 AND combo_id = $2 AND leg_index = $3",
        )
        .bind(&vault_id_str)
        .bind(combo_id_val)
        .bind(leg_idx)
        .fetch_optional(pool)
        .await?;
        if let Some(row) = leg_row {
            let oracle_id: Option<String> = row.get("oracle_id");
            let expiry_ms: Option<f64>    = row.get("expiry_ms");
            if let (Some(oid), Some(exp)) = (oracle_id, expiry_ms) {
                let manager_id: Option<String> = sqlx::query_scalar(
                    "SELECT manager_id FROM vaults WHERE vault_id = $1",
                )
                .bind(&vault_id_str)
                .fetch_optional(pool)
                .await?;
                let now_ms     = chrono::Utc::now().timestamp_millis();
                let delay_secs = ((exp as i64 - now_ms) / 1000 + 10).max(0);
                let settle_payload = serde_json::json!({
                    "vault_id":  vault_id_str,
                    "combo_id":  combo_id_val,
                    "leg_index": leg_idx,
                    "oracle_id": oid,
                    "manager_id": manager_id,
                });
                schedule_job(pool, "intent_executor", "combo_settle_leg", 45, delay_secs, settle_payload).await?;
            }
        }
    } else if event_type.ends_with("::combo::ComboLegSettled") {
        sqlx::query(
            "UPDATE combo_legs SET status = 'settled', won = $4, payout = $5, updated_at = now()
             WHERE vault_id = $1 AND combo_id = $2 AND leg_index = $3",
        )
        .bind(json_string(payload, "vault_id"))
        .bind(json_i64(payload, "combo_id"))
        .bind(payload.get("leg_index").and_then(|v| v.as_i64()).unwrap_or(0) as i16)
        .bind(payload.get("won").and_then(Value::as_bool).unwrap_or(false))
        .bind(json_f64(payload, "payout"))
        .execute(pool)
        .await?;
    } else if event_type.ends_with("::combo::ComboSettled") {
        let status = if json_i64(payload, "status") == 1 { "won" } else { "lost" };
        sqlx::query(
            "UPDATE combos SET status = $3, payout = $4, updated_at = now()
             WHERE vault_id = $1 AND combo_id = $2",
        )
        .bind(json_string(payload, "vault_id"))
        .bind(json_i64(payload, "combo_id"))
        .bind(status)
        .bind(json_f64(payload, "total_payout"))
        .execute(pool)
        .await?;
    } else if event_type.ends_with("::vault::ComboClaimed") {
        sqlx::query(
            "UPDATE combos SET status = 'claimed', updated_at = now()
             WHERE vault_id = $1 AND combo_id = $2",
        )
        .bind(json_string(payload, "vault_id"))
        .bind(json_i64(payload, "combo_id"))
        .execute(pool)
        .await?;
    } else if event_type.ends_with("::vault::PositionMonitored") {
        let vault_id_str = json_string(payload, "vault_id");
        sqlx::query(
            "INSERT INTO monitored_positions
             (vault_id, position_id, user_address, oracle_id, expiry, qty, tp_value, sl_value, status)
             VALUES ($1, $2, $3, $4,
               CASE WHEN $5::DOUBLE PRECISION IS NULL THEN NULL ELSE to_timestamp($5 / 1000.0) END,
               $6, $7, $8, 'active')
             ON CONFLICT (vault_id, position_id) DO NOTHING",
        )
        .bind(&vault_id_str)
        .bind(json_i64(payload, "position_id"))
        .bind(json_string(payload, "user"))
        .bind(json_string(payload, "oracle_id"))
        .bind(json_f64(payload, "expiry"))
        .bind(json_f64(payload, "qty"))
        .bind(json_f64(payload, "tp_value"))
        .bind(json_f64(payload, "sl_value"))
        .execute(pool)
        .await?;
        let manager_id: Option<String> = sqlx::query_scalar(
            "SELECT manager_id FROM vaults WHERE vault_id = $1",
        )
        .bind(&vault_id_str)
        .fetch_optional(pool)
        .await?;
        let job_payload = serde_json::json!({
            "vault_id":    vault_id_str,
            "position_id": json_i64(payload, "position_id"),
            "oracle_id":   json_string(payload, "oracle_id"),
            "manager_id":  manager_id,
        });
        ensure_job(pool, "risk_executor", "monitor_position", 60, job_payload).await?;
    } else if event_type.ends_with("::vault::PositionExited") {
        sqlx::query(
            "UPDATE monitored_positions
             SET status = 'exited', exited_payout = $3, hit_tp = $4, updated_at = now()
             WHERE vault_id = $1 AND position_id = $2",
        )
        .bind(json_string(payload, "vault_id"))
        .bind(json_i64(payload, "position_id"))
        .bind(json_f64(payload, "payout"))
        .bind(payload.get("hit_tp").and_then(Value::as_bool))
        .execute(pool)
        .await?;
    } else if event_type.ends_with("::windows::EpochSettled") {
        let book_id_str  = json_string(payload, "book_id");
        let epoch_id_val = json_i64(payload, "epoch_id");
        sqlx::query(
            "UPDATE window_epochs SET status = 'settled', winning_band = $3, settlement_price = $4, updated_at = now()
             WHERE book_id = $1 AND epoch_id = $2",
        )
        .bind(&book_id_str)
        .bind(epoch_id_val)
        .bind(json_i64_opt(payload, "winning_band"))
        .bind(json_f64(payload, "settlement_price"))
        .execute(pool)
        .await?;
        // EpochSettled payload only has book_id/epoch_id; enrich with oracle_id for epoch_payout.
        let oracle_id: Option<String> = sqlx::query_scalar(
            "SELECT oracle_id FROM window_epochs WHERE book_id = $1 AND epoch_id = $2",
        )
        .bind(&book_id_str)
        .bind(epoch_id_val)
        .fetch_optional(pool)
        .await?;
        let mut payout_payload = payload.clone();
        if let (Some(obj), Some(oid)) = (payout_payload.as_object_mut(), oracle_id) {
            obj.insert("oracle_id".into(), Value::String(oid));
        }
        ensure_job(pool, "window_lifecycle", "epoch_payout", 40, payout_payload).await?;
    }
    Ok(())
}

/// Called at keeper startup: ensures at least one pending `epoch_open` job exists for the
/// `window_lifecycle` lane. If the `window_epochs` table is empty (first deployment) the
/// function is a no-op — an operator must roll the first epoch manually.
/// Queue an `epoch_open` job if none is pending.
///
/// The `epoch_open` handler creates a fresh Predict oracle per epoch, so the
/// payload only needs to carry the strike boundaries. On first boot (no DB rows
/// yet) the caller supplies `default_strikes`; thereafter we read the last
/// rolled epoch's strikes so the ladder is preserved across restarts.
pub async fn ensure_window_epoch_scheduled(
    pool: &PgPool,
    default_strikes: Option<&[u64]>,
) -> Result<()> {
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM keeper_jobs
         WHERE lane = 'window_lifecycle' AND job_type = 'epoch_open'
           AND status = 'pending'",
    )
    .fetch_one(pool)
    .await?;
    if pending > 0 {
        return Ok(());
    }

    // Prefer strikes from the last rolled epoch; fall back to config default.
    let strikes_val: Value = {
        let row = sqlx::query_scalar::<_, Value>(
            "SELECT strikes FROM window_epochs ORDER BY expiry DESC LIMIT 1",
        )
        .fetch_optional(pool)
        .await?;

        if let Some(v) = row {
            v
        } else if let Some(s) = default_strikes {
            Value::Array(s.iter().map(|n| Value::Number((*n).into())).collect())
        } else {
            tracing::warn!("no window_epochs rows and no default strikes; skipping epoch_open bootstrap");
            return Ok(());
        }
    };

    let payload = serde_json::json!({ "strikes": strikes_val });
    ensure_job(pool, "window_lifecycle", "epoch_open", 30, payload).await?;
    tracing::info!("bootstrap: queued epoch_open job for window_lifecycle lane");
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
