// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Leverage over Cerida positions — a margined CDP on YES/NO (and range) shares.
///
/// A trader posts margin; the `MarginPool` lends the rest; the combined funds
/// mint MORE Predict shares than the margin alone could buy. The shares (a
/// custodied `PositionToken`) are the collateral, and the position is liquidated
/// when its live mark falls toward the debt. Because Predict is a vault/AMM (PLP
/// is the counterparty, price is deterministic), liquidation has no depth or
/// slippage risk — the redeem value comes straight from `predict::get_trade_amounts`
/// — so we can run more leverage than a CLOB-based product, throttled by the
/// keeper's risk engine. Shares gap to $1/$0 at resolution, so leverage is meant
/// to be force-closed before settlement (`force_close`); the keeper enforces that.
///
/// Custody mirrors `cerida::vault`: every manager op in `predict-testnet-4-16` is
/// owner-gated, so the keeper (manager owner) runs the mint/redeem. Positions live
/// in a shared `LeverageBook` table so the keeper can reach them by id.
///
/// Math (prices/marks scaled 1e9, amounts raw 1e6):
///   Health       = (value − debt) / init_margin       value = bid·qty (raw units)
///   liquidatable ⇔ value ≤ debt + maint_bps·init_margin/1e4
module cerida::leverage;

use cerida::position_token::{Self, PositionToken};
use cerida::vault::CeridaVault;
use deepbook_predict::{
    market_key,
    oracle::OracleSVI,
    predict::{Self, Predict},
    predict_manager::PredictManager,
    range_key
};
use sui::{balance::{Self, Balance}, clock::Clock, coin::Coin, event, table::{Self, Table}};

// === Constants ===
/// Price scale: a mark in [0, FLOAT] represents $0–$1.
const FLOAT: u128 = 1_000_000_000;
/// Basis-point denominator.
const BPS: u128 = 10_000;
/// Hard backstop on leverage (50× = 500_000 bps); the keeper enforces the
/// dynamic, lower cap per position.
const MAX_LEVERAGE_BPS: u64 = 500_000;

// === Errors ===
const ENotKeeper: u64 = 0;
const EWrongManager: u64 = 1;
const EZeroQuantity: u64 = 2;
const EZeroMargin: u64 = 3;
/// Pool has less idle liquidity than the requested borrow/withdraw.
const EInsufficientLiquidity: u64 = 4;
/// Realized mint cost exceeded the leverage-authorized notional.
const ESlippageExceeded: u64 = 5;
/// Position is healthy — not eligible for liquidation.
const ENotLiquidatable: u64 = 6;
/// LP share is for a different pool.
const EWrongPool: u64 = 7;
/// Requested leverage exceeds the hard backstop.
const ELeverageTooHigh: u64 = 8;

// === Events ===

public struct PoolCreated has copy, drop { pool_id: ID }

public struct LeverageOpened has copy, drop {
    book_id: ID,
    position_id: u64,
    owner: address,
    is_range: bool,
    qty: u64,
    cost: u64,
    debt: u64,
    entry_mark: u64,
}

public struct LeverageClosed has copy, drop {
    book_id: ID,
    position_id: u64,
    owner: address,
    payout: u64,
    debt_repaid: u64,
    equity_to_owner: u64,
    liquidated: bool,
}

public struct MarginAdded has copy, drop {
    book_id: ID,
    position_id: u64,
    amount: u64,
    debt_after: u64,
}

// === Structs ===

/// Quote (dUSDC) lending pool + Earn vault. Pool value = idle `liquidity` +
/// `total_debt` lent out. Yield to LPs = open fees + performance fees joined into
/// `liquidity` (raising the share price). `insurance` is a fee-funded backstop
/// for bad debt / liquidation penalties.
public struct MarginPool<phantom Quote> has key {
    id: UID,
    liquidity: Balance<Quote>,
    total_debt: u64,
    insurance: Balance<Quote>,
    total_shares: u64,
}

/// An LP's pro-rata claim on a `MarginPool`.
public struct LpShare<phantom Quote> has key, store {
    id: UID,
    pool_id: ID,
    shares: u64,
}

/// Holds open leveraged positions so the keeper can reach them by id.
public struct LeverageBook<phantom Quote> has key {
    id: UID,
    positions: Table<u64, LeveragedPosition<Quote>>,
    next_id: u64,
}

/// One leveraged claim: collateral shares held against pool debt. `store`-only —
/// it lives inside the book's table and is consumed on close.
public struct LeveragedPosition<phantom Quote> has store {
    vault_id: ID,
    owner: address,
    token: PositionToken,
    debt: u64,
    init_margin: u64,
    entry_mark: u64,
    maint_bps: u64,
    expiry: u64,
    opened_at: u64,
}

