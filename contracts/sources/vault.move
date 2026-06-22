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
    combo::{Self, ComboTableKey},
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
    bcs,
    clock::Clock,
    coin::{Self, Coin},
    event,
    table::{Self, Table},
    transfer,
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
const EConditionNotMet: u64 = 12;

// === Events ===

/// Emitted whenever LP net exposure changes for a (oracle, expiry, strike/range) key.
/// yes_qty / no_qty are running totals after this mint or redeem.
/// For range keys, no_qty is always 0 (no natural complement).
public struct ExposureChanged has copy, drop {
    vault_id: ID,
    key:      vector<u8>,
    yes_qty:  u64,
    no_qty:   u64,
}

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

public struct ComboClaimed has copy, drop {
    vault_id: ID,
    combo_id: u64,
    owner:    address,
    payout:   u64,
}

public struct PositionMonitored has copy, drop {
    vault_id:    ID,
    position_id: u64,
    user:        address,
    oracle_id:   ID,
    expiry:      u64,
    qty:         u64,
    tp_value:    u64,
    sl_value:    u64,
}

public struct PositionExited has copy, drop {
    vault_id:    ID,
    position_id: u64,
    user:        address,
    qty:         u64,
    payout:      u64,
    hit_tp:      bool,
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
    /// Monotonic counter for combo IDs (combo entries stored as dynamic field).
    next_combo_id: u64,
    /// Positions custodied for TP/SL monitoring.
    positions: Table<u64, PositionTicket>,
    next_position_id: u64,
    /// Net LP exposure per (oracle, expiry, strike/range) BCS key.
    /// LP is naturally hedged when yes_qty == no_qty for any key.
    exposure: Table<vector<u8>, NetExposure>,
}

/// Per-key inventory record. LP is fully hedged when yes_qty == no_qty.
/// Residual imbalance drives inventory-adjusted pricing skew.
public struct NetExposure has store {
    yes_qty: u64,
    no_qty:  u64,
}

public struct RedeemTicket has store {
    user: address,
    token: PositionToken,
}

public struct PositionTicket has store {
    user:     address,
    token:    PositionToken,
    tp_value: u64,
    sl_value: u64,
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
        next_combo_id: 0,
        positions: table::new(ctx),
        next_position_id: 0,
        exposure: table::new(ctx),
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
/// Place a binary mint intent. tp_value / sl_value are bid·qty levels at which
/// the keeper will auto-exit early (0 = hold to expiry, no monitoring).
public fun request_mint_binary<Quote>(
    vault: &mut CeridaVault<Quote>,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    qty: u64,
    max_cost: u64,
    tp_value: u64,
    sl_value: u64,
    payment: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = payment.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);
    vault.escrow.join(payment.into_balance());
    let user = ctx.sender();
    let intent = intent::new_predict_binary(user, oracle_id, expiry, strike, is_up, qty, escrowed, max_cost, tp_value, sl_value);
    let intent_id = record_intent(vault, intent);
    event::emit(MintRequested { vault_id: object::id(vault), intent_id, user, oracle_id, expiry, is_range: false, qty, escrowed, max_cost });
    intent_id
}

