// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0
//
// High-level keeper PTB execution. Each public function maps to one keeper
// job type, builds the appropriate Programmable Transaction Block, dry-runs
// it, then signs and submits (or short-circuits in dry-run mode).

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use bcs;
use serde_json::Value;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::sui::SuiRpcClient;
use crate::sui_tx::{
    address_of, load_signing_key, parse_object_id, parse_type_tag, sign_transaction, GasData,
    ObjectDigest, ObjectRef, PtbBuilder, TransactionData, TransactionDataV1,
    TransactionExpiration, TransactionKind,
};

/// The well-known Sui system clock object ID.
const CLOCK_ID: &str = "0x0000000000000000000000000000000000000000000000000000000000000006";
/// initial_shared_version for the Clock is always 1.
const CLOCK_VERSION: u64 = 1;
/// Gas budget safety cap — refuse to sign anything over this.
const MAX_GAS_BUDGET: u64 = 500_000_000; // 0.5 SUI

// ── Context ──────────────────────────────────────────────────────────────────

/// Everything the keeper needs to build and submit transactions.
pub struct KeeperContext {
    pub sui: SuiRpcClient,
    pub cfg: Config,
    pub pool: sqlx::PgPool,
}

impl KeeperContext {
    pub fn new(sui: SuiRpcClient, cfg: Config, pool: sqlx::PgPool) -> Self {
        Self { sui, cfg, pool }
    }
}

// ── Top-level dispatcher ─────────────────────────────────────────────────────

/// Execute one keeper job. Returns `Some(digest)` on success, `None` for
/// no-op jobs (e.g. `refresh_state`).
pub async fn execute_job(ctx: &KeeperContext, job_type: &str, payload: &Value) -> Result<Option<String>> {
    match job_type {
        "mint" | "redeem" => execute_mint_or_redeem(ctx, job_type, payload).await.map(Some),
        "leverage_open" => execute_leverage_open(ctx, payload).await.map(Some),
        "window_bet" => execute_window_bet(ctx, payload).await.map(Some),
        "epoch_payout" => execute_epoch_payout(ctx, payload).await.map(Some),
        "epoch_open"   => epoch_open(ctx, payload).await.map(Some),
        "epoch_settle" => epoch_settle(ctx, payload).await,
        "combo_execute_mints" => combo_execute_mints(ctx, payload).await.map(Some),
        "combo_settle_leg" => combo_settle_leg(ctx, payload).await.map(Some),
        "monitor_position" => monitor_position(ctx, payload).await,
        "leverage_monitor" => leverage_monitor(ctx, payload).await,
        "refresh_state" => {
            debug!("refresh_state is a read-only job — no tx needed");
            Ok(None)
        }
        other => bail!("unknown job type: {other}"),
    }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/// Shared object for the SUI system Clock (0x6). Always version 1, immutable.
fn clock_arg(ptb: &mut PtbBuilder) -> crate::sui_tx::Argument {
    ptb.shared(parse_object_id(CLOCK_ID).unwrap(), CLOCK_VERSION, false)
}

/// Read a required string field from a JSON payload.
fn str_field<'a>(payload: &'a Value, key: &str) -> Result<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("missing `{key}` in payload"))
}

/// Read a required u64 field (stored as number or stringified number).
fn u64_field(payload: &Value, key: &str) -> Result<u64> {
    payload
        .get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .with_context(|| format!("missing or invalid `{key}` in payload"))
}

/// Add a shared object to the PTB, fetching its `initial_shared_version` from
/// the RPC. `mutable` controls whether the object is passed as `&mut`.
async fn add_shared(
    ptb: &mut PtbBuilder,
    sui: &SuiRpcClient,
    object_id: &str,
    mutable: bool,
) -> Result<crate::sui_tx::Argument> {
    let info = sui
        .get_shared_object_info(object_id)
        .await
        .with_context(|| format!("get_shared_object_info for {object_id}"))?;
    Ok(ptb.shared(parse_object_id(object_id)?, info.initial_shared_version, mutable))
}

/// Parse a coin object reference from the RPC response into an `ObjectRef`.
fn coin_to_ref(coin: &crate::sui::CoinObject) -> Result<ObjectRef> {
    let version: u64 = coin.version.parse()?;
    let digest_bytes = base64::engine::general_purpose::STANDARD
        .decode(&coin.digest)
        .with_context(|| format!("decode digest {}", coin.digest))?;
    let mut digest_arr = [0u8; 32];
    let len = digest_bytes.len().min(32);
    digest_arr[..len].copy_from_slice(&digest_bytes[..len]);
    Ok((parse_object_id(&coin.coin_object_id)?, version, ObjectDigest(digest_arr)))
}