// === Pure math helpers (unit-tested without Predict) ===

fun mul_bps(x: u64, bps: u64): u64 { (((x as u128) * (bps as u128)) / BPS) as u64 }

/// Per-contract mark (1e9-scaled) implied by a raw `cost` over `qty` contracts.
fun price_of(cost: u64, qty: u64): u64 { (((cost as u128) * FLOAT) / (qty as u128)) as u64 }

/// Decompose a realized open into (debt, init_margin, repay_to_pool, refund).
/// `margin` is net of fee; `cost ≤ margin·leverage` must hold (caller asserts).
/// Margin is spent before borrow, so borrowed-used = max(0, cost − margin).
public(package) fun reconcile_open(margin: u64, leverage_bps: u64, cost: u64): (u64, u64, u64, u64) {
    let e = mul_bps(margin, leverage_bps);
    let borrow = e - margin;
    let borrowed_used = if (cost > margin) cost - margin else 0;
    let debt = borrowed_used;
    let init_margin = cost - debt;
    let repay = borrow - borrowed_used;
    let refund = if (margin > cost) margin - cost else 0;
    (debt, init_margin, repay, refund)
}

/// Health ≤ maintenance ⇔ value ≤ debt + maint_bps·init_margin/1e4.
public(package) fun is_liquidatable_at(value: u64, debt: u64, init_margin: u64, maint_bps: u64): bool {
    value <= debt + mul_bps(init_margin, maint_bps)
}

// === Pool: lifecycle ===

/// Create and share a margin pool for `Quote`.
public fun create_pool<Quote>(ctx: &mut TxContext): ID {
    let pool = MarginPool<Quote> {
        id: object::new(ctx),
        liquidity: balance::zero(),
        total_debt: 0,
        insurance: balance::zero(),
        total_shares: 0,
    };
    let pool_id = object::id(&pool);
    event::emit(PoolCreated { pool_id });
    transfer::share_object(pool);
    pool_id
}

/// Create and share the book that custodies leveraged positions.
public fun create_book<Quote>(ctx: &mut TxContext): ID {
    let book = LeverageBook<Quote> {
        id: object::new(ctx),
        positions: table::new(ctx),
        next_id: 0,
    };
    let book_id = object::id(&book);
    transfer::share_object(book);
    book_id
}

/// Supply quote to the pool; mint LP shares pro-rata to pool value.
public fun supply<Quote>(pool: &mut MarginPool<Quote>, payment: Coin<Quote>, ctx: &mut TxContext): LpShare<Quote> {
    let amount = payment.value();
    assert!(amount > 0, EZeroMargin);
    let value = pool_value(pool);
    let shares = if (pool.total_shares == 0 || value == 0) {
        amount
    } else {
        (((amount as u128) * (pool.total_shares as u128)) / (value as u128)) as u64
    };
    pool.liquidity.join(payment.into_balance());
    pool.total_shares = pool.total_shares + shares;
    LpShare { id: object::new(ctx), pool_id: object::id(pool), shares }
}

/// Burn an LP share and withdraw the pro-rata quote (idle liquidity only).
public fun withdraw<Quote>(pool: &mut MarginPool<Quote>, share: LpShare<Quote>, ctx: &mut TxContext): Coin<Quote> {
    let LpShare { id, pool_id, shares } = share;
    assert!(pool_id == object::id(pool), EWrongPool);
    id.delete();
    let amount = (((shares as u128) * (pool_value(pool) as u128)) / (pool.total_shares as u128)) as u64;
    assert!(pool.liquidity.value() >= amount, EInsufficientLiquidity);
    pool.total_shares = pool.total_shares - shares;
    pool.liquidity.split(amount).into_coin(ctx)
}

// === Pool: internal lend/repay ===

/// Draw `amount` of idle liquidity as debt.
public(package) fun borrow<Quote>(pool: &mut MarginPool<Quote>, amount: u64): Balance<Quote> {
    assert!(pool.liquidity.value() >= amount, EInsufficientLiquidity);
    pool.total_debt = pool.total_debt + amount;
    pool.liquidity.split(amount)
}

/// Repay a loan: clear `principal` from outstanding debt and return `funds` to
/// liquidity. If `funds < principal` (bad debt), the shortfall is a realized
/// pool loss reflected in `pool_value`.
public(package) fun repay_loan<Quote>(pool: &mut MarginPool<Quote>, principal: u64, funds: Balance<Quote>) {
    pool.total_debt = if (principal >= pool.total_debt) 0 else pool.total_debt - principal;
    pool.liquidity.join(funds);
}

