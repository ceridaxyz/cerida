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
use tracing::{debug, info};

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
}

impl KeeperContext {
    pub fn new(sui: SuiRpcClient, cfg: Config) -> Self {
        Self { sui, cfg }
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
    let vault_id = ctx.cfg.vault_id.as_deref().context("VAULT_ID not set")?;
    let predict_id = ctx.cfg.predict_object_id.as_deref().context("PREDICT_OBJECT_ID not set")?;
    let window_book_id = ctx.cfg.window_book_id.as_deref().context("WINDOW_BOOK_ID not set")?;
    let epoch_id = u64_field(payload, "epoch_id")?;
    let manager_id = str_field(payload, "manager_id")?;
    let oracle_id = str_field(payload, "oracle_id")?;
    let quote_type = parse_type_tag(&ctx.cfg.quote_coin_type)?;
    let package = parse_object_id(
        ctx.cfg.cerida_package_id.as_deref().context("CERIDA_PACKAGE_ID not set")?,
    )?;

    let mut ptb = PtbBuilder::new();
    let vault_arg = add_shared(&mut ptb, &ctx.sui, vault_id, true).await?;
    let manager_arg = add_shared(&mut ptb, &ctx.sui, manager_id, true).await?;
    let predict_arg = add_shared(&mut ptb, &ctx.sui, predict_id, true).await?;
    let oracle_arg = add_shared(&mut ptb, &ctx.sui, oracle_id, false).await?;
    // window_book is passed as immutable reference in execute_epoch_payout
    let book_arg = add_shared(&mut ptb, &ctx.sui, window_book_id, false).await?;
    let clock_arg = clock_arg(&mut ptb);
    let epoch_id_arg = ptb.pure_u64(epoch_id);

    ptb.move_call(
        package,
        "vault",
        "execute_epoch_payout",
        vec![quote_type],
        vec![vault_arg, manager_arg, predict_arg, oracle_arg, book_arg, epoch_id_arg, clock_arg],
    );

    submit(ctx, ptb).await
}