/// Place a range mint intent with an optional price limit and TP/SL levels.
/// tp_value / sl_value are bid·qty thresholds for permissionless early exit (0 = disabled).
public fun request_mint_range<Quote>(
    vault: &mut CeridaVault<Quote>,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    qty: u64,
    max_cost: u64,
    tp_value: u64,
    sl_value: u64,
    payment: Coin<Quote>,
    ctx: &TxContext,
): u64 {
    let escrowed = payment.value();
    assert!(qty > 0, EZeroQuantity);
    assert!(escrowed > 0, EZeroEscrow);
    vault.escrow.join(payment.into_balance());
    let user = ctx.sender();
    let intent = intent::new_predict_range(user, oracle_id, expiry, lower, higher, qty, escrowed, max_cost, tp_value, sl_value);
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
    // Read all needed fields before execute_mint_internal destroys the intent.
    let is_lev    = vault.intents[intent_id].is_leverage();
    let tp_value  = if (is_lev) { vault.intents[intent_id].tp_value() } else { 0 };
    let sl_value  = if (is_lev) { vault.intents[intent_id].sl_value() } else { 0 };
    let oracle_id = vault.intents[intent_id].oracle_id();
    let expiry    = vault.intents[intent_id].expiry();
    let is_range  = vault.intents[intent_id].is_range();
    let strike    = if (!is_range) { vault.intents[intent_id].strike() } else { 0 };
    let is_up_v   = if (!is_range) { vault.intents[intent_id].is_up() } else { false };
    let lower     = if (is_range)  { vault.intents[intent_id].lower() }  else { 0 };
    let higher    = if (is_range)  { vault.intents[intent_id].higher() } else { 0 };
    let (token, user, qty, cost, refunded) =
        execute_mint_internal(vault, manager, predict, oracle, intent_id, clock, ctx);
    let vault_id = object::id(vault);
    // Track net LP exposure: YES side = binary-up or any range, NO = binary-down.
    let exp_key = if (is_range) {
        range_exposure_key(oracle_id, expiry, lower, higher)
    } else {
        binary_exposure_key(oracle_id, expiry, strike)
    };
    let (yes_qty, no_qty) = record_exposure(vault, copy exp_key, is_range || is_up_v, qty);
    event::emit(ExposureChanged { vault_id, key: exp_key, yes_qty, no_qty });
    if (tp_value > 0 || sl_value > 0) {
        // Custody token for keeper TP/SL monitoring.
        let position_id = vault.next_position_id;
        vault.next_position_id = position_id + 1;
        vault.positions.add(position_id, PositionTicket { user, token, tp_value, sl_value });
        event::emit(PositionMonitored { vault_id, position_id, user, oracle_id, expiry, qty, tp_value, sl_value });
    } else {
        transfer::public_transfer(token, user);
    };
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
    // Untrack LP exposure on redemption.
    let exp_key = if (is_range) {
        range_exposure_key(oracle_id, expiry, lower, higher)
    } else {
        binary_exposure_key(oracle_id, expiry, strike)
    };
    let (yes_qty, no_qty) = unrecord_exposure(vault, copy exp_key, is_range || is_up_v, qty);
    event::emit(ExposureChanged { vault_id: object::id(vault), key: exp_key, yes_qty, no_qty });
    event::emit(RedeemExecuted { vault_id: object::id(vault), redeem_id, user, qty, payout, is_settled });
}

// ── TP/SL exit for custodied binary/range positions ──────────────────────────

/// Permissionless: anyone may call once the live bid crosses the TP or SL level.
/// Condition is verified on-chain — a healthy position cannot be touched.
/// Redeems the position at the current bid and sends payout to the original owner.
public fun execute_position_exit<Quote>(
    vault: &mut CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(object::id(manager) == vault.manager_id, EWrongManager);
    let pos = &vault.positions[position_id];
    let token = &pos.token;
    let qty = token.qty();

    // Get live bid for the position's key.
    let bid = if (token.is_range()) {
        let key = range_key::new(token.oracle_id(), token.expiry(), token.lower(), token.higher());
        let (_, b) = predict::get_range_trade_amounts(predict, oracle, key, qty, clock);
        b
    } else {
        let key = market_key::new(token.oracle_id(), token.expiry(), token.strike(), token.is_up());
        let (_, b) = predict::get_trade_amounts(predict, oracle, key, qty, clock);
        b
    };

    let tp = pos.tp_value;
    let sl = pos.sl_value;
    let hit_tp = tp > 0 && bid >= tp;
    let hit_sl = sl > 0 && bid <= sl;
    assert!(hit_tp || hit_sl, EConditionNotMet);

    let PositionTicket { user, token, tp_value: _, sl_value: _ } = vault.positions.remove(position_id);
    let oracle_id = token.oracle_id();
    let expiry    = token.expiry();
    let is_range  = token.is_range();
    let strike    = token.strike();
    let is_up_v   = token.is_up();
    let lower     = token.lower();
    let higher    = token.higher();

    let before = manager.balance<Quote>();
    if (is_range) {
        let key = range_key::new(oracle_id, expiry, lower, higher);
        predict::redeem_range<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    } else {
        let key = market_key::new(oracle_id, expiry, strike, is_up_v);
        predict::redeem<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    };
    let payout = manager.balance<Quote>() - before;
    if (payout > 0) {
        transfer::public_transfer(manager.withdraw<Quote>(payout, ctx), user);
    };
    position_token::burn(token);
    // Untrack LP exposure on position exit.
    let exp_key = if (is_range) {
        range_exposure_key(oracle_id, expiry, lower, higher)
    } else {
        binary_exposure_key(oracle_id, expiry, strike)
    };
    let (yes_qty, no_qty) = unrecord_exposure(vault, copy exp_key, is_range || is_up_v, qty);
    event::emit(ExposureChanged { vault_id: object::id(vault), key: exp_key, yes_qty, no_qty });
    event::emit(PositionExited { vault_id: object::id(vault), position_id, user, qty, payout, hit_tp });
}