/// Build, optionally dry-run, sign, and submit the PTB. Returns the tx digest.
async fn submit(ctx: &KeeperContext, ptb: PtbBuilder) -> Result<String> {
    let package_id = ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?;
    let _ = package_id; // used for context only; package ref is already in each MoveCall

    // Derive keeper address from private key
    let key_str = ctx.cfg.keeper_private_key.as_deref().context("KEEPER_PRIVATE_KEY not set")?;
    let signing_key = load_signing_key(key_str)?;
    let keeper_addr = address_of(&signing_key);
    let keeper_addr_hex = format!("0x{}", hex::encode(keeper_addr.0));

    // Gas
    let gas_price = ctx.sui.get_reference_gas_price().await.unwrap_or(1_000);
    let budget = ctx.cfg.gas_budget.min(MAX_GAS_BUDGET);

    // Gas coin
    let coins = ctx.sui.get_coins(&keeper_addr_hex, "0x2::sui::SUI").await?;
    let gas_coin = coins.first().context("keeper has no SUI gas coins")?;
    let gas_ref = coin_to_ref(gas_coin)?;

    let tx = TransactionData::V1(TransactionDataV1 {
        kind: TransactionKind::ProgrammableTransaction(ptb.finish()),
        sender: keeper_addr.clone(),
        gas_data: GasData {
            payment: vec![gas_ref],
            owner: keeper_addr.clone(),
            price: gas_price,
            budget,
        },
        expiration: TransactionExpiration::None,
    });

    let (tx_bytes_b64, sig_b64) = sign_transaction(&signing_key, &tx)?;

    // Dry-run first regardless of mode
    let dry = ctx.sui.dry_run_transaction(&tx_bytes_b64).await;
    match &dry {
        Ok(result) => {
            let status = result.effects.pointer("/status/status").and_then(Value::as_str).unwrap_or("?");
            debug!(status, "dry-run OK");
            if status != "success" {
                let err = result.effects.pointer("/status/error").and_then(Value::as_str).unwrap_or("unknown");
                bail!("dry-run failed: {err}");
            }
        }
        Err(e) => bail!("dry-run RPC error: {e}"),
    }

    if ctx.cfg.keeper_dry_run {
        info!("dry-run mode: tx built and verified but NOT submitted");
        return Ok(format!("dry-run:{}", hex::encode(&bcs::to_bytes(&tx)?[..8])));
    }

    let digest = ctx.sui.execute_transaction(&tx_bytes_b64, &sig_b64).await?;
    info!(digest, "tx submitted");
    Ok(digest)
}

// ── Job implementations ──────────────────────────────────────────────────────

/// `vault::execute_mint` / `vault::execute_redeem`
async fn execute_mint_or_redeem(
    ctx: &KeeperContext,
    job_type: &str,
    payload: &Value,
) -> Result<String> {
    let vault_id = ctx.cfg.vault_id.as_deref().context("VAULT_ID not set")?;
    let predict_id = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let oracle_id = str_field(payload, "oracle_id")?;
    let intent_id = u64_field(payload, "intent_id")
        .or_else(|_| u64_field(payload, "redeem_id"))?;
    let quote_type = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    // Fetch manager_id from vault info in payload or fall back to vault query
    let manager_id = str_field(payload, "manager_id")
        .or_else(|_| str_field(payload, "vault_id").map(|_| ""))?;

    let mut ptb = PtbBuilder::new();
    let vault_arg = add_shared(&mut ptb, &ctx.sui, vault_id, true).await?;

    // manager_id should be in the vaults DB row; the payload may have it
    let manager_arg = if !manager_id.is_empty() {
        add_shared(&mut ptb, &ctx.sui, manager_id, true).await?
    } else {
        // Last resort: fetch from vaults table not available here; require in payload
        bail!("manager_id missing from payload — ensure vaults table is populated");
    };

    let predict_arg = add_shared(&mut ptb, &ctx.sui, predict_id, true).await?;
    let oracle_arg = add_shared(&mut ptb, &ctx.sui, oracle_id, false).await?;
    let clock_arg = clock_arg(&mut ptb);
    let intent_id_arg = ptb.pure_u64(intent_id);

    let fn_name = if job_type == "redeem" { "execute_redeem" } else { "execute_mint" };

    ptb.move_call(
        package,
        "vault",
        fn_name,
        vec![quote_type],
        vec![vault_arg, manager_arg, predict_arg, oracle_arg, intent_id_arg, clock_arg],
    );

    submit(ctx, ptb).await
}

/// `vault::execute_leverage_open`
async fn execute_leverage_open(ctx: &KeeperContext, payload: &Value) -> Result<String> {
    let vault_id = ctx.cfg.vault_id.as_deref().context("VAULT_ID not set")?;
    let predict_id = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let pool_id = ctx.cfg.margin_pool_id.as_deref().context("MARGIN_POOL_ID not set")?;
    let book_id = ctx.cfg.leverage_book_id.as_deref().context("LEVERAGE_BOOK_ID not set")?;
    let oracle_id = str_field(payload, "oracle_id")?;
    let intent_id = u64_field(payload, "intent_id")?;
    let manager_id = str_field(payload, "manager_id")?;
    let quote_type = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    let mut ptb = PtbBuilder::new();
    let vault_arg = add_shared(&mut ptb, &ctx.sui, vault_id, true).await?;
    let manager_arg = add_shared(&mut ptb, &ctx.sui, manager_id, true).await?;
    let predict_arg = add_shared(&mut ptb, &ctx.sui, predict_id, true).await?;
    let oracle_arg = add_shared(&mut ptb, &ctx.sui, oracle_id, false).await?;
    let pool_arg = add_shared(&mut ptb, &ctx.sui, pool_id, true).await?;
    let book_arg = add_shared(&mut ptb, &ctx.sui, book_id, true).await?;
    let clock_arg = clock_arg(&mut ptb);
    let intent_id_arg = ptb.pure_u64(intent_id);

    ptb.move_call(
        package,
        "vault",
        "execute_leverage_open",
        vec![quote_type],
        vec![vault_arg, manager_arg, predict_arg, oracle_arg, pool_arg, book_arg, intent_id_arg, clock_arg],
    );

    submit(ctx, ptb).await
}

