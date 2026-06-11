// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// A transferable claim on a Predict position custodied inside a `CeridaVault`'s
/// PredictManager. Predict positions are rows in the manager's table, not
/// objects, so they can't be transferred directly — this token is the portable
/// claim that the vault issues on mint and burns on redeem.
module cerida::position_token;

// === Errors ===
/// Tried to merge two tokens that claim different positions.
const EKeyMismatch: u64 = 0;
/// Split amount is zero or not strictly less than the token's quantity.
const EInvalidQty: u64 = 1;

/// Claim on a single Predict position (binary or vertical range).
/// `is_range` selects which fields are meaningful:
///   binary → (strike, is_up);  range → (lower, higher).
public struct PositionToken has key, store {
    id: UID,
    /// The CeridaVault that custodies the underlying position.
    vault_id: ID,
    oracle_id: ID,
    expiry: u64,
    is_range: bool,
    strike: u64,
    is_up: bool,
    lower: u64,
    higher: u64,
    qty: u64,
}

// === Getters ===

public fun vault_id(token: &PositionToken): ID { token.vault_id }

public fun oracle_id(token: &PositionToken): ID { token.oracle_id }

public fun expiry(token: &PositionToken): u64 { token.expiry }

public fun is_range(token: &PositionToken): bool { token.is_range }

public fun strike(token: &PositionToken): u64 { token.strike }

public fun is_up(token: &PositionToken): bool { token.is_up }

public fun lower(token: &PositionToken): u64 { token.lower }

public fun higher(token: &PositionToken): u64 { token.higher }

public fun qty(token: &PositionToken): u64 { token.qty }

// === Fungibility ===
//
// Positions are fungible by key: two tokens claiming the identical position
// (same vault, oracle, expiry and binary/range key) are interchangeable, and a
// single token can be split. This is pure Cerida-side accounting — Predict only
// ever tracks the aggregate per-key quantity in the manager, so splitting or
// merging claims here never touches the underlying position.

/// True when two tokens claim the identical position key (so they're fungible).
/// Sentinel fields (the unused half of each kind) are zeroed, so comparing all
/// of them is correct for both binary and range tokens.
public fun same_key(a: &PositionToken, b: &PositionToken): bool {
    a.vault_id == b.vault_id &&
    a.oracle_id == b.oracle_id &&
    a.expiry == b.expiry &&
    a.is_range == b.is_range &&
    a.strike == b.strike &&
    a.is_up == b.is_up &&
    a.lower == b.lower &&
    a.higher == b.higher
}

/// Split `amount` contracts off into a new token, reducing this one by the same.
/// Lets a holder sell or transfer part of a position. `amount` must be in
/// `(0, qty)` — a full split is just keeping the original token.
public fun split(token: &mut PositionToken, amount: u64, ctx: &mut TxContext): PositionToken {
    assert!(amount > 0 && amount < token.qty, EInvalidQty);
    token.qty = token.qty - amount;
    PositionToken {
        id: object::new(ctx),
        vault_id: token.vault_id,
        oracle_id: token.oracle_id,
        expiry: token.expiry,
        is_range: token.is_range,
        strike: token.strike,
        is_up: token.is_up,
        lower: token.lower,
        higher: token.higher,
        qty: amount,
    }
}

/// Merge `other` into `token`; their quantities add. Both must claim the exact
/// same position key. `other` is consumed.
public fun merge(token: &mut PositionToken, other: PositionToken) {
    assert!(same_key(token, &other), EKeyMismatch);
    let PositionToken { id, qty, .. } = other;
    token.qty = token.qty + qty;
    id.delete();
}

// === Package Functions ===

/// Mint a binary claim. Only the vault module issues tokens.
public(package) fun new_binary(
    vault_id: ID,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    qty: u64,
    ctx: &mut TxContext,
): PositionToken {
    PositionToken {
        id: object::new(ctx),
        vault_id,
        oracle_id,
        expiry,
        is_range: false,
        strike,
        is_up,
        lower: 0,
        higher: 0,
        qty,
    }
}

/// Mint a range claim. Only the vault module issues tokens.
public(package) fun new_range(
    vault_id: ID,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    qty: u64,
    ctx: &mut TxContext,
): PositionToken {
    PositionToken {
        id: object::new(ctx),
        vault_id,
        oracle_id,
        expiry,
        is_range: true,
        strike: 0,
        is_up: false,
        lower,
        higher,
        qty,
    }
}

/// Destroy a token once its underlying position has been redeemed.
public(package) fun burn(token: PositionToken) {
    let PositionToken { id, .. } = token;
    id.delete();
}