/// Owner cancels TP/SL monitoring and reclaims their position token directly.
public fun cancel_position_monitoring<Quote>(
    vault: &mut CeridaVault<Quote>,
    position_id: u64,
    ctx: &mut TxContext,
) {
    assert!(vault.positions[position_id].user == ctx.sender(), ENotIntentOwner);
    let PositionTicket { user, token, tp_value: _, sl_value: _ } = vault.positions.remove(position_id);
    transfer::public_transfer(token, user);
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

/// Returns (yes_qty, no_qty) for a binary (oracle, expiry, strike) key.
/// yes_qty = total YES (is_up=true) contracts outstanding, no_qty = total NO.
/// LP is hedged at this key when yes_qty == no_qty.
public fun net_exposure_binary<Quote>(
    vault:    &CeridaVault<Quote>,
    oracle_id: ID,
    expiry:   u64,
    strike:   u64,
): (u64, u64) {
    let key = binary_exposure_key(oracle_id, expiry, strike);
    if (!vault.exposure.contains(key)) return (0, 0);
    let e = &vault.exposure[key];
    (e.yes_qty, e.no_qty)
}

/// Returns total in-range contracts outstanding for a range (oracle, expiry, lower, higher) key.
public fun net_exposure_range<Quote>(
    vault:    &CeridaVault<Quote>,
    oracle_id: ID,
    expiry:   u64,
    lower:    u64,
    higher:   u64,
): u64 {
    let key = range_exposure_key(oracle_id, expiry, lower, higher);
    if (!vault.exposure.contains(key)) return 0;
    vault.exposure[key].yes_qty
}

// ── Package helpers ───────────────────────────────────────────────────────────

public(package) fun record_intent<Quote>(vault: &mut CeridaVault<Quote>, intent: Intent): u64 {
    let intent_id = vault.next_intent_id;
    vault.next_intent_id = intent_id + 1;
    vault.intents.add(intent_id, intent);
    intent_id
}

// ── Combo: multi-leg positions ────────────────────────────────────────────────
//
// A combo groups N binary/range legs into a single entry (stored via dynamic
// field on the vault's UID). Legs share the existing intent→execute_mint path;
// the only difference is the PositionToken is routed into the combo entry
// rather than transferred to the user.
//
// Flow:
//   User:   request_combo(vault, legs, mode, kind, payment, ctx)
//   Keeper: execute_combo_mint(vault, manager, predict, oracle, combo_id, leg_index, clock, ctx)
//           (one call per leg, batched in one PTB per oracle)
//   Keeper: settle_combo_leg(vault, manager, predict, oracle, combo_id, leg_index, clock, ctx)
//           (at each leg's expiry)
//   User:   claim_combo(vault, combo_id, ctx)

/// Represents one leg spec in the request_combo argument vector.
public struct ComboLegInput has copy, drop {
    is_range:  bool,
    oracle_id: ID,
    expiry:    u64,
    strike:    u64,
    lower:     u64,
    higher:    u64,
    is_up:     bool,
    qty:       u64,
    max_cost:  u64,
    escrow:    u64,  // amount split from payment for this leg
}

/// Constructor helpers for ComboLegInput — called by off-chain PTB builders.
public fun binary_leg_input(
    oracle_id: ID, expiry: u64, strike: u64, is_up: bool,
    qty: u64, max_cost: u64, escrow: u64,
): ComboLegInput {
    ComboLegInput { is_range: false, oracle_id, expiry, strike, lower: 0, higher: 0, is_up, qty, max_cost, escrow }
}

public fun range_leg_input(
    oracle_id: ID, expiry: u64, lower: u64, higher: u64,
    qty: u64, max_cost: u64, escrow: u64,
): ComboLegInput {
    ComboLegInput { is_range: true, oracle_id, expiry, strike: 0, lower, higher, is_up: false, qty, max_cost, escrow }
}

/// Submit all leg intents and register the combo in one user transaction.
/// `payment` must cover sum(leg.escrow) for all legs.
/// Returns the combo_id.
public fun request_combo<Quote>(
    vault:   &mut CeridaVault<Quote>,
    legs:    vector<ComboLegInput>,
    mode:    u8,
    kind:    u8,
    payment: Coin<Quote>,
    ctx:     &mut TxContext,
): u64 {
    assert!(legs.length() >= 2, EZeroQuantity);

    let vault_id   = object::id(vault);
    let owner      = ctx.sender();
    let mut combo_legs: vector<combo::ComboLeg> = vector[];
    let mut last_expiry = 0u64;
    let mut payment_mut = payment;

    let mut i = 0u64;
    while (i < legs.length()) {
        let leg = &legs[i];
        assert!(leg.qty > 0, EZeroQuantity);
        assert!(leg.escrow > 0, EZeroEscrow);

        // Split escrow for this leg from the payment coin
        let leg_coin = payment_mut.split(leg.escrow, ctx);
        vault.escrow.join(leg_coin.into_balance());

        // Record intent (same path as request_mint_binary / request_mint_range)
        let intent = if (leg.is_range) {
            intent::new_predict_range(owner, leg.oracle_id, leg.expiry, leg.lower, leg.higher, leg.qty, leg.escrow, leg.max_cost, 0, 0)
        } else {
            intent::new_predict_binary(owner, leg.oracle_id, leg.expiry, leg.strike, leg.is_up, leg.qty, leg.escrow, leg.max_cost, 0, 0)
        };
        let intent_id = record_intent(vault, intent);

        // Build the combo leg record
        let combo_leg = if (leg.is_range) {
            combo::new_range_leg(leg.oracle_id, leg.expiry, leg.lower, leg.higher, leg.qty, intent_id)
        } else {
            combo::new_binary_leg(leg.oracle_id, leg.expiry, leg.strike, leg.is_up, leg.qty, intent_id)
        };
        combo_legs.push_back(combo_leg);

        if (leg.expiry > last_expiry) { last_expiry = leg.expiry };
        i = i + 1;
    };

    // Return any dust left in payment to the user
    if (payment_mut.value() > 0) {
        transfer::public_transfer(payment_mut, owner);
    } else {
        payment_mut.destroy_zero();
    };

    let combo_id = vault.next_combo_id;
    vault.next_combo_id = combo_id + 1;
    combo::create_entry(&mut vault.id, vault_id, owner, mode, kind, combo_legs, last_expiry, combo_id, ctx)
}

/// Descriptor for an existing leverage position that will become a combo leg.
public struct LeverageLegInput has copy, drop {
    position_id: u64,
    oracle_id:   ID,
    expiry:      u64,
    qty:         u64,
}

public fun leverage_leg_input(
    position_id: u64, oracle_id: ID, expiry: u64, qty: u64,
): LeverageLegInput {
    LeverageLegInput { position_id, oracle_id, expiry, qty }
}

/// User: create a combo that mixes Predict (binary/range) legs with existing
/// leverage positions. Predict legs are handled identically to request_combo;
/// leverage legs are locked into the combo (owner cannot close them independently
/// until settle_combo_leverage_leg is called by the keeper).
/// Leverage legs are only allowed in PORTFOLIO mode, not PARLAY.
public fun request_combo_with_leverage<Quote>(
    vault:          &mut CeridaVault<Quote>,
    book:           &mut leverage::LeverageBook<Quote>,
    predict_legs:   vector<ComboLegInput>,
    leverage_legs:  vector<LeverageLegInput>,
    mode:           u8,
    kind:           u8,
    payment:        Coin<Quote>,
    ctx:            &mut TxContext,
): u64 {
    assert!(predict_legs.length() + leverage_legs.length() >= 2, EZeroQuantity);

    let vault_id   = object::id(vault);
    let owner      = ctx.sender();
    let mut combo_legs: vector<combo::ComboLeg> = vector[];
    let mut last_expiry = 0u64;
    let mut payment_mut = payment;

    // Process Predict legs (same as request_combo)
    let mut i = 0u64;
    while (i < predict_legs.length()) {
        let leg = &predict_legs[i];
        assert!(leg.qty > 0, EZeroQuantity);
        assert!(leg.escrow > 0, EZeroEscrow);
        let leg_coin = payment_mut.split(leg.escrow, ctx);
        vault.escrow.join(leg_coin.into_balance());
        let intent = if (leg.is_range) {
            intent::new_predict_range(owner, leg.oracle_id, leg.expiry, leg.lower, leg.higher, leg.qty, leg.escrow, leg.max_cost, 0, 0)
        } else {
            intent::new_predict_binary(owner, leg.oracle_id, leg.expiry, leg.strike, leg.is_up, leg.qty, leg.escrow, leg.max_cost, 0, 0)
        };
        let intent_id = record_intent(vault, intent);
        let combo_leg = if (leg.is_range) {
            combo::new_range_leg(leg.oracle_id, leg.expiry, leg.lower, leg.higher, leg.qty, intent_id)
        } else {
            combo::new_binary_leg(leg.oracle_id, leg.expiry, leg.strike, leg.is_up, leg.qty, intent_id)
        };
        combo_legs.push_back(combo_leg);
        if (leg.expiry > last_expiry) { last_expiry = leg.expiry };
        i = i + 1;
    };

    // Process leverage legs — lock each position into the combo
    let mut j = 0u64;
    while (j < leverage_legs.length()) {
        let leg = &leverage_legs[j];
        leverage::lock_for_combo(book, leg.position_id, owner);
        combo_legs.push_back(combo::new_leverage_leg(leg.oracle_id, leg.expiry, leg.position_id, leg.qty));
        if (leg.expiry > last_expiry) { last_expiry = leg.expiry };
        j = j + 1;
    };

    if (payment_mut.value() > 0) {
        transfer::public_transfer(payment_mut, owner);
    } else {
        payment_mut.destroy_zero();
    };

    let combo_id = vault.next_combo_id;
    vault.next_combo_id = combo_id + 1;
    combo::create_entry(&mut vault.id, vault_id, owner, mode, kind, combo_legs, last_expiry, combo_id, ctx)
}

// ── Combo builder API (PTB-friendly) ─────────────────────────────────────────
// Avoids vector<Struct> arguments which the Sui TypeScript SDK cannot reliably
// pass as pure values. Use begin_combo → add_*_leg (×N) → finalize_combo.

/// Begin a new pending combo. Returns combo_id.
/// Follow with add_binary_leg / add_range_leg / add_leverage_leg (≥ 2 total),
/// then call finalize_combo to activate and emit ComboCreated.
public fun begin_combo<Quote>(
    vault: &mut CeridaVault<Quote>, mode: u8, kind: u8, ctx: &mut TxContext,
): u64 {
    let vault_id = object::id(vault);
    let owner    = ctx.sender();
    let combo_id = vault.next_combo_id;
    vault.next_combo_id = combo_id + 1;
    combo::begin_entry(&mut vault.id, vault_id, owner, mode, kind, combo_id, ctx)
}

/// Add a binary predict leg to a pending combo.
/// The `escrow` coin is absorbed into vault reserves.
public fun add_binary_leg<Quote>(
    vault:     &mut CeridaVault<Quote>,
    combo_id:  u64,
    oracle_id: ID, expiry: u64, strike: u64, is_up: bool,
    qty: u64, max_cost: u64,
    escrow:    Coin<Quote>,
    ctx:       &mut TxContext,
) {
    assert!(qty > 0, EZeroQuantity);
    let escrow_amount = escrow.value();
    assert!(escrow_amount > 0, EZeroEscrow);
    vault.escrow.join(escrow.into_balance());
    let owner     = ctx.sender();
    let intent    = intent::new_predict_binary(owner, oracle_id, expiry, strike, is_up, qty, escrow_amount, max_cost, 0, 0);
    let intent_id = record_intent(vault, intent);
    combo::push_leg(&mut vault.id, combo_id, combo::new_binary_leg(oracle_id, expiry, strike, is_up, qty, intent_id));
}

/// Add a range predict leg to a pending combo.
/// The `escrow` coin is absorbed into vault reserves.
public fun add_range_leg<Quote>(
    vault:     &mut CeridaVault<Quote>,
    combo_id:  u64,
    oracle_id: ID, expiry: u64, lower: u64, higher: u64,
    qty: u64, max_cost: u64,
    escrow:    Coin<Quote>,
    ctx:       &mut TxContext,
) {
    assert!(qty > 0, EZeroQuantity);
    let escrow_amount = escrow.value();
    assert!(escrow_amount > 0, EZeroEscrow);
    vault.escrow.join(escrow.into_balance());
    let owner     = ctx.sender();
    let intent    = intent::new_predict_range(owner, oracle_id, expiry, lower, higher, qty, escrow_amount, max_cost, 0, 0);
    let intent_id = record_intent(vault, intent);
    combo::push_leg(&mut vault.id, combo_id, combo::new_range_leg(oracle_id, expiry, lower, higher, qty, intent_id));
}

/// Add an existing leverage position as a leg to a pending combo (locks the ticket).
public fun add_leverage_leg<Quote>(
    vault:       &mut CeridaVault<Quote>,
    book:        &mut leverage::LeverageBook<Quote>,
    combo_id:    u64,
    position_id: u64, oracle_id: ID, expiry: u64, qty: u64,
    ctx:         &mut TxContext,
) {
    let owner = ctx.sender();
    leverage::lock_for_combo(book, position_id, owner);
    combo::push_leg(&mut vault.id, combo_id, combo::new_leverage_leg(oracle_id, expiry, position_id, qty));
}

/// Finalize a pending combo (validates ≥ 2 legs, PARLAY constraint, etc.).
/// Emits ComboCreated. Returns combo_id for convenience in PTBs.
public fun finalize_combo<Quote>(
    vault:    &mut CeridaVault<Quote>,
    combo_id: u64,
    _ctx:     &mut TxContext,
): u64 {
    let vault_id = object::id(vault);
    combo::finalize_entry(&mut vault.id, vault_id, combo_id);
    combo_id
}

// ─────────────────────────────────────────────────────────────────────────────

/// Keeper: settle a leverage leg inside a combo. Calls leverage::settle_for_combo
/// which transfers equity directly to the position owner, then records the result
/// in the combo entry. Equity is NOT added to the combo's claimable balance —
/// it was already paid — but payout is stored for event/UI tracking.
/// `manager` is only used if this is the final leg (to withdraw accumulated
/// Predict payouts from binary/range legs).
public fun settle_combo_leverage_leg<Quote>(
    vault:     &mut CeridaVault<Quote>,
    manager:   &mut PredictManager,
    pool:      &mut leverage::MarginPool<Quote>,
    book:      &mut leverage::LeverageBook<Quote>,
    predict:   &Predict,
    oracle:    &OracleSVI,
    combo_id:  u64,
    leg_index: u64,
    clock:     &Clock,
    ctx:       &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper, ENotKeeper);
    assert!(object::id(manager) == vault.manager_id, EWrongManager);

    let vault_id    = object::id(vault);
    let position_id = {
        let table = combo::table_ref(&vault.id);
        let entry = table.borrow(combo_id);
        assert!(combo::is_leverage_leg(entry, leg_index), EZeroQuantity);
        combo::leg_position_id(entry, leg_index)
    };

    let equity = leverage::settle_for_combo(pool, book, predict, oracle, position_id, clock, ctx);
    let won    = equity > 0;
    // accumulate = false: equity was already transferred directly to owner above
    let all_done = combo::record_settlement(&mut vault.id, vault_id, combo_id, leg_index, won, equity, false);

    if (all_done) {
        let accumulated = {
            let table = combo::table_ref(&vault.id);
            combo::entry_accumulated(table.borrow(combo_id))
        };
        if (accumulated > 0) {
            let funds = manager.withdraw<Quote>(accumulated, ctx);
            vault.settlements.add(combo_id + (1u64 << 32), funds.into_balance());
        };
    };
}