/// `vault::execute_window_bet`
async fn execute_window_bet(ctx: &KeeperContext, payload: &Value) -> Result<String> {
    let vault_id = ctx.cfg.vault_id.as_deref().context("VAULT_ID not set")?;
    let predict_id = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let window_book_id = ctx.cfg.window_book_id.as_deref().context("WINDOW_BOOK_ID not set")?;
    let oracle_id = str_field(payload, "oracle_id").unwrap_or(window_book_id);
    let intent_id = u64_field(payload, "intent_id")?;
    let manager_id = str_field(payload, "manager_id")?;
    let quote_type = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    // oracle_id may not be in the window_bet payload directly — the window book
    // holds the epoch ↔ oracle mapping. Use the book as the oracle source.
    let oracle_lookup = str_field(payload, "oracle_id").unwrap_or(oracle_id);

    let mut ptb = PtbBuilder::new();
    let vault_arg = add_shared(&mut ptb, &ctx.sui, vault_id, true).await?;
    let manager_arg = add_shared(&mut ptb, &ctx.sui, manager_id, true).await?;
    let predict_arg = add_shared(&mut ptb, &ctx.sui, predict_id, true).await?;
    let oracle_arg = add_shared(&mut ptb, &ctx.sui, oracle_lookup, false).await?;
    let book_arg = add_shared(&mut ptb, &ctx.sui, window_book_id, true).await?;
    let clock_arg = clock_arg(&mut ptb);
    let intent_id_arg = ptb.pure_u64(intent_id);

    ptb.move_call(
        package,
        "vault",
        "execute_window_bet",
        vec![quote_type],
        vec![vault_arg, manager_arg, predict_arg, oracle_arg, book_arg, intent_id_arg, clock_arg],
    );

    submit(ctx, ptb).await
}

/// `vault::execute_epoch_payout`
async fn execute_epoch_payout(ctx: &KeeperContext, payload: &Value) -> Result<String> {
    let vault_id       = ctx.cfg.vault_id.as_deref().context("VAULT_ID not set")?;
    let predict_id     = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let window_book_id = ctx.cfg.window_book_id.as_deref().context("WINDOW_BOOK_ID not set")?;
    let epoch_id       = u64_field(payload, "epoch_id")?;
    let quote_type     = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package        = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    // manager_id: prefer job payload (enriched by db handler), fall back to vaults table.
    let manager_id: String = if let Ok(mid) = str_field(payload, "manager_id") {
        mid.to_string()
    } else {
        sqlx::query_scalar("SELECT manager_id FROM vaults WHERE vault_id = $1")
            .bind(vault_id)
            .fetch_one(&ctx.pool)
            .await
            .context("epoch_payout: manager_id not in vaults table")?
    };

    // oracle_id: prefer job payload (enriched by db handler), fall back to window_epochs table.
    let oracle_id: String = if let Ok(oid) = str_field(payload, "oracle_id") {
        oid.to_string()
    } else {
        sqlx::query_scalar(
            "SELECT oracle_id FROM window_epochs WHERE book_id = $1 AND epoch_id = $2",
        )
        .bind(window_book_id)
        .bind(epoch_id as i64)
        .fetch_one(&ctx.pool)
        .await
        .context("epoch_payout: oracle_id not found in window_epochs")?
    };

    let mut ptb = PtbBuilder::new();
    let vault_arg    = add_shared(&mut ptb, &ctx.sui, vault_id, true).await?;
    let manager_arg  = add_shared(&mut ptb, &ctx.sui, &manager_id, true).await?;
    let predict_arg  = add_shared(&mut ptb, &ctx.sui, predict_id, true).await?;
    let oracle_arg   = add_shared(&mut ptb, &ctx.sui, &oracle_id, false).await?;
    let book_arg     = add_shared(&mut ptb, &ctx.sui, window_book_id, false).await?;
    let clk_arg      = clock_arg(&mut ptb);
    let epoch_id_arg = ptb.pure_u64(epoch_id);

    ptb.move_call(
        package,
        "vault",
        "execute_epoch_payout",
        vec![quote_type],
        vec![vault_arg, manager_arg, predict_arg, oracle_arg, book_arg, epoch_id_arg, clk_arg],
    );

    submit(ctx, ptb).await
}