// === Open ===

/// Charge the open fee (→ insurance), compute authorized notional, borrow the
/// gap, and return (combined funding coin, net margin, authorized notional).
fun charge_and_fund<Quote>(
    pool: &mut MarginPool<Quote>,
    mut margin: Coin<Quote>,
    leverage_bps: u64,
    open_fee_bps: u64,
    ctx: &mut TxContext,
): (Coin<Quote>, u64, u64) {
    assert!(leverage_bps <= MAX_LEVERAGE_BPS, ELeverageTooHigh);
    let margin_in = margin.value();
    assert!(margin_in > 0, EZeroMargin);
    let fee = mul_bps(margin_in, open_fee_bps);
    if (fee > 0) { pool.insurance.join(margin.split(fee, ctx).into_balance()); };
    let m = margin.value();
    let e = mul_bps(m, leverage_bps);
    let mut funding = margin.into_balance();
    funding.join(borrow(pool, e - m));
    (funding.into_coin(ctx), m, e)
}

/// Post-mint reconciliation: assert slippage, repay unused borrow, refund unused
/// margin to `owner`. Returns (debt, init_margin).
fun settle_open<Quote>(
    pool: &mut MarginPool<Quote>,
    manager: &mut PredictManager,
    owner: address,
    m: u64,
    leverage_bps: u64,
    e: u64,
    cost: u64,
    ctx: &mut TxContext,
): (u64, u64) {
    assert!(cost <= e, ESlippageExceeded);
    let (debt, init_margin, repay, _refund) = reconcile_open(m, leverage_bps, cost);
    let leftover = e - cost;
    if (leftover > 0) {
        let mut excess = manager.withdraw<Quote>(leftover, ctx).into_balance();
        if (repay > 0) repay_loan(pool, repay, excess.split(repay));
        if (excess.value() > 0) transfer::public_transfer(excess.into_coin(ctx), owner)
        else excess.destroy_zero();
    };
    (debt, init_margin)
}

fun book_position<Quote>(
    book: &mut LeverageBook<Quote>,
    vault_id: ID,
    owner: address,
    token: PositionToken,
    debt: u64,
    init_margin: u64,
    entry_mark: u64,
    maint_bps: u64,
    expiry: u64,
    is_range: bool,
    qty: u64,
    cost: u64,
    clock: &Clock,
): u64 {
    let position = LeveragedPosition<Quote> {
        vault_id,
        owner,
        token,
        debt,
        init_margin,
        entry_mark,
        maint_bps,
        expiry,
        opened_at: clock.timestamp_ms(),
    };
    let position_id = book.next_id;
    book.next_id = position_id + 1;
    book.positions.add(position_id, position);
    event::emit(LeverageOpened {
        book_id: object::id(book),
        position_id,
        owner,
        is_range,
        qty,
        cost,
        debt,
        entry_mark,
    });
    position_id
}

/// Keeper-side leveraged open of a binary (continuous-strike) position.
/// `owner` is the original requester. Returns the position id.
public fun open_leveraged_binary<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    vault: &CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    owner: address,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    margin: Coin<Quote>,
    qty: u64,
    leverage_bps: u64,
    maint_bps: u64,
    open_fee_bps: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    assert!(ctx.sender() == vault.keeper(), ENotKeeper);
    assert!(object::id(manager) == vault.manager_id(), EWrongManager);
    assert!(qty > 0, EZeroQuantity);

    let (funding, m, e) = charge_and_fund(pool, margin, leverage_bps, open_fee_bps, ctx);
    manager.deposit(funding, ctx);

    let before = manager.balance<Quote>();
    predict::mint<Quote>(predict, manager, oracle, market_key::new(oracle_id, expiry, strike, is_up), qty, clock, ctx);
    let cost = before - manager.balance<Quote>();

    let (debt, init_margin) = settle_open(pool, manager, owner, m, leverage_bps, e, cost, ctx);
    let token = position_token::new_binary(object::id(vault), oracle_id, expiry, strike, is_up, qty, ctx);
    book_position(book, object::id(vault), owner, token, debt, init_margin, price_of(cost, qty), maint_bps, expiry, false, qty, cost, clock)
}

