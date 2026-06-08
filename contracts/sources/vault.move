// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Custodial vault over DeepBook Predict.
///
/// `predict-testnet-4-16` has no delegation — every manager op asserts
/// `ctx.sender() == manager.owner()` — so positions can't be self-custodied or
/// minted into a shared manager by arbitrary users. Cerida therefore operates
/// one PredictManager (owned by a `keeper`) and brokers access:
///   * users escrow quote into the vault via `request_mint` (their own tx),
///   * the keeper later runs the Predict mint and issues a `PositionToken`
///     claim back to the user (Phase 2, `execute_mint`).
///
/// The escrowed amount is also the slippage cap: execution reverts if Predict's
/// realized cost exceeds it.
module cerida::vault;

use cerida::{intent::{Self, Intent}, position_token::{Self, PositionToken}};
use deepbook_predict::{
    market_key,
    oracle::OracleSVI,
    predict::{Self, Predict},
    predict_manager::PredictManager,
    range_key
};
use sui::{balance::{Self, Balance}, clock::Clock, coin::Coin, event, table::{Self, Table}};

// === Errors ===
const EZeroQuantity: u64 = 0;
const EZeroEscrow: u64 = 1;
/// Caller is not the vault keeper (also the PredictManager owner).
const ENotKeeper: u64 = 2;
/// Realized Predict cost exceeded the user's escrowed slippage cap.
const ESlippageExceeded: u64 = 3;
/// The passed manager is not the one this vault custodies.
const EWrongManager: u64 = 4;
/// The token was issued by a different vault.
const EWrongVault: u64 = 5;

// === Events ===

public struct VaultCreated has copy, drop {
    vault_id: ID,
    manager_id: ID,
    keeper: address,
}

public struct MintRequested has copy, drop {
    vault_id: ID,
    intent_id: u64,
    user: address,
    oracle_id: ID,
    expiry: u64,
    is_range: bool,
    qty: u64,
    escrowed: u64,
}

public struct MintExecuted has copy, drop {
    vault_id: ID,
    intent_id: u64,
    user: address,
    qty: u64,
    cost: u64,
    refunded: u64,
}

public struct RedeemRequested has copy, drop {
    vault_id: ID,
    redeem_id: u64,
    user: address,
    qty: u64,
}

public struct RedeemExecuted has copy, drop {
    vault_id: ID,
    redeem_id: u64,
    user: address,
    qty: u64,
    payout: u64,
    is_settled: bool,
}

// === Structs ===

/// One Cerida vault, generic over the Predict quote asset (dUSDC on testnet).
public struct CeridaVault<phantom Quote> has key {
    id: UID,
    /// The PredictManager this vault custodies trades through (owned by `keeper`).
    manager_id: ID,
    /// The only address allowed to run keeper-side execution; also the manager owner.
    keeper: address,
    /// Quote escrowed by users awaiting keeper execution.
    escrow: Balance<Quote>,
    /// Pending mint requests, keyed by a monotonic id.
    intents: Table<u64, Intent>,
    next_intent_id: u64,
    /// Tokens escrowed for redemption, keyed by a monotonic id.
    redeems: Table<u64, RedeemTicket>,
    next_redeem_id: u64,
}

/// A PositionToken escrowed by its holder, awaiting keeper redemption.
public struct RedeemTicket has store {
    user: address,
    token: PositionToken,
}

// === Public Functions ===

/// Create the vault and its backing PredictManager. The caller becomes the
/// keeper and the manager owner, so this must be run by Cerida's keeper address.
public fun create<Quote>(ctx: &mut TxContext): ID {
    let manager_id = predict::create_manager(ctx);
    let vault = CeridaVault<Quote> {
        id: object::new(ctx),
        manager_id,
        keeper: ctx.sender(),
        escrow: balance::zero(),
        intents: table::new(ctx),
        next_intent_id: 0,
        redeems: table::new(ctx),
        next_redeem_id: 0,
    };
    let vault_id = object::id(&vault);
    event::emit(VaultCreated { vault_id, manager_id, keeper: ctx.sender() });
    transfer::share_object(vault);
    manager_id
}

/// Escrow quote and record a binary mint request. `strike` is any `u64`
/// (continuous strikes); the escrowed coin value is the slippage cap. Returns
/// the intent id the keeper will execute against.
public fun request_mint_binary<Quote>(
    vault: &mut CeridaVault<Quote>,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    qty: u64,
    payment: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = payment.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);

    vault.escrow.join(payment.into_balance());
    let user = ctx.sender();
    let intent = intent::new_binary(user, oracle_id, expiry, strike, is_up, qty, escrowed);
    let intent_id = record_intent(vault, intent);

    event::emit(MintRequested {
        vault_id: object::id(vault),
        intent_id,
        user,
        oracle_id,
        expiry,
        is_range: false,
        qty,
        escrowed,
    });
    intent_id
}

/// Escrow quote and record a vertical-range mint request `(lower, higher]`.
public fun request_mint_range<Quote>(
    vault: &mut CeridaVault<Quote>,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    qty: u64,
    payment: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = payment.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);

    vault.escrow.join(payment.into_balance());
    let user = ctx.sender();
    let intent = intent::new_range(user, oracle_id, expiry, lower, higher, qty, escrowed);
    let intent_id = record_intent(vault, intent);

    event::emit(MintRequested {
        vault_id: object::id(vault),
        intent_id,
        user,
        oracle_id,
        expiry,
        is_range: true,
        qty,
        escrowed,
    });
    intent_id
}

