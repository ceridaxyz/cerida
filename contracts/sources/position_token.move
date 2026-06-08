// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// A transferable claim on a Predict position custodied inside a `CeridaVault`'s
/// PredictManager. Predict positions are rows in the manager's table, not
/// objects, so they can't be transferred directly — this token is the portable
/// claim that the vault issues on mint and burns on redeem.
module cerida::position_token;

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
