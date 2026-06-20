// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Unified gateway to DeepBook Predict.
///
/// Every product that needs a Predict write (mint / redeem) routes through here
/// because `PredictManager` owner-gates every mutation:
///   `ctx.sender() == manager.owner()` — only the keeper satisfies this.
///
/// Flow for every product:
///   User  →  request_*(vault, …, payment)   escrow funds, emit intent
///   Keeper → execute_*(vault, manager, predict, …)  mint on Predict, open position
///
/// Windows capital model (market-maker):
///   User pays basis = svi_ask + spread + skew.
///   svi_ask  → keeper mints Predict range position via manager.
///   spread+skew → WindowBook LP pool (pure LP revenue, no outcome risk).
///   At settlement: keeper redeems Predict position, deposits payout into
///   vault.settlements[epoch_id]. Users claim permissionlessly from there.
module cerida::vault;

use cerida::{
    intent::{Self, Intent},
    leverage::{Self, MarginPool, LeverageBook},
    position_token::{Self, PositionToken},
    windows::{Self, WindowBook},
};
use deepbook_predict::{
    market_key,
    oracle::{Self, OracleSVI},
    predict::{Self, Predict},
    predict_manager::PredictManager,
    range_key,
};
use sui::{
    balance::{Self, Balance},
    clock::Clock,
    coin::{Self, Coin},
    event,
    table::{Self, Table},
};

// === Errors ===
const EZeroQuantity: u64 = 0;
const EZeroEscrow: u64 = 1;
const ENotKeeper: u64 = 2;
const ESlippageExceeded: u64 = 3;
const EWrongManager: u64 = 4;
const EWrongVault: u64 = 5;
const EInvalidRedeemQty: u64 = 6;
const EEpochNotSettled: u64 = 7;
const EWrongBook: u64 = 8;
const EPayoutAlreadyExecuted: u64 = 9;
/// Live price exceeds the user's max_cost limit — keeper should retry later.
const ELimitNotMet: u64 = 10;
/// Only the intent's original user may cancel it.
const ENotIntentOwner: u64 = 11;

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
    max_cost: u64,
}

public struct MintCancelled has copy, drop {
    vault_id: ID,
    intent_id: u64,
    user: address,
    refunded: u64,
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

public struct LeverageOpenRequested has copy, drop {
    vault_id: ID,
    intent_id: u64,
    user: address,
    oracle_id: ID,
    expiry: u64,
    is_range: bool,
    qty: u64,
    escrowed: u64,
}

public struct LeverageOpenExecuted has copy, drop {
    vault_id: ID,
    intent_id: u64,
    user: address,
    position_id: u64,
    basis: u64,
}

public struct WindowBetRequested has copy, drop {
    vault_id: ID,
    intent_id: u64,
    user: address,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    escrowed: u64,
}

public struct WindowBetExecuted has copy, drop {
    vault_id: ID,
    intent_id: u64,
    user: address,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    svi_ask: u64,
    total_basis: u64,
}

public struct EpochPayoutExecuted has copy, drop {
    vault_id: ID,
    epoch_id: u64,
    payout: u64,
    winning_band: Option<u64>,
}

public struct WindowBetClaimed has copy, drop {
    vault_id: ID,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    payout: u64,
    owner: address,
}

// === Structs ===

public struct CeridaVault<phantom Quote> has key {
    id: UID,
    manager_id: ID,
    keeper: address,
    /// User funds escrowed awaiting keeper execution.
    escrow: Balance<Quote>,
    intents: Table<u64, Intent>,
    next_intent_id: u64,
    redeems: Table<u64, RedeemTicket>,
    next_redeem_id: u64,
    /// epoch_id → payout balance from Predict redemption, ready for user claims.
    settlements: Table<u64, Balance<Quote>>,
}

public struct RedeemTicket has store {
    user: address,
    token: PositionToken,
}

// === Lifecycle ===

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
        settlements: table::new(ctx),
    };
    let vault_id = object::id(&vault);
    event::emit(VaultCreated { vault_id, manager_id, keeper: ctx.sender() });
    transfer::share_object(vault);
    manager_id
}

// ── Predict-direct (binary / range mint) ──────────────────────────────────────