/// Keeper-side execution of a pending mint. Deposits the escrow into the
/// manager, runs the Predict mint (binary or range), enforces the slippage cap
/// (escrow ≥ realized cost) atomically, refunds any surplus, and issues the
/// `PositionToken` claim to the original requester.
///
/// Must be called by the keeper — who is also the manager owner, which is what
/// lets `predict::mint`/`mint_range` (owner-gated) succeed.
public fun execute_mint<Quote>(
    vault: &mut CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    intent_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper, ENotKeeper);
    assert!(object::id(manager) == vault.manager_id, EWrongManager);

    let i = vault.intents.remove(intent_id);
    let user = i.user();
    let oracle_id = i.oracle_id();
    let expiry = i.expiry();
    let qty = i.qty();
    let escrowed = i.escrowed();
    let is_range = i.is_range();
    let strike = i.strike();
    let is_up = i.is_up();
    let lower = i.lower();
    let higher = i.higher();
    intent::destroy(i);

    // Fund the manager from escrow, then mint. Cost is the manager balance drop
    // across the mint call (commingled funds elsewhere don't move during it).
    let funds = vault.escrow.split(escrowed);
    manager.deposit(funds.into_coin(ctx), ctx);

    let before = manager.balance<Quote>();
    if (is_range) {
        let key = range_key::new(oracle_id, expiry, lower, higher);
        predict::mint_range<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    } else {
        let key = if (is_up) market_key::up(oracle_id, expiry, strike)
        else market_key::down(oracle_id, expiry, strike);
        predict::mint<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    };
    let cost = before - manager.balance<Quote>();
    assert!(cost <= escrowed, ESlippageExceeded);

    // Refund the unspent escrow back to the user.
    let refunded = escrowed - cost;
    if (refunded > 0) {
        transfer::public_transfer(manager.withdraw<Quote>(refunded, ctx), user);
    };

    let vault_id = object::id(vault);
    let token = if (is_range) {
        position_token::new_range(vault_id, oracle_id, expiry, lower, higher, qty, ctx)
    } else {
        position_token::new_binary(vault_id, oracle_id, expiry, strike, is_up, qty, ctx)
    };
    transfer::public_transfer(token, user);

    event::emit(MintExecuted { vault_id, intent_id, user, qty, cost, refunded });
}

/// Escrow a PositionToken for redemption. The keeper settles it via
/// `execute_redeem`. Returns the redeem id.
public fun request_redeem<Quote>(
    vault: &mut CeridaVault<Quote>,
    token: PositionToken,
    ctx: &TxContext,
): u64 {
    assert!(token.vault_id() == object::id(vault), EWrongVault);
    let user = ctx.sender();
    let qty = token.qty();
    let redeem_id = vault.next_redeem_id;
    vault.next_redeem_id = redeem_id + 1;
    vault.redeems.add(redeem_id, RedeemTicket { user, token });
    event::emit(RedeemRequested { vault_id: object::id(vault), redeem_id, user, qty });
    redeem_id
}

/// Keeper-side redemption. Sells the underlying position on Predict (binary or
/// range — Predict pays settled `$1·qty` or the live bid internally), forwards
/// the whole payout to the original holder, and burns the token.
public fun execute_redeem<Quote>(
    vault: &mut CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    redeem_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper, ENotKeeper);
    assert!(object::id(manager) == vault.manager_id, EWrongManager);

    let RedeemTicket { user, token } = vault.redeems.remove(redeem_id);
    let oracle_id = token.oracle_id();
    let expiry = token.expiry();
    let qty = token.qty();
    let is_range = token.is_range();
    let strike = token.strike();
    let is_up = token.is_up();
    let lower = token.lower();
    let higher = token.higher();

    let before = manager.balance<Quote>();
    if (is_range) {
        let key = range_key::new(oracle_id, expiry, lower, higher);
        predict::redeem_range<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    } else {
        let key = if (is_up) market_key::up(oracle_id, expiry, strike)
        else market_key::down(oracle_id, expiry, strike);
        predict::redeem<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    };
    let payout = manager.balance<Quote>() - before;
    let is_settled = oracle.is_settled();

    if (payout > 0) {
        transfer::public_transfer(manager.withdraw<Quote>(payout, ctx), user);
    };
    position_token::burn(token);

    event::emit(RedeemExecuted { vault_id: object::id(vault), redeem_id, user, qty, payout, is_settled });
}

// === Getters ===

public fun manager_id<Quote>(vault: &CeridaVault<Quote>): ID { vault.manager_id }

public fun keeper<Quote>(vault: &CeridaVault<Quote>): address { vault.keeper }

public fun escrow_value<Quote>(vault: &CeridaVault<Quote>): u64 { vault.escrow.value() }

public fun has_intent<Quote>(vault: &CeridaVault<Quote>, intent_id: u64): bool {
    vault.intents.contains(intent_id)
}

public fun borrow_intent<Quote>(vault: &CeridaVault<Quote>, intent_id: u64): &Intent {
    &vault.intents[intent_id]
}

// === Package Functions ===

/// Insert an intent under the next id and return that id.
public(package) fun record_intent<Quote>(vault: &mut CeridaVault<Quote>, intent: Intent): u64 {
    let intent_id = vault.next_intent_id;
    vault.next_intent_id = intent_id + 1;
    vault.intents.add(intent_id, intent);
    intent_id
}