/// `windows::settle_epoch` — records the winning band after the epoch oracle settles.
///
/// Permissionless. Dry-runs first: if the oracle is not yet settled (`ENotSettled = 8`)
/// the job re-queues itself with a 30 s delay. `EEpochAlreadySettled (3)` is treated as
/// success (idempotent).
/// `epoch_settle` — push prices to settle the per-epoch oracle, then record the
/// winning band via `windows::settle_epoch`.
///
/// The keeper owns the oracle cap used at creation; pushing prices after the
/// oracle's own expiry timestamp freezes the settlement price (Predict semantics).
/// We combine both calls in one PTB so the oracle is settled and the epoch is
/// recorded atomically.
async fn epoch_settle(ctx: &KeeperContext, payload: &Value) -> Result<Option<String>> {
    let window_book_id    = ctx.cfg.window_book_id.as_deref().context("WINDOW_BOOK_ID not set")?;
    let predict_pkg_str   = ctx.cfg.predict_package_id.as_deref().context("PREDICT_PACKAGE_ID not set")?;
    let oracle_cap_id     = ctx.cfg.keeper_oracle_cap_id.as_deref().context("KEEPER_ORACLE_CAP_ID not set")?;
    let oracle_id         = str_field(payload, "oracle_id")?;
    let epoch_id          = u64_field(payload, "epoch_id")?;
    let quote_type        = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let cerida_pkg        = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;
    let predict_pkg = parse_object_id(predict_pkg_str)?;

    // Fetch oracle cap as owned object ref.
    let (cap_id, cap_ver, cap_digest) = ctx.sui.get_object_ref(oracle_cap_id).await?;
    let cap_digest_bytes = base64::engine::general_purpose::STANDARD.decode(&cap_digest)?;
    let mut cap_digest_arr = [0u8; 32];
    cap_digest_arr[..cap_digest_bytes.len().min(32)].copy_from_slice(&cap_digest_bytes[..cap_digest_bytes.len().min(32)]);

    let mut ptb        = PtbBuilder::new();
    let oracle_arg     = add_shared(&mut ptb, &ctx.sui, oracle_id, true).await?;
    let book_arg       = add_shared(&mut ptb, &ctx.sui, window_book_id, true).await?;
    let clk_arg        = clock_arg(&mut ptb);
    let epoch_id_arg   = ptb.pure_u64(epoch_id);

    // oracle cap — owned object (ImmOrOwnedObject).
    let cap_obj = ptb.owned(
        parse_object_id(&cap_id)?,
        cap_ver,
        crate::sui_tx::ObjectDigest(cap_digest_arr),
    );

    // Build a fresh PriceData and push it — if oracle is past its expiry this
    // freezes the settlement price; if still live it just updates spot.
    // We use 0 as a placeholder spot; the actual value doesn't matter for
    // already-settled oracles, and for live feeds the indexer provides real prices.
    let spot_arg   = ptb.pure_u64(63_000_000_000_000u64); // $63k placeholder
    let prices_arg = ptb.move_call_result(predict_pkg.clone(), "oracle", "new_price_data",
        vec![], vec![spot_arg, spot_arg]);
    ptb.move_call(
        predict_pkg,
        "oracle",
        "update_prices",
        vec![],
        vec![oracle_arg, cap_obj, prices_arg, clk_arg],
    );

    // Now settle the epoch (oracle is settled after update_prices above).
    ptb.move_call(
        cerida_pkg,
        "windows",
        "settle_epoch",
        vec![quote_type],
        vec![book_arg, oracle_arg, epoch_id_arg],
    );

    let key_str         = ctx.cfg.keeper_private_key.as_deref().context("KEEPER_PRIVATE_KEY not set")?;
    let signing_key     = load_signing_key(key_str)?;
    let keeper_addr     = address_of(&signing_key);
    let keeper_addr_hex = format!("0x{}", hex::encode(keeper_addr.0));
    let gas_price       = ctx.sui.get_reference_gas_price().await.unwrap_or(1_000);
    let budget          = ctx.cfg.gas_budget.min(MAX_GAS_BUDGET);
    let coins           = ctx.sui.get_coins(&keeper_addr_hex, "0x2::sui::SUI").await?;
    let gas_coin        = coins.first().context("keeper has no SUI gas coins")?;
    let gas_ref         = coin_to_ref(gas_coin)?;

    let tx = crate::sui_tx::TransactionData::V1(crate::sui_tx::TransactionDataV1 {
        kind: crate::sui_tx::TransactionKind::ProgrammableTransaction(ptb.finish()),
        sender: keeper_addr.clone(),
        gas_data: crate::sui_tx::GasData {
            payment: vec![gas_ref],
            owner: keeper_addr.clone(),
            price: gas_price,
            budget,
        },
        expiration: crate::sui_tx::TransactionExpiration::None,
    });
    let (tx_bytes, sig) = crate::sui_tx::sign_transaction(&signing_key, &tx)?;

    match ctx.sui.dry_run_transaction(&tx_bytes).await {
        Ok(result) => {
            let status = result.effects.pointer("/status/status").and_then(Value::as_str).unwrap_or("?");
            if status != "success" {
                let err = result.effects.pointer("/status/error").and_then(Value::as_str).unwrap_or("unknown");
                if err.contains("EEpochAlreadySettled") || err.contains(", 3)") {
                    info!(epoch_id, "epoch already settled, skipping");
                    return Ok(None);
                }
                // ENotSettled — oracle's own expiry not yet reached; re-queue in 30s.
                if err.contains("ENotSettled") || err.contains(", 8)") {
                    warn!(epoch_id, "oracle not yet past expiry, re-queuing in 30s");
                    crate::db::schedule_job(
                        &ctx.pool, "window_lifecycle", "epoch_settle", 40, 30, payload.clone(),
                    ).await?;
                    return Ok(None);
                }
                bail!("epoch_settle dry-run failed: {err}");
            }
        }
        Err(e) => bail!("epoch_settle dry-run RPC error: {e}"),
    }

    if ctx.cfg.keeper_dry_run {
        info!("dry-run mode: epoch_settle verified but NOT submitted for epoch {epoch_id}");
        return Ok(Some(format!("dry-run:{}", hex::encode(&bcs::to_bytes(&tx)?[..8]))));
    }

    let digest = ctx.sui.execute_transaction(&tx_bytes, &sig).await?;
    info!(digest, epoch_id, "epoch_settle submitted");
    Ok(Some(digest))
}