/// Keeper: execute the mint for one leg of a combo. Routes the PositionToken
/// into the combo entry rather than transferring it to the user.
/// Call once per leg; batch legs sharing the same oracle into one PTB.
public fun execute_combo_mint<Quote>(
    vault:     &mut CeridaVault<Quote>,
    manager:   &mut PredictManager,
    predict:   &mut Predict,
    oracle:    &OracleSVI,
    combo_id:  u64,
    leg_index: u64,
    clock:     &Clock,
    ctx:       &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper, ENotKeeper);
    assert!(object::id(manager) == vault.manager_id, EWrongManager);

    // Capture vault_id and intent_id before any mutable borrows of vault.id
    let vault_id  = object::id(vault);
    let intent_id = {
        let table = combo::table_ref(&vault.id);
        let entry = table.borrow(combo_id);
        combo::leg_intent_id(entry, leg_index)
    };

    // Read intent fields before execute_mint_internal destroys the intent.
    let is_range_leg  = vault.intents[intent_id].is_range();
    let oracle_id_leg = vault.intents[intent_id].oracle_id();
    let expiry_leg    = vault.intents[intent_id].expiry();
    let strike_leg    = if (!is_range_leg) { vault.intents[intent_id].strike() } else { 0 };
    let is_up_leg     = if (!is_range_leg) { vault.intents[intent_id].is_up() } else { false };
    let lower_leg     = if (is_range_leg) { vault.intents[intent_id].lower() } else { 0 };
    let higher_leg    = if (is_range_leg) { vault.intents[intent_id].higher() } else { 0 };
    let qty_leg       = vault.intents[intent_id].qty();

    // Execute via shared internal mint logic (returns token instead of transferring)
    let (token, _user, _qty, _cost, _refunded) =
        execute_mint_internal(vault, manager, predict, oracle, intent_id, clock, ctx);

    // Track LP exposure for this leg.
    let exp_key = if (is_range_leg) {
        range_exposure_key(oracle_id_leg, expiry_leg, lower_leg, higher_leg)
    } else {
        binary_exposure_key(oracle_id_leg, expiry_leg, strike_leg)
    };
    let (yes_qty, no_qty) = record_exposure(vault, copy exp_key, is_range_leg || is_up_leg, qty_leg);
    event::emit(ExposureChanged { vault_id, key: exp_key, yes_qty, no_qty });

    // Store the token in the combo entry (vault.id is no longer borrowed here)
    combo::store_token(&mut vault.id, combo_id, leg_index, token, vault_id, intent_id);
}

