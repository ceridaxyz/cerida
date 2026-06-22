use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};

// ── Domain types ──────────────────────────────────────────────────────────────

pub const MODE_PORTFOLIO: i16 = 0;
pub const MODE_PARLAY: i16 = 1;

pub const KIND_SPREAD: i16 = 0;
pub const KIND_CONDOR: i16 = 1;
pub const KIND_LADDER: i16 = 2;
pub const KIND_DIAGONAL: i16 = 3;
pub const KIND_CROSS_ASSET: i16 = 4;
pub const KIND_TEMPORAL_CONDOR: i16 = 5;
pub const KIND_CUSTOM: i16 = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComboRow {
    pub vault_id: String,
    pub combo_id: i64,
    pub owner: String,
    pub mode: i16,
    pub kind: i16,
    pub leg_count: i16,
    pub status: String,
    pub last_expiry: Option<DateTime<Utc>>,
    pub payout: Option<f64>,
    pub tx_digest: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComboLegRow {
    pub vault_id: String,
    pub combo_id: i64,
    pub leg_index: i16,
    pub oracle_id: Option<String>,
    pub expiry: Option<DateTime<Utc>>,
    pub is_range: Option<bool>,
    pub intent_id: Option<i64>,
    pub status: String,
    pub won: Option<bool>,
    pub payout: Option<f64>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComboWithLegs {
    pub combo: ComboRow,
    pub legs: Vec<ComboLegRow>,
}

// ── DB queries ────────────────────────────────────────────────────────────────

pub async fn get_combo(
    pool: &PgPool,
    vault_id: &str,
    combo_id: i64,
) -> Result<Option<ComboWithLegs>> {
    let row = sqlx::query(
        "SELECT vault_id, combo_id, owner, mode, kind, leg_count, status, last_expiry,
                payout, tx_digest, created_at, updated_at
         FROM combos WHERE vault_id = $1 AND combo_id = $2",
    )
    .bind(vault_id)
    .bind(combo_id)
    .fetch_optional(pool)
    .await?;

    let Some(r) = row else { return Ok(None) };

    let combo = ComboRow {
        vault_id: r.get("vault_id"),
        combo_id: r.get("combo_id"),
        owner: r.get("owner"),
        mode: r.get("mode"),
        kind: r.get("kind"),
        leg_count: r.get("leg_count"),
        status: r.get("status"),
        last_expiry: r.get("last_expiry"),
        payout: r.get("payout"),
        tx_digest: r.get("tx_digest"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    };

    let legs = get_combo_legs(pool, vault_id, combo_id).await?;
    Ok(Some(ComboWithLegs { combo, legs }))
}

pub async fn list_combos(
    pool: &PgPool,
    vault_id: &str,
    owner: Option<&str>,
    status: Option<&str>,
    limit: i64,
) -> Result<Vec<ComboRow>> {
    let rows = sqlx::query(
        "SELECT vault_id, combo_id, owner, mode, kind, leg_count, status, last_expiry,
                payout, tx_digest, created_at, updated_at
         FROM combos
         WHERE vault_id = $1
           AND ($2::TEXT IS NULL OR owner = $2)
           AND ($3::TEXT IS NULL OR status = $3)
         ORDER BY created_at DESC
         LIMIT $4",
    )
    .bind(vault_id)
    .bind(owner)
    .bind(status)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| ComboRow {
            vault_id: r.get("vault_id"),
            combo_id: r.get("combo_id"),
            owner: r.get("owner"),
            mode: r.get("mode"),
            kind: r.get("kind"),
            leg_count: r.get("leg_count"),
            status: r.get("status"),
            last_expiry: r.get("last_expiry"),
            payout: r.get("payout"),
            tx_digest: r.get("tx_digest"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        })
        .collect())
}

pub async fn get_combo_legs(
    pool: &PgPool,
    vault_id: &str,
    combo_id: i64,
) -> Result<Vec<ComboLegRow>> {
    let rows = sqlx::query(
        "SELECT vault_id, combo_id, leg_index, oracle_id, expiry, is_range,
                intent_id, status, won, payout, updated_at
         FROM combo_legs WHERE vault_id = $1 AND combo_id = $2 ORDER BY leg_index",
    )
    .bind(vault_id)
    .bind(combo_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| ComboLegRow {
            vault_id: r.get("vault_id"),
            combo_id: r.get("combo_id"),
            leg_index: r.get("leg_index"),
            oracle_id: r.get("oracle_id"),
            expiry: r.get("expiry"),
            is_range: r.get("is_range"),
            intent_id: r.get("intent_id"),
            status: r.get("status"),
            won: r.get("won"),
            payout: r.get("payout"),
            updated_at: r.get("updated_at"),
        })
        .collect())
}

/// Legs that have a stored token and are past expiry — ready to settle.
pub async fn get_legs_ready_to_settle(
    pool: &PgPool,
    vault_id: &str,
) -> Result<Vec<ComboLegRow>> {
    let rows = sqlx::query(
        "SELECT cl.vault_id, cl.combo_id, cl.leg_index, cl.oracle_id, cl.expiry, cl.is_range,
                cl.intent_id, cl.status, cl.won, cl.payout, cl.updated_at
         FROM combo_legs cl
         JOIN combos c ON c.vault_id = cl.vault_id AND c.combo_id = cl.combo_id
         WHERE cl.vault_id = $1
           AND cl.status = 'minted'
           AND cl.expiry IS NOT NULL AND cl.expiry <= now()
           AND c.status = 'active'
         ORDER BY cl.expiry ASC, cl.combo_id, cl.leg_index",
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| ComboLegRow {
            vault_id: r.get("vault_id"),
            combo_id: r.get("combo_id"),
            leg_index: r.get("leg_index"),
            oracle_id: r.get("oracle_id"),
            expiry: r.get("expiry"),
            is_range: r.get("is_range"),
            intent_id: r.get("intent_id"),
            status: r.get("status"),
            won: r.get("won"),
            payout: r.get("payout"),
            updated_at: r.get("updated_at"),
        })
        .collect())
}