/// `epoch_open` — creates a fresh per-epoch Predict oracle then rolls the epoch.
///
/// Each 60-second epoch needs its own oracle (expiry = now + window_epoch_ms)
/// because a Predict oracle settles exactly once. The keeper holds AdminCap and
/// OracleSVICap to mint oracles on-demand.
///
/// Two PTBs are required:
///   PTB-1: `registry::create_oracle` — shares the oracle, returns its ID via event.
///   PTB-2: `oracle::activate` + `oracle::update_prices` + `oracle::update_svi`
///           + `windows::roll_epoch` — all referencing the now-known oracle ID.
async fn epoch_open(ctx: &KeeperContext, payload: &Value) -> Result<String> {
    let window_book_id  = ctx.cfg.window_book_id.as_deref().context("WINDOW_BOOK_ID not set")?;
    let predict_pkg_str = ctx.cfg.predict_package_id.as_deref().context("PREDICT_PACKAGE_ID not set")?;
    let registry_id     = ctx.cfg.registry_id.as_deref().context("REGISTRY_ID not set")?;
    let admin_cap_id    = ctx.cfg.admin_cap_id.as_deref().context("ADMIN_CAP_ID not set")?;
    let oracle_cap_id   = ctx.cfg.keeper_oracle_cap_id.as_deref().context("KEEPER_ORACLE_CAP_ID not set")?;
    let predict_obj_id  = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let min_strike      = ctx.cfg.window_min_strike;
    let tick_size       = ctx.cfg.window_tick_size;
    let cerida_pkg      = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;
    let predict_pkg     = parse_object_id(predict_pkg_str)?;
    let quote_type      = parse_type_tag(&ctx.cfg.quote_coin_type)?;

    let strikes: Vec<u64> = payload
        .get("strikes")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_u64()).collect())
        .filter(|v: &Vec<u64>| !v.is_empty())
        .context("epoch_open: 'strikes' must be a non-empty u64 array")?;

    let now_ms    = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let expiry_ms = now_ms + ctx.cfg.window_epoch_ms;

    // ── PTB-1: create the oracle ─────────────────────────────────────────────
    // Fetch admin_cap and oracle_cap as owned object refs.
    let (ac_id, ac_ver, ac_dig) = ctx.sui.get_object_ref(admin_cap_id).await?;
    let (oc_id, oc_ver, oc_dig) = ctx.sui.get_object_ref(oracle_cap_id).await?;

    let decode_digest = |b64: &str| -> Result<[u8; 32]> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64)?;
        let mut arr = [0u8; 32];
        arr[..bytes.len().min(32)].copy_from_slice(&bytes[..bytes.len().min(32)]);
        Ok(arr)
    };

    let mut ptb1 = PtbBuilder::new();
    let registry_arg  = add_shared(&mut ptb1, &ctx.sui, registry_id, true).await?;
    let predict_arg   = add_shared(&mut ptb1, &ctx.sui, predict_obj_id, true).await?;
    let admin_cap_arg = ptb1.owned(parse_object_id(&ac_id)?, ac_ver, crate::sui_tx::ObjectDigest(decode_digest(&ac_dig)?));
    let oracle_cap_arg = ptb1.owned(parse_object_id(&oc_id)?, oc_ver, crate::sui_tx::ObjectDigest(decode_digest(&oc_dig)?));
    let asset_arg     = ptb1.pure_string("BTC");
    let expiry_arg1   = ptb1.pure_u64(expiry_ms);
    let min_strike_arg = ptb1.pure_u64(min_strike);
    let tick_arg      = ptb1.pure_u64(tick_size);
    ptb1.move_call(
        predict_pkg.clone(),
        "registry",
        "create_oracle",
        vec![],
        vec![registry_arg, predict_arg, admin_cap_arg, oracle_cap_arg, asset_arg, expiry_arg1, min_strike_arg, tick_arg],
    );

    let d1 = submit(ctx, ptb1).await?;
    info!(digest = %d1, expiry_ms, "registry::create_oracle submitted");

    // Parse the new oracle ID from the OracleCreated event in the executed tx.
    let oracle_id_new: String = {
        let effects = ctx.sui.get_tx_effects(&d1).await?;
        effects
            .pointer("/events")
            .and_then(Value::as_array)
            .and_then(|evts| {
                evts.iter().find(|e| {
                    e.pointer("/type").and_then(Value::as_str)
                        .map(|t| t.ends_with("::registry::OracleCreated"))
                        .unwrap_or(false)
                })
            })
            .and_then(|e| e.pointer("/parsedJson/oracle_id"))
            .and_then(Value::as_str)
            .context("OracleCreated event not found in effects")?
            .to_string()
    };
    info!(oracle_id = %oracle_id_new, "new oracle created");

    // ── PTB-2: activate + feed + roll ────────────────────────────────────────
    // Re-fetch the oracle cap (version/digest changed after PTB-1).
    let (oc_id2, oc_ver2, oc_dig2) = ctx.sui.get_object_ref(oracle_cap_id).await?;
    // Re-fetch admin cap.
    let (ac_id2, ac_ver2, ac_dig2) = ctx.sui.get_object_ref(admin_cap_id).await?;

    let mut ptb2 = PtbBuilder::new();
    let oracle_arg2    = add_shared(&mut ptb2, &ctx.sui, &oracle_id_new, true).await?;
    let book_arg       = add_shared(&mut ptb2, &ctx.sui, window_book_id, true).await?;
    let clk_arg        = clock_arg(&mut ptb2);
    let cap2           = ptb2.owned(parse_object_id(&oc_id2)?, oc_ver2, crate::sui_tx::ObjectDigest(decode_digest(&oc_dig2)?));
    let admin_cap2     = ptb2.owned(parse_object_id(&ac_id2)?, ac_ver2, crate::sui_tx::ObjectDigest(decode_digest(&ac_dig2)?));
    let registry_arg2  = add_shared(&mut ptb2, &ctx.sui, registry_id, true).await?;

    // register_oracle_cap so our cap is authorized for this new oracle.
    ptb2.move_call(predict_pkg.clone(), "registry", "register_oracle_cap",
        vec![], vec![oracle_arg2, admin_cap2, cap2]);

    // activate.
    ptb2.move_call(predict_pkg.clone(), "oracle", "activate",
        vec![], vec![oracle_arg2, cap2, clk_arg]);

    // update_prices — pre-compute all args before the chained call.
    let spot = ptb2.pure_u64(63_000_000_000_000u64); // $63k placeholder
    let prices_arg = ptb2.move_call_result(
        predict_pkg.clone(), "oracle", "new_price_data", vec![], vec![spot, spot]);
    ptb2.move_call(predict_pkg.clone(), "oracle", "update_prices",
        vec![], vec![oracle_arg2, cap2, prices_arg, clk_arg]);

    // update_svi — pre-compute each pure arg individually.
    let a_arg    = ptb2.pure_u64(40_000_000u64);
    let b_arg    = ptb2.pure_u64(100_000_000u64);
    let rho_val  = ptb2.pure_u64(300_000_000u64);
    let rho_neg_b = ptb2.pure_bool(true);
    let rho_neg  = ptb2.move_call_result(
        predict_pkg.clone(), "i64", "from_parts", vec![], vec![rho_val, rho_neg_b]);
    let m_val    = ptb2.pure_u64(0u64);
    let m_neg_b  = ptb2.pure_bool(false);
    let m_zero   = ptb2.move_call_result(
        predict_pkg.clone(), "i64", "from_parts", vec![], vec![m_val, m_neg_b]);
    let sigma    = ptb2.pure_u64(100_000_000u64);
    let svi_arg  = ptb2.move_call_result(
        predict_pkg.clone(), "oracle", "new_svi_params",
        vec![], vec![a_arg, b_arg, rho_neg, m_zero, sigma]);
    ptb2.move_call(predict_pkg.clone(), "oracle", "update_svi",
        vec![], vec![oracle_arg2, cap2, svi_arg, clk_arg]);

    // roll_epoch.
    let oracle_id_bytes: [u8; 32] = parse_object_id(&oracle_id_new)?.0;
    let oracle_id_arg  = ptb2.pure_address(oracle_id_bytes);
    let expiry_arg2    = ptb2.pure_u64(expiry_ms);
    let strikes_arg    = ptb2.pure_u64_vec(&strikes);
    ptb2.move_call(cerida_pkg, "windows", "roll_epoch",
        vec![quote_type], vec![book_arg, oracle_id_arg, expiry_arg2, strikes_arg, clk_arg]);

    let d2 = submit(ctx, ptb2).await?;
    info!(digest = %d2, epoch_expiry_ms = expiry_ms, oracle_id = %oracle_id_new, "epoch rolled");

    // Self-schedule next epoch_open just before this one expires.
    let delay_secs =
        (ctx.cfg.window_epoch_ms / 1000).saturating_sub(ctx.cfg.window_epoch_lead_secs as u64) as i64;
    let next_payload = serde_json::json!({ "strikes": strikes });
    crate::db::schedule_job(
        &ctx.pool, "window_lifecycle", "epoch_open", 30, delay_secs, next_payload,
    ).await?;

    Ok(d2)
}