/// Keeper: settle one leg of a combo at its expiry. Redeems the stored
/// PositionToken, records the payout. In PARLAY mode, any loss closes the
/// combo immediately and returns accumulated payouts to the owner.
public fun settle_combo_leg<Quote>(
    vault:     &mut CeridaVault<Quote>,
    manager:   &mut PredictManager,
    predict:   &mut Predict,
    oracle:    &OracleSVI,
    combo_id:  u64,
    leg_index: u64,
    clock:     &Clock,
    ctx:       &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper, ENotKeeper);
    assert!(object::id(manager) == vault.manager_id, EWrongManager);

    // Take the PositionToken out of the combo
    let token = combo::take_token(&mut vault.id, combo_id, leg_index);

    let oracle_id = token.oracle_id();
    let expiry    = token.expiry();
    let qty       = token.qty();
    let is_range  = token.is_range();
    let strike    = token.strike();
    let is_up_v   = token.is_up();
    let lower     = token.lower();
    let higher    = token.higher();

    let before = manager.balance<Quote>();
    if (is_range) {
        let key = range_key::new(oracle_id, expiry, lower, higher);
        predict::redeem_range<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    } else {
        let key = market_key::new(oracle_id, expiry, strike, is_up_v);
        predict::redeem<Quote>(predict, manager, oracle, key, qty, clock, ctx);
    };
    let payout = manager.balance<Quote>() - before;
    position_token::burn(token);

    // Untrack LP exposure for this settled leg.
    let exp_key = if (is_range) {
        range_exposure_key(oracle_id, expiry, lower, higher)
    } else {
        binary_exposure_key(oracle_id, expiry, strike)
    };
    let won      = payout > 0;
    let vault_id = object::id(vault);
    let (yes_qty, no_qty) = unrecord_exposure(vault, copy exp_key, is_range || is_up_v, qty);
    event::emit(ExposureChanged { vault_id, key: exp_key, yes_qty, no_qty });
    let all_done = combo::record_settlement(&mut vault.id, vault_id, combo_id, leg_index, won, payout, true);

    // If all legs are done, accumulate the payout into the vault settlements
    // keyed by combo_id so claim_combo can pull it.
    if (all_done) {
        let accumulated = {
            let table = combo::table_ref(&vault.id);
            combo::entry_accumulated(table.borrow(combo_id))
        };
        if (accumulated > 0) {
            let funds = manager.withdraw<Quote>(accumulated, ctx);
            vault.settlements.add(combo_id + (1u64 << 32), funds.into_balance());
        };
    };
}