/// Place a binary mint intent. `max_cost` caps the execution price per qty
/// contracts (0 = market order, fill at any price up to `escrowed`).
/// If the live ask exceeds `max_cost` at execution time the keeper aborts with
/// ELimitNotMet and retries later; the escrow stays safe in the vault.
public fun request_mint_binary<Quote>(
    vault: &mut CeridaVault<Quote>,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    qty: u64,
    max_cost: u64,
    payment: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = payment.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);
    vault.escrow.join(payment.into_balance());
    let user = ctx.sender();
    let intent = intent::new_predict_binary(user, oracle_id, expiry, strike, is_up, qty, escrowed, max_cost);
    let intent_id = record_intent(vault, intent);
    event::emit(MintRequested { vault_id: object::id(vault), intent_id, user, oracle_id, expiry, is_range: false, qty, escrowed, max_cost });
    intent_id
}

/// Place a range mint intent with an optional price limit (0 = market order).
public fun request_mint_range<Quote>(
    vault: &mut CeridaVault<Quote>,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    qty: u64,
    max_cost: u64,
    payment: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = payment.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);
    vault.escrow.join(payment.into_balance());
    let user = ctx.sender();
    let intent = intent::new_predict_range(user, oracle_id, expiry, lower, higher, qty, escrowed, max_cost);
    let intent_id = record_intent(vault, intent);
    event::emit(MintRequested { vault_id: object::id(vault), intent_id, user, oracle_id, expiry, is_range: true, qty, escrowed, max_cost });
    intent_id
}

/// Cancel an unfilled mint intent and recover the escrowed funds.
/// Only the original user may cancel their own intent.
public fun cancel_mint_intent<Quote>(
    vault: &mut CeridaVault<Quote>,
    intent_id: u64,
    ctx: &mut TxContext,
) {
    assert!(vault.intents[intent_id].user() == ctx.sender(), ENotIntentOwner);
    let i = vault.intents.remove(intent_id);
    let (user, escrowed) = intent::destroy(i);
    if (escrowed > 0) {
        transfer::public_transfer(vault.escrow.split(escrowed).into_coin(ctx), user);
    };
    event::emit(MintCancelled { vault_id: object::id(vault), intent_id, user, refunded: escrowed });
}

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

    // Peek the limit BEFORE removing the intent so the escrow stays safe on abort.
    let max_cost = vault.intents[intent_id].max_cost();
    if (max_cost > 0) {
        let qty = vault.intents[intent_id].qty();
        let oracle_id = vault.intents[intent_id].oracle_id();
        let expiry = vault.intents[intent_id].expiry();
        let is_range = vault.intents[intent_id].is_range();
        let preview = if (is_range) {
            let lower = vault.intents[intent_id].lower();
            let higher = vault.intents[intent_id].higher();
            let key = range_key::new(oracle_id, expiry, lower, higher);
            let (ask, _) = predict::get_range_trade_amounts(predict, oracle, key, qty, clock);
            ask
        } else {
            let strike = vault.intents[intent_id].strike();
            let is_up_v = vault.intents[intent_id].is_up();
            let key = market_key::new(oracle_id, expiry, strike, is_up_v);
            let (ask, _) = predict::get_trade_amounts(predict, oracle, key, qty, clock);
            ask
        };
        assert!(preview <= max_cost, ELimitNotMet);
    };

    let i = vault.intents.remove(intent_id);
    let user = i.user();
    let oracle_id = i.oracle_id();
    let expiry = i.expiry();
    let qty = i.qty();
    let escrowed = i.escrowed();
    let is_range = i.is_range();
    let (strike, is_up_v, lower, higher) = extract_key_fields(&i);
    intent::destroy(i);

    let funds = vault.escrow.split(escrowed);
    manager.deposit(funds.into_coin(ctx), ctx);

    let before = manager.balance<Quote>();
    if (is_range) {
        let key = range_key::new(oracle_id, expiry, lower, higher);
        predict::mint_range<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    } else {
        let key = market_key::new(oracle_id, expiry, strike, is_up_v);
        predict::mint<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    };
    let cost = before - manager.balance<Quote>();
    assert!(cost <= escrowed, ESlippageExceeded);

    let refunded = escrowed - cost;
    if (refunded > 0) {
        transfer::public_transfer(manager.withdraw<Quote>(refunded, ctx), user);
    };

    let vault_id = object::id(vault);
    let token = if (is_range) {
        position_token::new_range(vault_id, oracle_id, expiry, lower, higher, qty, ctx)
    } else {
        position_token::new_binary(vault_id, oracle_id, expiry, strike, is_up_v, qty, ctx)
    };
    transfer::public_transfer(token, user);
    event::emit(MintExecuted { vault_id, intent_id, user, qty, cost, refunded });
}