/// `vault::execute_combo_mint` for all legs of a combo (one per leg_index 0..leg_count).
/// All legs may span different oracles — we batch by oracle in separate PTBs;
/// this function executes one PTB per unique oracle in the combo.
async fn combo_execute_mints(ctx: &KeeperContext, payload: &Value) -> Result<String> {
    let vault_id = ctx.cfg.vault_id.as_deref().context("VAULT_ID not set")?;
    let predict_id = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let manager_id = str_field(payload, "manager_id")?;
    let combo_id = u64_field(payload, "combo_id")?;
    let leg_count = u64_field(payload, "leg_count")?;
    let quote_type = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    // Per-leg oracle ids — either an array in the payload or a single oracle for all legs.
    let per_leg_oracles: Vec<String> = payload
        .get("oracle_ids")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| {
            let default = payload
                .get("oracle_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            vec![default; leg_count as usize]
        });

    let mut by_oracle: std::collections::HashMap<String, Vec<u64>> = Default::default();
    for (leg_index, oracle) in per_leg_oracles.iter().enumerate().take(leg_count as usize) {
        by_oracle.entry(oracle.clone()).or_default().push(leg_index as u64);
    }

    let mut last_digest = String::new();
    for (oracle_id, leg_indices) in by_oracle {
        let mut ptb = PtbBuilder::new();
        let vault_arg   = add_shared(&mut ptb, &ctx.sui, vault_id, true).await?;
        let manager_arg = add_shared(&mut ptb, &ctx.sui, manager_id, true).await?;
        let predict_arg = add_shared(&mut ptb, &ctx.sui, predict_id, true).await?;
        let oracle_arg  = add_shared(&mut ptb, &ctx.sui, &oracle_id, false).await?;
        let clock_arg   = clock_arg(&mut ptb);

        for leg_index in leg_indices {
            let combo_id_arg  = ptb.pure_u64(combo_id);
            let leg_index_arg = ptb.pure_u64(leg_index);
            ptb.move_call(
                package.clone(),
                "vault",
                "execute_combo_mint",
                vec![quote_type.clone()],
                vec![vault_arg.clone(), manager_arg.clone(), predict_arg.clone(), oracle_arg.clone(), combo_id_arg, leg_index_arg, clock_arg.clone()],
            );
        }

        last_digest = submit(ctx, ptb).await?;
    }

    Ok(last_digest)
}

/// `vault::settle_combo_leg` for a single leg. The scheduler queues one job
/// per leg per oracle at or after expiry.
async fn combo_settle_leg(ctx: &KeeperContext, payload: &Value) -> Result<String> {
    let vault_id = ctx.cfg.vault_id.as_deref().context("VAULT_ID not set")?;
    let predict_id = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let manager_id = str_field(payload, "manager_id")?;
    let oracle_id  = str_field(payload, "oracle_id")?;
    let combo_id   = u64_field(payload, "combo_id")?;
    let leg_index  = u64_field(payload, "leg_index")?;
    let quote_type = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    let mut ptb = PtbBuilder::new();
    let vault_arg     = add_shared(&mut ptb, &ctx.sui, vault_id, true).await?;
    let manager_arg   = add_shared(&mut ptb, &ctx.sui, manager_id, true).await?;
    let predict_arg   = add_shared(&mut ptb, &ctx.sui, predict_id, true).await?;
    let oracle_arg    = add_shared(&mut ptb, &ctx.sui, oracle_id, false).await?;
    let clock_arg     = clock_arg(&mut ptb);
    let combo_id_arg  = ptb.pure_u64(combo_id);
    let leg_index_arg = ptb.pure_u64(leg_index);

    ptb.move_call(
        package,
        "vault",
        "settle_combo_leg",
        vec![quote_type],
        vec![vault_arg, manager_arg, predict_arg, oracle_arg, combo_id_arg, leg_index_arg, clock_arg],
    );

    submit(ctx, ptb).await
}