/// Keeper-side leveraged open of a vertical-range position.
public fun open_leveraged_range<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    vault: &CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    owner: address,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    margin: Coin<Quote>,
    qty: u64,
    leverage_bps: u64,
    maint_bps: u64,
    open_fee_bps: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    assert!(ctx.sender() == vault.keeper(), ENotKeeper);
    assert!(object::id(manager) == vault.manager_id(), EWrongManager);
    assert!(qty > 0, EZeroQuantity);

    let (funding, m, e) = charge_and_fund(pool, margin, leverage_bps, open_fee_bps, ctx);
    manager.deposit(funding, ctx);

    let before = manager.balance<Quote>();
    predict::mint_range<Quote>(predict, manager, oracle, range_key::new(oracle_id, expiry, lower, higher), qty, clock, ctx);
    let cost = before - manager.balance<Quote>();

    let (debt, init_margin) = settle_open(pool, manager, owner, m, leverage_bps, e, cost, ctx);
    let token = position_token::new_range(object::id(vault), oracle_id, expiry, lower, higher, qty, ctx);
    book_position(book, object::id(vault), owner, token, debt, init_margin, price_of(cost, qty), maint_bps, expiry, true, qty, cost, clock)
}

// === Margin management ===

/// Pay down a position's debt (de-risk). Permissionless — it only reduces risk.
public fun add_margin<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    position_id: u64,
    payment: Coin<Quote>,
) {
    let amount = payment.value();
    let book_id = object::id(book);
    let pos = &mut book.positions[position_id];
    let principal = if (amount >= pos.debt) pos.debt else amount;
    pos.debt = pos.debt - principal;
    let debt_after = pos.debt;
    repay_loan(pool, principal, payment.into_balance());
    event::emit(MarginAdded { book_id, position_id, amount, debt_after });
}

// === Close / liquidate / force-close ===

/// Owner-requested close (keeper executes the owner-gated redeem).
public fun close<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    vault: &CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    position_id: u64,
    perf_bps: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper(), ENotKeeper);
    assert!(object::id(manager) == vault.manager_id(), EWrongManager);
    settle_close(pool, book, manager, predict, oracle, position_id, perf_bps, false, clock, ctx);
}

/// Liquidate an underwater position — health is verified on-chain (via the live
/// redeem value) BEFORE the irreversible redeem.
public fun liquidate<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    vault: &CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper(), ENotKeeper);
    assert!(object::id(manager) == vault.manager_id(), EWrongManager);
    settle_close(pool, book, manager, predict, oracle, position_id, 0, true, clock, ctx);
}

/// Keeper force-close inside the pre-settlement window — flatten before the
/// oracle resolves so a leveraged position never carries the $1/$0 gap.
public fun force_close<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    vault: &CeridaVault<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    position_id: u64,
    perf_bps: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.keeper(), ENotKeeper);
    assert!(object::id(manager) == vault.manager_id(), EWrongManager);
    settle_close(pool, book, manager, predict, oracle, position_id, perf_bps, false, clock, ctx);
}

/// Shared settlement: (liquidation only) verify health, redeem the shares, repay
/// the loan, take the performance fee or liquidation penalty, pay the owner.
fun settle_close<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    manager: &mut PredictManager,
    predict: &mut Predict,
    oracle: &OracleSVI,
    position_id: u64,
    perf_bps: u64,
    is_liquidation: bool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let LeveragedPosition {
        vault_id: _, owner, token, debt, init_margin, entry_mark: _, maint_bps, expiry, opened_at: _,
    } = book.positions.remove(position_id);

    let oracle_id = token.oracle_id();
    let qty = token.qty();
    let is_range = token.is_range();

    // Liquidation gate: value the position at the live bid BEFORE redeeming.
    if (is_liquidation) {
        let value = if (is_range) {
            let (_ask, bid) = predict::get_range_trade_amounts(
                predict, oracle, range_key::new(oracle_id, expiry, token.lower(), token.higher()), qty, clock,
            );
            bid
        } else {
            let (_ask, bid) = predict::get_trade_amounts(
                predict, oracle, market_key::new(oracle_id, expiry, token.strike(), token.is_up()), qty, clock,
            );
            bid
        };
        assert!(is_liquidatable_at(value, debt, init_margin, maint_bps), ENotLiquidatable);
    };

    let before = manager.balance<Quote>();
    if (is_range) {
        predict::redeem_range<Quote>(predict, manager, oracle, range_key::new(oracle_id, expiry, token.lower(), token.higher()), qty, clock, ctx);
    } else {
        predict::redeem<Quote>(predict, manager, oracle, market_key::new(oracle_id, expiry, token.strike(), token.is_up()), qty, clock, ctx);
    };
    let payout = manager.balance<Quote>() - before;

    // Pool is made whole first (debt principal cleared; shortfall = pool loss).
    let repaid = if (payout >= debt) debt else payout;
    if (repaid > 0) repay_loan(pool, debt, manager.withdraw<Quote>(repaid, ctx).into_balance());
    let equity = payout - repaid;

    let equity_to_owner = if (is_liquidation) {
        // Penalty: residual equity backstops the pool.
        if (equity > 0) { pool.insurance.join(manager.withdraw<Quote>(equity, ctx).into_balance()); };
        0
    } else {
        let perf_fee = if (equity > init_margin) mul_bps(equity - init_margin, perf_bps) else 0;
        if (perf_fee > 0) { pool.liquidity.join(manager.withdraw<Quote>(perf_fee, ctx).into_balance()); };
        let to_owner = equity - perf_fee;
        if (to_owner > 0) transfer::public_transfer(manager.withdraw<Quote>(to_owner, ctx), owner);
        to_owner
    };

    position_token::burn(token);
    event::emit(LeverageClosed {
        book_id: object::id(book),
        position_id,
        owner,
        payout,
        debt_repaid: repaid,
        equity_to_owner,
        liquidated: is_liquidation,
    });
}