/// Upsert a leg row when a ComboCreated event arrives (legs start as 'pending').
pub async fn upsert_combo_leg(
    pool: &PgPool,
    vault_id: &str,
    combo_id: i64,
    leg_index: i16,
    oracle_id: Option<&str>,
    expiry_ms: Option<f64>,
    is_range: Option<bool>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO combo_legs (vault_id, combo_id, leg_index, oracle_id, expiry, is_range, status)
         VALUES ($1, $2, $3, $4,
           CASE WHEN $5::DOUBLE PRECISION IS NULL THEN NULL ELSE to_timestamp($5 / 1000.0) END,
           $6, 'pending')
         ON CONFLICT (vault_id, combo_id, leg_index) DO NOTHING",
    )
    .bind(vault_id)
    .bind(combo_id)
    .bind(leg_index)
    .bind(oracle_id)
    .bind(expiry_ms)
    .bind(is_range)
    .execute(pool)
    .await?;
    Ok(())
}

/// Build a keeper job payload for execute_combo_mint from a ComboCreated event.
pub fn combo_execute_payload(vault_id: &str, combo_id: i64, leg_count: i16) -> Value {
    serde_json::json!({
        "vault_id": vault_id,
        "combo_id": combo_id,
        "leg_count": leg_count,
    })
}

/// Build a keeper job payload for settle_combo_leg.
pub fn combo_settle_payload(
    vault_id: &str,
    combo_id: i64,
    leg_index: i16,
    oracle_id: &str,
) -> Value {
    serde_json::json!({
        "vault_id": vault_id,
        "combo_id": combo_id,
        "leg_index": leg_index,
        "oracle_id": oracle_id,
    })
}
