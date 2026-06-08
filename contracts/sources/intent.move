// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// A pending mint request escrowed by a user, awaiting keeper execution.
/// The keeper reads it, runs the Predict mint, and issues a PositionToken.
/// `escrowed` doubles as the slippage cap: execution reverts if the realized
/// cost exceeds it.
module cerida::intent;

/// One escrowed mint request. `is_range` selects the meaningful fields:
///   binary → (strike, is_up);  range → (lower, higher).
public struct Intent has store {
    user: address,
    oracle_id: ID,
    expiry: u64,
    is_range: bool,
    strike: u64,
    is_up: bool,
    lower: u64,
    higher: u64,
    qty: u64,
    escrowed: u64,
}

// === Getters ===

public fun user(intent: &Intent): address { intent.user }

public fun oracle_id(intent: &Intent): ID { intent.oracle_id }

public fun expiry(intent: &Intent): u64 { intent.expiry }

public fun is_range(intent: &Intent): bool { intent.is_range }

public fun strike(intent: &Intent): u64 { intent.strike }

public fun is_up(intent: &Intent): bool { intent.is_up }

public fun lower(intent: &Intent): u64 { intent.lower }

public fun higher(intent: &Intent): u64 { intent.higher }

public fun qty(intent: &Intent): u64 { intent.qty }

public fun escrowed(intent: &Intent): u64 { intent.escrowed }

// === Package Functions ===

public(package) fun new_binary(
    user: address,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    qty: u64,
    escrowed: u64,
): Intent {
    Intent {
        user,
        oracle_id,
        expiry,
        is_range: false,
        strike,
        is_up,
        lower: 0,
        higher: 0,
        qty,
        escrowed,
    }
}

public(package) fun new_range(
    user: address,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    qty: u64,
    escrowed: u64,
): Intent {
    Intent {
        user,
        oracle_id,
        expiry,
        is_range: true,
        strike: 0,
        is_up: false,
        lower,
        higher,
        qty,
        escrowed,
    }
}

public(package) fun destroy(intent: Intent): (address, u64) {
    let Intent { user, escrowed, .. } = intent;
    (user, escrowed)
}