// ── Predict-direct redeem ─────────────────────────────────────────────────────

#[allow(lint(self_transfer))]
public fun request_redeem<Quote>(
    vault: &mut CeridaVault<Quote>,
    token: PositionToken,
    qty: u64,
    ctx: &mut TxContext,
): u64 {
    assert!(token.vault_id() == object::id(vault), EWrongVault);
    let full = token.qty();
    assert!(qty > 0 && qty <= full, EInvalidRedeemQty);
    let mut token = token;
    if (qty < full) {
        let remainder = position_token::split(&mut token, full - qty, ctx);
        transfer::public_transfer(remainder, ctx.sender());
    };
    let user = ctx.sender();
    let redeem_id = vault.next_redeem_id;
    vault.next_redeem_id = redeem_id + 1;
    vault.redeems.add(redeem_id, RedeemTicket { user, token });
    event::emit(RedeemRequested { vault_id: object::id(vault), redeem_id, user, qty });
    redeem_id
}

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
    let is_up_v = token.is_up();
    let lower = token.lower();
    let higher = token.higher();

    let before = manager.balance<Quote>();
    if (is_range) {
        let key = range_key::new(oracle_id, expiry, lower, higher);
        predict::redeem_range<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    } else {
        let key = market_key::new(oracle_id, expiry, strike, is_up_v);
        predict::redeem<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    };
    let payout = manager.balance<Quote>() - before;
    let is_settled = oracle::is_settled(oracle);
    if (payout > 0) {
        transfer::public_transfer(manager.withdraw<Quote>(payout, ctx), user);
    };
    position_token::burn(token);
    event::emit(RedeemExecuted { vault_id: object::id(vault), redeem_id, user, qty, payout, is_settled });
}

// ── Leverage ──────────────────────────────────────────────────────────────────

public fun request_leverage_binary<Quote>(
    vault: &mut CeridaVault<Quote>,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    qty: u64,
    maint_bps: u64,
    tp_value: u64,
    sl_value: u64,
    margin: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = margin.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);
    vault.escrow.join(margin.into_balance());
    let user = ctx.sender();
    let intent = intent::new_leverage_binary(user, oracle_id, expiry, strike, is_up, qty, escrowed, maint_bps, tp_value, sl_value);
    let intent_id = record_intent(vault, intent);
    event::emit(LeverageOpenRequested { vault_id: object::id(vault), intent_id, user, oracle_id, expiry, is_range: false, qty, escrowed });
    intent_id
}

public fun request_leverage_range<Quote>(
    vault: &mut CeridaVault<Quote>,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    qty: u64,
    maint_bps: u64,
    tp_value: u64,
    sl_value: u64,
    margin: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = margin.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);
    vault.escrow.join(margin.into_balance());
    let user = ctx.sender();
    let intent = intent::new_leverage_range(user, oracle_id, expiry, lower, higher, qty, escrowed, maint_bps, tp_value, sl_value);
    let intent_id = record_intent(vault, intent);
    event::emit(LeverageOpenRequested { vault_id: object::id(vault), intent_id, user, oracle_id, expiry, is_range: true, qty, escrowed });
    intent_id
}