/// User: claim the payout for a fully settled combo.
/// Removes the combo entry from the vault.
public fun claim_combo<Quote>(
    vault:    &mut CeridaVault<Quote>,
    combo_id: u64,
    ctx:      &mut TxContext,
) {
    let caller   = ctx.sender();
    let vault_id = object::id(vault);
    let entry    = combo::take_for_claim(&mut vault.id, combo_id, caller);
    let payout   = combo::entry_accumulated(&entry);
    combo::destroy_entry(entry);

    // Pull from the pre-accumulated settlement slot
    let slot_key = combo_id + (1u64 << 32);
    if (vault.settlements.contains(slot_key) && payout > 0) {
        let balance = vault.settlements.remove(slot_key);
        transfer::public_transfer(balance.into_coin(ctx), caller);
    };

    event::emit(ComboClaimed { vault_id, combo_id, owner: caller, payout });
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// BCS key for binary (oracle, expiry, strike). Leading 0x00 discriminator.
fun binary_exposure_key(oracle_id: ID, expiry: u64, strike: u64): vector<u8> {
    let mut k = vector[0u8];
    k.append(object::id_to_bytes(&oracle_id));
    k.append(bcs::to_bytes(&expiry));
    k.append(bcs::to_bytes(&strike));
    k
}

/// BCS key for range (oracle, expiry, lower, higher). Leading 0x01 discriminator.
fun range_exposure_key(oracle_id: ID, expiry: u64, lower: u64, higher: u64): vector<u8> {
    let mut k = vector[1u8];
    k.append(object::id_to_bytes(&oracle_id));
    k.append(bcs::to_bytes(&expiry));
    k.append(bcs::to_bytes(&lower));
    k.append(bcs::to_bytes(&higher));
    k
}

/// Increment yes_qty (is_yes=true) or no_qty for the given key.
/// Inserts a zero entry if the key is new. Returns updated (yes_qty, no_qty).
fun record_exposure<Quote>(
    vault:  &mut CeridaVault<Quote>,
    key:    vector<u8>,
    is_yes: bool,
    qty:    u64,
): (u64, u64) {
    if (!vault.exposure.contains(copy key)) {
        vault.exposure.add(copy key, NetExposure { yes_qty: 0, no_qty: 0 });
    };
    let e = &mut vault.exposure[key];
    if (is_yes) { e.yes_qty = e.yes_qty + qty } else { e.no_qty = e.no_qty + qty };
    (e.yes_qty, e.no_qty)
}

/// Decrement yes_qty or no_qty on redeem/exit. Saturates at zero.
/// Returns updated (yes_qty, no_qty).
fun unrecord_exposure<Quote>(
    vault:  &mut CeridaVault<Quote>,
    key:    vector<u8>,
    is_yes: bool,
    qty:    u64,
): (u64, u64) {
    if (!vault.exposure.contains(copy key)) return (0, 0);
    let e = &mut vault.exposure[key];
    if (is_yes) {
        e.yes_qty = if (e.yes_qty >= qty) e.yes_qty - qty else 0;
    } else {
        e.no_qty = if (e.no_qty >= qty) e.no_qty - qty else 0;
    };
    (e.yes_qty, e.no_qty)
}

fun extract_key_fields(i: &Intent): (u64, bool, u64, u64) {
    if (i.is_range()) {
        (0, false, i.lower(), i.higher())
    } else {
        (i.strike(), i.is_up(), 0, 0)
    }
}

/// Shared mint execution: removes the intent, mints via Predict, and returns
/// (token, user, qty, cost, refunded) without transferring the token.
/// Used by both execute_mint (which transfers to user) and execute_combo_mint
/// (which routes the token into the combo entry).
fun execute_mint_internal<Quote>(
    vault:     &mut CeridaVault<Quote>,
    manager:   &mut PredictManager,
    predict:   &mut Predict,
    oracle:    &OracleSVI,
    intent_id: u64,
    clock:     &Clock,
    ctx:       &mut TxContext,
): (PositionToken, address, u64, u64, u64) {
    // Limit check
    let max_cost = vault.intents[intent_id].max_cost();
    if (max_cost > 0) {
        let qty      = vault.intents[intent_id].qty();
        let oracle_id = vault.intents[intent_id].oracle_id();
        let expiry   = vault.intents[intent_id].expiry();
        let is_range = vault.intents[intent_id].is_range();
        let preview  = if (is_range) {
            let lower  = vault.intents[intent_id].lower();
            let higher = vault.intents[intent_id].higher();
            let key = range_key::new(oracle_id, expiry, lower, higher);
            let (ask, _) = predict::get_range_trade_amounts(predict, oracle, key, qty, clock);
            ask
        } else {
            let strike  = vault.intents[intent_id].strike();
            let is_up_v = vault.intents[intent_id].is_up();
            let key = market_key::new(oracle_id, expiry, strike, is_up_v);
            let (ask, _) = predict::get_trade_amounts(predict, oracle, key, qty, clock);
            ask
        };
        assert!(preview <= max_cost, ELimitNotMet);
    };

    let i        = vault.intents.remove(intent_id);
    let user     = i.user();
    let oracle_id = i.oracle_id();
    let expiry   = i.expiry();
    let qty      = i.qty();
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
    let cost     = before - manager.balance<Quote>();
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
    (token, user, qty, cost, refunded)
}