/// `vault::execute_position_exit` — tries to trigger a TP/SL exit.
/// If the condition isn't met yet, re-queues itself with a 30s delay and returns Ok(None).
async fn monitor_position(ctx: &KeeperContext, payload: &Value) -> Result<Option<String>> {
    let vault_id    = ctx.cfg.vault_id.as_deref().context("VAULT_ID not set")?;
    let predict_id  = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let manager_id  = str_field(payload, "manager_id")?;
    let oracle_id   = str_field(payload, "oracle_id")?;
    let position_id = u64_field(payload, "position_id")?;
    let quote_type  = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package     = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    let mut ptb = PtbBuilder::new();
    let vault_arg       = add_shared(&mut ptb, &ctx.sui, vault_id, true).await?;
    let manager_arg     = add_shared(&mut ptb, &ctx.sui, manager_id, true).await?;
    let predict_arg     = add_shared(&mut ptb, &ctx.sui, predict_id, true).await?;
    let oracle_arg      = add_shared(&mut ptb, &ctx.sui, oracle_id, false).await?;
    let clock_arg       = clock_arg(&mut ptb);
    let position_id_arg = ptb.pure_u64(position_id);

    ptb.move_call(
        package,
        "vault",
        "execute_position_exit",
        vec![quote_type],
        vec![vault_arg, manager_arg, predict_arg, oracle_arg, position_id_arg, clock_arg],
    );

    // Attempt dry-run to check whether condition is met before submitting.
    let key_str     = ctx.cfg.keeper_private_key.as_deref().context("KEEPER_PRIVATE_KEY not set")?;
    let signing_key = load_signing_key(key_str)?;
    let keeper_addr = address_of(&signing_key);
    let keeper_addr_hex = format!("0x{}", hex::encode(keeper_addr.0));
    let gas_price   = ctx.sui.get_reference_gas_price().await.unwrap_or(1_000);
    let budget      = ctx.cfg.gas_budget.min(MAX_GAS_BUDGET);
    let coins       = ctx.sui.get_coins(&keeper_addr_hex, "0x2::sui::SUI").await?;
    let gas_coin    = coins.first().context("keeper has no SUI gas coins")?;
    let gas_ref     = coin_to_ref(gas_coin)?;

    let tx = crate::sui_tx::TransactionData::V1(crate::sui_tx::TransactionDataV1 {
        kind: crate::sui_tx::TransactionKind::ProgrammableTransaction(ptb.finish()),
        sender: keeper_addr.clone(),
        gas_data: crate::sui_tx::GasData {
            payment: vec![gas_ref],
            owner: keeper_addr.clone(),
            price: gas_price,
            budget,
        },
        expiration: crate::sui_tx::TransactionExpiration::None,
    });

    let (tx_bytes_b64, sig_b64) = crate::sui_tx::sign_transaction(&signing_key, &tx)?;

    match ctx.sui.dry_run_transaction(&tx_bytes_b64).await {
        Ok(result) => {
            let status = result.effects.pointer("/status/status").and_then(Value::as_str).unwrap_or("?");
            if status != "success" {
                let err = result.effects.pointer("/status/error").and_then(Value::as_str).unwrap_or("unknown");
                if err.contains("EConditionNotMet") || err.contains("12") {
                    // Condition not met yet — re-queue and treat as no-op.
                    warn!(position_id, "TP/SL condition not met, re-queuing in 30s");
                    let reschedule = serde_json::json!({
                        "vault_id":    vault_id,
                        "position_id": position_id,
                        "oracle_id":   oracle_id,
                        "manager_id":  manager_id,
                    });
                    crate::db::schedule_job(&ctx.pool, "risk_executor", "monitor_position", 60, 30, reschedule).await?;
                    return Ok(None);
                }
                bail!("dry-run failed: {err}");
            }
        }
        Err(e) => bail!("dry-run RPC error: {e}"),
    }

    if ctx.cfg.keeper_dry_run {
        info!("dry-run mode: execute_position_exit built and verified but NOT submitted");
        return Ok(Some(format!("dry-run:{}", hex::encode(&bcs::to_bytes(&tx)?[..8]))));
    }

    let digest = ctx.sui.execute_transaction(&tx_bytes_b64, &sig_b64).await?;
    info!(digest, position_id, "execute_position_exit submitted");
    Ok(Some(digest))
}