/// Keeper executes a leverage open:
///   1. Reads live Predict ask as the basis for the Turbo Ticket.
///   2. Mints the Predict position as a protocol hedge (funded from user's escrow).
///   3. Opens the Turbo Ticket with remaining escrowed margin.
public fun execute_leverage_open<Quote>(
    vault: &mut CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
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
    let maint_bps = i.maint_bps();
    let tp_value = i.tp_value();
    let sl_value = i.sl_value();
    let (strike, is_up_v, lower, higher) = extract_key_fields(&i);
    intent::destroy(i);

    let basis = if (is_range) {
        let key = range_key::new(oracle_id, expiry, lower, higher);
        let (ask, _) = predict::get_range_trade_amounts(predict, oracle, key, qty, clock);
        ask
    } else {
        let key = market_key::new(oracle_id, expiry, strike, is_up_v);
        let (ask, _) = predict::get_trade_amounts(predict, oracle, key, qty, clock);
        ask
    };

    // Fund the Predict hedge position from escrow, then open the ticket with remaining margin.
    let hedge_funds = vault.escrow.split(basis);
    manager.deposit(hedge_funds.into_coin(ctx), ctx);
    if (is_range) {
        let key = range_key::new(oracle_id, expiry, lower, higher);
        predict::mint_range<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    } else {
        let key = market_key::new(oracle_id, expiry, strike, is_up_v);
        predict::mint<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    };

    let margin_coin = vault.escrow.split(escrowed - basis).into_coin(ctx);
    let position_id = leverage::open_ticket(
        pool, book, user, basis,
        oracle_id, expiry, is_range, strike, is_up_v, lower, higher,
        margin_coin, qty, maint_bps, tp_value, sl_value, clock, ctx,
    );

    event::emit(LeverageOpenExecuted { vault_id: object::id(vault), intent_id, user, position_id, basis });
}

// ── Windows ───────────────────────────────────────────────────────────────────

public fun request_window_bet<Quote>(
    vault: &mut CeridaVault<Quote>,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    payment: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = payment.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);
    vault.escrow.join(payment.into_balance());
    let user = ctx.sender();
    let intent = intent::new_window_bet(user, epoch_id, band_idx, qty, escrowed);
    let intent_id = record_intent(vault, intent);
    event::emit(WindowBetRequested { vault_id: object::id(vault), intent_id, user, epoch_id, band_idx, qty, escrowed });
    intent_id
}

/// Keeper executes a window bet:
///   1. Prices the bet via windows::compute_bet_price → (svi_ask, total_basis).
///   2. Deducts svi_ask from escrow → funds Predict range mint via manager.
///   3. Deducts (total_basis - svi_ask) from escrow → LP revenue → WindowBook pool.
///   4. Refunds (escrowed - total_basis) slippage buffer back to user.
///   5. Calls windows::record_bet → issues BetTicket to user.
public fun execute_window_bet<Quote>(
    vault: &mut CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    book: &mut WindowBook<Quote>,
    intent_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper, ENotKeeper);
    assert!(object::id(manager) == vault.manager_id, EWrongManager);

    let i = vault.intents.remove(intent_id);
    let user = i.user();
    let epoch_id = i.epoch_id();
    let band_idx = i.band_idx();
    let qty = i.qty();
    let escrowed = i.escrowed();
    intent::destroy(i);

    let (oracle_id, expiry, lower, higher) = windows::epoch_band_range(book, epoch_id, band_idx);
    let key = range_key::new(oracle_id, expiry, lower, higher);

    let (svi_ask, total_basis) = windows::compute_bet_price(book, predict, oracle, epoch_id, band_idx, qty, clock);
    assert!(total_basis <= escrowed, ESlippageExceeded);

    // svi_ask → Predict range mint (pool of Predict contracts, funds winning payouts)
    let predict_funds = vault.escrow.split(svi_ask);
    manager.deposit(predict_funds.into_coin(ctx), ctx);
    predict::mint_range<Quote>(predict, manager, oracle, key, qty, clock, ctx);

    // spread+skew → LP pool revenue
    let lp_revenue = vault.escrow.split(total_basis - svi_ask).into_coin(ctx);

    // Refund unused slippage buffer
    let change_amt = escrowed - total_basis;
    if (change_amt > 0) {
        transfer::public_transfer(vault.escrow.split(change_amt).into_coin(ctx), user);
    };

    let ticket = windows::record_bet(book, epoch_id, band_idx, qty, svi_ask, total_basis, lp_revenue, clock, ctx);
    transfer::public_transfer(ticket, user);

    event::emit(WindowBetExecuted {
        vault_id: object::id(vault),
        intent_id,
        user,
        epoch_id,
        band_idx,
        qty,
        svi_ask,
        total_basis,
    });
}