// === Getters ===

public fun pool_value<Quote>(pool: &MarginPool<Quote>): u64 { pool.liquidity.value() + pool.total_debt }
public fun pool_liquidity<Quote>(pool: &MarginPool<Quote>): u64 { pool.liquidity.value() }
public fun pool_debt<Quote>(pool: &MarginPool<Quote>): u64 { pool.total_debt }
public fun pool_insurance<Quote>(pool: &MarginPool<Quote>): u64 { pool.insurance.value() }
public fun pool_total_shares<Quote>(pool: &MarginPool<Quote>): u64 { pool.total_shares }
public fun lp_shares<Quote>(share: &LpShare<Quote>): u64 { share.shares }

public fun has_position<Quote>(book: &LeverageBook<Quote>, position_id: u64): bool {
    book.positions.contains(position_id)
}
public fun position_debt<Quote>(book: &LeverageBook<Quote>, position_id: u64): u64 {
    book.positions[position_id].debt
}
public fun position_init_margin<Quote>(book: &LeverageBook<Quote>, position_id: u64): u64 {
    book.positions[position_id].init_margin
}
public fun position_entry_mark<Quote>(book: &LeverageBook<Quote>, position_id: u64): u64 {
    book.positions[position_id].entry_mark
}
public fun position_owner<Quote>(book: &LeverageBook<Quote>, position_id: u64): address {
    book.positions[position_id].owner
}

/// Live health view: returns (value = bid·qty, liquidation threshold). The
/// position is liquidatable iff value ≤ threshold.
public fun position_health<Quote>(
    book: &LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
): (u64, u64) {
    let pos = &book.positions[position_id];
    let oracle_id = pos.token.oracle_id();
    let qty = pos.token.qty();
    let value = if (pos.token.is_range()) {
        let (_ask, bid) = predict::get_range_trade_amounts(
            predict, oracle, range_key::new(oracle_id, pos.expiry, pos.token.lower(), pos.token.higher()), qty, clock,
        );
        bid
    } else {
        let (_ask, bid) = predict::get_trade_amounts(
            predict, oracle, market_key::new(oracle_id, pos.expiry, pos.token.strike(), pos.token.is_up()), qty, clock,
        );
        bid
    };
    (value, pos.debt + mul_bps(pos.init_margin, pos.maint_bps))
}

// === Test-only ===

#[test_only]
public fun new_position_for_testing<Quote>(
    token: PositionToken,
    debt: u64,
    init_margin: u64,
    maint_bps: u64,
): LeveragedPosition<Quote> {
    LeveragedPosition<Quote> {
        vault_id: object::id_from_address(@0x0),
        owner: @0xB0,
        token,
        debt,
        init_margin,
        entry_mark: 0,
        maint_bps,
        expiry: 0,
        opened_at: 0,
    }
}

#[test_only]
public fun destroy_position_for_testing<Quote>(pos: LeveragedPosition<Quote>) {
    let LeveragedPosition { vault_id: _, owner: _, token, debt: _, init_margin: _, entry_mark: _, maint_bps: _, expiry: _, opened_at: _ } = pos;
    position_token::burn(token);
}

#[test_only]
public fun mul_bps_for_testing(x: u64, bps: u64): u64 { mul_bps(x, bps) }

#[test_only]
public fun price_of_for_testing(cost: u64, qty: u64): u64 { price_of(cost, qty) }