/// Polls a leverage position for liquidation or force-close eligibility.
///
/// Tries `leverage::liquidate` first (captures the liquidation penalty), then
/// falls back to `leverage::force_close` (no penalty — close semantics).
/// Re-queues itself with a 30 s delay when neither condition is met yet.
async fn leverage_monitor(ctx: &KeeperContext, payload: &Value) -> Result<Option<String>> {
    let predict_id  = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let pool_id     = ctx.cfg.margin_pool_id.as_deref().context("MARGIN_POOL_ID not set")?;
    let book_id     = ctx.cfg.leverage_book_id.as_deref().context("LEVERAGE_BOOK_ID not set")?;
    let oracle_id   = str_field(payload, "oracle_id")?;
    let position_id = u64_field(payload, "position_id")?;
    let quote_type  = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package     = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    // Gas setup — fetched once, reused across both dry-run attempts.
    let key_str         = ctx.cfg.keeper_private_key.as_deref().context("KEEPER_PRIVATE_KEY not set")?;
    let signing_key     = load_signing_key(key_str)?;
    let keeper_addr     = address_of(&signing_key);
    let keeper_addr_hex = format!("0x{}", hex::encode(keeper_addr.0));
    let gas_price       = ctx.sui.get_reference_gas_price().await.unwrap_or(1_000);
    let budget          = ctx.cfg.gas_budget.min(MAX_GAS_BUDGET);
    let coins           = ctx.sui.get_coins(&keeper_addr_hex, "0x2::sui::SUI").await?;
    let gas_coin        = coins.first().context("keeper has no SUI gas coins")?;
    let gas_ref         = coin_to_ref(gas_coin)?;

    // ── 1. Try liquidate ─────────────────────────────────────────────────────
    let mut ptb = PtbBuilder::new();
    let pool_arg        = add_shared(&mut ptb, &ctx.sui, pool_id, true).await?;
    let book_arg        = add_shared(&mut ptb, &ctx.sui, book_id, true).await?;
    let predict_arg     = add_shared(&mut ptb, &ctx.sui, predict_id, false).await?;
    let oracle_arg      = add_shared(&mut ptb, &ctx.sui, oracle_id, false).await?;
    let clk_arg         = clock_arg(&mut ptb);
    let position_id_arg = ptb.pure_u64(position_id);
    ptb.move_call(
        package.clone(),
        "leverage",
        "liquidate",
        vec![quote_type.clone()],
        vec![pool_arg, book_arg, predict_arg, oracle_arg, position_id_arg, clk_arg],
    );
    let tx_liq = crate::sui_tx::TransactionData::V1(crate::sui_tx::TransactionDataV1 {
        kind: crate::sui_tx::TransactionKind::ProgrammableTransaction(ptb.finish()),
        sender: keeper_addr.clone(),
        gas_data: crate::sui_tx::GasData {
            payment: vec![gas_ref.clone()],
            owner: keeper_addr.clone(),
            price: gas_price,
            budget,
        },
        expiration: crate::sui_tx::TransactionExpiration::None,
    });
    let (liq_bytes, liq_sig) = crate::sui_tx::sign_transaction(&signing_key, &tx_liq)?;

    let liquidate_ok = match ctx.sui.dry_run_transaction(&liq_bytes).await {
        Ok(result) => {
            let status = result.effects.pointer("/status/status").and_then(Value::as_str).unwrap_or("?");
            if status == "success" {
                true
            } else {
                let err = result.effects.pointer("/status/error").and_then(Value::as_str).unwrap_or("unknown");
                if err.contains("does not exist") || err.contains("NotFound") {
                    info!(position_id, "leverage position gone, stopping monitor");
                    return Ok(None);
                }
                // ENotLiquidatable (4) — position is healthy, try force_close instead.
                if err.contains("ENotLiquidatable") || err.contains(", 4)") {
                    false
                } else {
                    bail!("liquidate dry-run failed: {err}");
                }
            }
        }
        Err(e) => bail!("liquidate dry-run RPC error: {e}"),
    };

    if liquidate_ok {
        if ctx.cfg.keeper_dry_run {
            info!("dry-run mode: leverage::liquidate verified but NOT submitted for position {position_id}");
            return Ok(Some(format!("dry-run:{}", hex::encode(&bcs::to_bytes(&tx_liq)?[..8]))));
        }
        let digest = ctx.sui.execute_transaction(&liq_bytes, &liq_sig).await?;
        info!(digest, position_id, "leverage::liquidate submitted");
        return Ok(Some(digest));
    }

    // ── 2. Try force_close ───────────────────────────────────────────────────
    let mut ptb2 = PtbBuilder::new();
    let pool_arg2        = add_shared(&mut ptb2, &ctx.sui, pool_id, true).await?;
    let book_arg2        = add_shared(&mut ptb2, &ctx.sui, book_id, true).await?;
    let predict_arg2     = add_shared(&mut ptb2, &ctx.sui, predict_id, false).await?;
    let oracle_arg2      = add_shared(&mut ptb2, &ctx.sui, oracle_id, false).await?;
    let clk_arg2         = clock_arg(&mut ptb2);
    let position_id_arg2 = ptb2.pure_u64(position_id);
    ptb2.move_call(
        package,
        "leverage",
        "force_close",
        vec![quote_type],
        vec![pool_arg2, book_arg2, predict_arg2, oracle_arg2, position_id_arg2, clk_arg2],
    );
    let tx_fc = crate::sui_tx::TransactionData::V1(crate::sui_tx::TransactionDataV1 {
        kind: crate::sui_tx::TransactionKind::ProgrammableTransaction(ptb2.finish()),
        sender: keeper_addr.clone(),
        gas_data: crate::sui_tx::GasData {
            payment: vec![gas_ref],
            owner: keeper_addr.clone(),
            price: gas_price,
            budget,
        },
        expiration: crate::sui_tx::TransactionExpiration::None,
    });
    let (fc_bytes, fc_sig) = crate::sui_tx::sign_transaction(&signing_key, &tx_fc)?;

    match ctx.sui.dry_run_transaction(&fc_bytes).await {
        Ok(result) => {
            let status = result.effects.pointer("/status/status").and_then(Value::as_str).unwrap_or("?");
            if status == "success" {
                if ctx.cfg.keeper_dry_run {
                    info!("dry-run mode: leverage::force_close verified but NOT submitted for position {position_id}");
                    return Ok(Some(format!("dry-run:{}", hex::encode(&bcs::to_bytes(&tx_fc)?[..8]))));
                }
                let digest = ctx.sui.execute_transaction(&fc_bytes, &fc_sig).await?;
                info!(digest, position_id, "leverage::force_close submitted");
                return Ok(Some(digest));
            }
            let err = result.effects.pointer("/status/error").and_then(Value::as_str).unwrap_or("unknown");
            if err.contains("does not exist") || err.contains("NotFound") {
                info!(position_id, "leverage position gone, stopping monitor");
                return Ok(None);
            }
            // EForceWindowNotReached (9) — too early, re-queue with 30 s delay.
            if err.contains("EForceWindowNotReached") || err.contains(", 9)") {
                warn!(position_id, "leverage position healthy, re-queuing monitor in 30s");
                crate::db::schedule_job(
                    &ctx.pool, "risk_executor", "leverage_monitor", 60, 30, payload.clone(),
                ).await?;
                return Ok(None);
            }
            bail!("force_close dry-run failed: {err}");
        }
        Err(e) => bail!("force_close dry-run RPC error: {e}"),
    }
}
