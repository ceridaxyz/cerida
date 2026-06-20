// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// All pending keeper intents. Every user action that needs Predict writes is
/// recorded here with a compact kind tag. This deliberately avoids Move enum
/// bytecode so local Sui publish verification accepts the package.
module cerida::intent;

const KIND_PREDICT_BINARY: u8 = 0;
const KIND_PREDICT_RANGE: u8 = 1;
const KIND_LEVERAGE_BINARY: u8 = 2;
const KIND_LEVERAGE_RANGE: u8 = 3;
const KIND_WINDOW_BET: u8 = 4;

public struct Intent has store {
    kind: u8,
    user: address,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    lower: u64,
    higher: u64,
    qty: u64,
    escrowed: u64,
    /// Maximum cost the user will accept per execution. 0 = market order (no limit).
    /// Only meaningful for KIND_PREDICT_BINARY and KIND_PREDICT_RANGE.
    max_cost: u64,
    maint_bps: u64,
    tp_value: u64,
    sl_value: u64,
    epoch_id: u64,
    band_idx: u64,
}

// === Shared getters ===

public fun user(intent: &Intent): address {
    intent.user
}

public fun escrowed(intent: &Intent): u64 {
    intent.escrowed
}

public fun qty(intent: &Intent): u64 {
    intent.qty
}

public fun is_range(intent: &Intent): bool {
    intent.kind == KIND_PREDICT_RANGE || intent.kind == KIND_LEVERAGE_RANGE
}

// === Predict/Leverage shared getters ===

public fun oracle_id(intent: &Intent): ID {
    assert!(intent.kind != KIND_WINDOW_BET, 0);
    intent.oracle_id
}

public fun expiry(intent: &Intent): u64 {
    assert!(intent.kind != KIND_WINDOW_BET, 0);
    intent.expiry
}

public fun strike(intent: &Intent): u64 {
    assert!(intent.kind == KIND_PREDICT_BINARY || intent.kind == KIND_LEVERAGE_BINARY, 0);
    intent.strike
}

public fun is_up(intent: &Intent): bool {
    assert!(intent.kind == KIND_PREDICT_BINARY || intent.kind == KIND_LEVERAGE_BINARY, 0);
    intent.is_up
}

public fun lower(intent: &Intent): u64 {
    assert!(intent.kind == KIND_PREDICT_RANGE || intent.kind == KIND_LEVERAGE_RANGE, 0);
    intent.lower
}

public fun higher(intent: &Intent): u64 {
    assert!(intent.kind == KIND_PREDICT_RANGE || intent.kind == KIND_LEVERAGE_RANGE, 0);
    intent.higher
}

/// Maximum cost limit for predict intents. 0 = no limit (market order).
public fun max_cost(intent: &Intent): u64 {
    assert!(intent.kind == KIND_PREDICT_BINARY || intent.kind == KIND_PREDICT_RANGE, 0);
    intent.max_cost
}

// === Leverage-only getters ===

public fun maint_bps(intent: &Intent): u64 {
    assert!(intent.kind == KIND_LEVERAGE_BINARY || intent.kind == KIND_LEVERAGE_RANGE, 0);
    intent.maint_bps
}

public fun tp_value(intent: &Intent): u64 {
    assert!(intent.kind == KIND_LEVERAGE_BINARY || intent.kind == KIND_LEVERAGE_RANGE, 0);
    intent.tp_value
}

public fun sl_value(intent: &Intent): u64 {
    assert!(intent.kind == KIND_LEVERAGE_BINARY || intent.kind == KIND_LEVERAGE_RANGE, 0);
    intent.sl_value
}

// === WindowBet-only getters ===

public fun epoch_id(intent: &Intent): u64 {
    assert!(intent.kind == KIND_WINDOW_BET, 0);
    intent.epoch_id
}

public fun band_idx(intent: &Intent): u64 {
    assert!(intent.kind == KIND_WINDOW_BET, 0);
    intent.band_idx
}

// === Package constructors ===

public(package) fun new_predict_binary(
    user: address, oracle_id: ID, expiry: u64,
    strike: u64, is_up: bool, qty: u64, escrowed: u64, max_cost: u64,
): Intent {
    new_intent(KIND_PREDICT_BINARY, user, oracle_id, expiry, strike, is_up, 0, 0, qty, escrowed, max_cost, 0, 0, 0, 0, 0)
}

public(package) fun new_predict_range(
    user: address, oracle_id: ID, expiry: u64,
    lower: u64, higher: u64, qty: u64, escrowed: u64, max_cost: u64,
): Intent {
    new_intent(KIND_PREDICT_RANGE, user, oracle_id, expiry, 0, false, lower, higher, qty, escrowed, max_cost, 0, 0, 0, 0, 0)
}

public(package) fun new_leverage_binary(
    user: address, oracle_id: ID, expiry: u64,
    strike: u64, is_up: bool, qty: u64, escrowed: u64,
    maint_bps: u64, tp_value: u64, sl_value: u64,
): Intent {
    new_intent(KIND_LEVERAGE_BINARY, user, oracle_id, expiry, strike, is_up, 0, 0, qty, escrowed, 0, maint_bps, tp_value, sl_value, 0, 0)
}

public(package) fun new_leverage_range(
    user: address, oracle_id: ID, expiry: u64,
    lower: u64, higher: u64, qty: u64, escrowed: u64,
    maint_bps: u64, tp_value: u64, sl_value: u64,
): Intent {
    new_intent(KIND_LEVERAGE_RANGE, user, oracle_id, expiry, 0, false, lower, higher, qty, escrowed, 0, maint_bps, tp_value, sl_value, 0, 0)
}

public(package) fun new_window_bet(
    user: address, epoch_id: u64, band_idx: u64, qty: u64, escrowed: u64,
): Intent {
    new_intent(KIND_WINDOW_BET, user, @0x0.to_id(), 0, 0, false, 0, 0, qty, escrowed, 0, 0, 0, 0, epoch_id, band_idx)
}

public(package) fun destroy(intent: Intent): (address, u64) {
    let Intent {
        kind: _,
        user,
        oracle_id: _,
        expiry: _,
        strike: _,
        is_up: _,
        lower: _,
        higher: _,
        qty: _,
        escrowed,
        max_cost: _,
        maint_bps: _,
        tp_value: _,
        sl_value: _,
        epoch_id: _,
        band_idx: _,
    } = intent;
    (user, escrowed)
}

fun new_intent(
    kind: u8,
    user: address,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    lower: u64,
    higher: u64,
    qty: u64,
    escrowed: u64,
    max_cost: u64,
    maint_bps: u64,
    tp_value: u64,
    sl_value: u64,
    epoch_id: u64,
    band_idx: u64,
): Intent {
    Intent {
        kind,
        user,
        oracle_id,
        expiry,
        strike,
        is_up,
        lower,
        higher,
        qty,
        escrowed,
        max_cost,
        maint_bps,
        tp_value,
        sl_value,
        epoch_id,
        band_idx,
    }
}