/// Keeper redeems the winning band's Predict position after epoch settlement.
/// Payout is stored in vault.settlements[epoch_id] for permissionless user claims.
/// For a losing epoch (no winning band or no contracts on winning band), a zero
/// balance is stored to mark the epoch as payout-executed.
public fun execute_epoch_payout<Quote>(
    vault: &mut CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    book: &WindowBook<Quote>,
    epoch_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper, ENotKeeper);
    assert!(object::id(manager) == vault.manager_id, EWrongManager);
    assert!(windows::epoch_settled(book, epoch_id), EEpochNotSettled);
    assert!(!vault.settlements.contains(epoch_id), EPayoutAlreadyExecuted);

    let winning = windows::epoch_winning_band(book, epoch_id);
    let payout_balance = if (winning.is_some()) {
        let band_idx = *winning.borrow();
        let total_qty = windows::epoch_band_qty(book, epoch_id, band_idx);
        if (total_qty > 0) {
            let (oracle_id, expiry, lower, higher) = windows::epoch_band_range(book, epoch_id, band_idx);
            let key = range_key::new(oracle_id, expiry, lower, higher);
            let before = manager.balance<Quote>();
            predict::redeem_range<Quote>(predict, manager, oracle, key, total_qty, clock, ctx);
            let redeemed = manager.balance<Quote>() - before;
            manager.withdraw<Quote>(redeemed, ctx).into_balance()
        } else {
            balance::zero()
        }
    } else {
        balance::zero()
    };

    let payout = payout_balance.value();
    vault.settlements.add(epoch_id, payout_balance);

    event::emit(EpochPayoutExecuted {
        vault_id: object::id(vault),
        epoch_id,
        payout,
        winning_band: winning,
    });
}

/// Permissionless claim — anyone may claim their own BetTicket after the keeper
/// has run execute_epoch_payout for that epoch.
public fun claim_window_bet<Quote>(
    vault: &mut CeridaVault<Quote>,
    book: &WindowBook<Quote>,
    ticket: windows::BetTicket,
    ctx: &mut TxContext,
) {
    let (book_id, epoch_id, band_idx, qty) = windows::consume_ticket(ticket);
    assert!(book_id == object::id(book), EWrongBook);
    assert!(vault.settlements.contains(epoch_id), EEpochNotSettled);

    let winning = windows::epoch_winning_band(book, epoch_id);
    let user = ctx.sender();

    let payout = if (winning == option::some(band_idx)) {
        let settlement = &mut vault.settlements[epoch_id];
        let available = settlement.value();
        let amount = available.min(qty);
        settlement.split(amount)
    } else {
        balance::zero()
    };

    let payout_amount = payout.value();
    if (payout_amount > 0) {
        transfer::public_transfer(payout.into_coin(ctx), user);
    } else {
        balance::destroy_zero(payout);
    };

    event::emit(WindowBetClaimed {
        vault_id: object::id(vault),
        epoch_id,
        band_idx,
        qty,
        payout: payout_amount,
        owner: user,
    });
}

// ── Getters ───────────────────────────────────────────────────────────────────

public fun manager_id<Quote>(vault: &CeridaVault<Quote>): ID { vault.manager_id }
public fun keeper<Quote>(vault: &CeridaVault<Quote>): address { vault.keeper }
public fun escrow_value<Quote>(vault: &CeridaVault<Quote>): u64 { vault.escrow.value() }
public fun has_intent<Quote>(vault: &CeridaVault<Quote>, intent_id: u64): bool { vault.intents.contains(intent_id) }
public fun borrow_intent<Quote>(vault: &CeridaVault<Quote>, intent_id: u64): &Intent { &vault.intents[intent_id] }
public fun has_settlement<Quote>(vault: &CeridaVault<Quote>, epoch_id: u64): bool { vault.settlements.contains(epoch_id) }
public fun settlement_balance<Quote>(vault: &CeridaVault<Quote>, epoch_id: u64): u64 { vault.settlements[epoch_id].value() }

// ── Package helpers ───────────────────────────────────────────────────────────

public(package) fun record_intent<Quote>(vault: &mut CeridaVault<Quote>, intent: Intent): u64 {
    let intent_id = vault.next_intent_id;
    vault.next_intent_id = intent_id + 1;
    vault.intents.add(intent_id, intent);
    intent_id
}

// ── Private helpers ───────────────────────────────────────────────────────────

fun extract_key_fields(i: &Intent): (u64, bool, u64, u64) {
    if (i.is_range()) {
        (0, false, i.lower(), i.higher())
    } else {
        (i.strike(), i.is_up(), 0, 0)
    }
}
