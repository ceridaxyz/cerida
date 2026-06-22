// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Turbo Tickets + limit orders — fully-reserved knockout leverage on Predict's mark.
/// Model: paper/leverage-model.md · validation: simulations/leverage_mc.ts.
///
/// The pool is the COUNTERPARTY, not a lender. A trader posts margin `m`; the
/// pool locks the ticket's maximum payout (`reserved = qty − basis`) at open;
/// both sides are sealed inside the position from the first second. Equity
/// tracks Predict's live bid and is clamped to [0, m + reserved]:
///
///   X = clip( m + bid·qty − basis , 0 , m + reserved )
///
/// Because prediction shares are bounded at $1, the worst case is finite and
/// pre-funded — bad debt is impossible by construction (no debt object exists;
/// Prop. 2 of the model). Knockout fires when X ≤ maint_bps·m/1e4; the trader
/// keeps the residual minus a penalty (Prop. 3 keeps the expected cost exact).
///
/// TP/SL: the owner pre-authorises conditional exits by setting tp_value /
/// sl_value on the ticket. Anyone may then call execute_tp / execute_sl once the
/// live bid·qty crosses the level — same close semantics (perf fee, no penalty).
///
/// Limit orders: sealed escrow in a separate LimitBook. The owner commits margin
/// at placement; anyone calls execute_limit once the ask crosses limit_basis.
/// The opened ticket is assigned to the original owner regardless of who executes.
///
/// Trust model: nothing here needs Predict's owner-gated manager — the mark
/// comes from the immutable `get_trade_amounts` — so the whole lifecycle is
/// permissionless: `open`/`close` are trader-signed, `liquidate`/`force_close`/
/// `execute_tp`/`execute_sl`/`execute_limit` are open to anyone with on-chain
/// verification, and `cancel_limit`/`expire_limit` return the escrow safely.
module cerida::leverage;

use deepbook_predict::{
    market_key,
    oracle::OracleSVI,
    plp::PLP,
    predict::{Self, Predict},
    range_key
};
use sui::{balance::{Self, Balance}, clock::Clock, coin::{Self, Coin}, event, table::{Self, Table}};

// === Constants ===
/// Hard on-chain leverage backstop: basis ≤ 50× margin. The dynamic, lower
/// usable-leverage cap (model §6.1) is policy enforced off-chain — it protects
/// the trader from near-certain knockout, never the pool's solvency.
const MAX_LEVERAGE_BPS: u64 = 500_000;
/// Highest knockout threshold a ticket may choose (90% of margin).
const MAX_MAINT_BPS: u64 = 9_000;
/// Minimum force-close window regardless of leverage (resolution risk floor, §6.3).
const FORCE_WINDOW_MS: u64 = 120_000;
/// Keeper monitoring interval assumed by the leverage formulas (§6.2, §7).
const EPOCH_DELTA_MS: u64 = 5_000;
const BPS: u128 = 10_000;

// === Errors ===
const EZeroQuantity: u64 = 0;
const EZeroMargin: u64 = 1;
/// Pool has less idle liquidity than the requested reserve/withdrawal.
const EInsufficientLiquidity: u64 = 2;
/// basis > 50× margin.
const ELeverageTooHigh: u64 = 3;
/// Position is healthy — not eligible for liquidation.
const ENotLiquidatable: u64 = 4;
/// LP share belongs to a different pool.
const EWrongPool: u64 = 5;
/// Caller is not the ticket/order owner.
const ENotOwner: u64 = 6;
/// maint_bps out of (0, MAX_MAINT_BPS].
const EBadMaintenance: u64 = 7;
/// Market expires inside the force window — too late to open.
const ETooCloseToExpiry: u64 = 8;
/// force_close conditions not met: position is outside the dynamic τ_c window
/// and equity still covers the next epoch fee.
const EForceWindowNotReached: u64 = 9;
/// Quoted basis ≥ max payout — nothing to reserve (degenerate mark).
const EBasisTooHigh: u64 = 10;
/// TP/SL not set on the ticket, or the condition is not yet satisfied.
const EConditionNotMet: u64 = 11;
/// Limit order's TTL has elapsed — use expire_limit instead.
const EOrderExpired: u64 = 12;
/// Ask hasn't crossed the limit basis — condition not met.
const ELimitNotCrossed: u64 = 13;
const ELockedInCombo:   u64 = 14;

// === Events ===

public struct PoolCreated has copy, drop {
    pool_id: ID,
    perf_bps: u64,
    penalty_bps: u64,
    open_fee_bps: u64,
}

public struct TicketOpened has copy, drop {
    book_id: ID,
    position_id: u64,
    owner: address,
    is_range: bool,
    qty: u64,
    margin: u64,
    basis: u64,
    reserved: u64,
    maint_bps: u64,
    expiry: u64,
    tp_value: u64,
    sl_value: u64,
    /// Dynamic force-close window in ms (model §6.2). Keeper must call
    /// force_close by expiry − force_window_ms at the latest.
    force_window_ms: u64,
}

public struct TicketClosed has copy, drop {
    book_id: ID,
    position_id: u64,
    owner: address,
    value: u64,
    equity: u64,
    to_owner: u64,
    to_insurance: u64,
    returned_to_pool: u64,
    liquidated: bool,
}

public struct TpSlUpdated has copy, drop {
    book_id: ID,
    position_id: u64,
    tp_value: u64,
    sl_value: u64,
}

public struct LimitBookCreated has copy, drop {
    limit_book_id: ID,
}

public struct LimitOrderPlaced has copy, drop {
    limit_book_id: ID,
    order_id: u64,
    owner: address,
    is_range: bool,
    qty: u64,
    escrow: u64,
    limit_basis: u64,
    order_ttl: u64,
}

public struct LimitOrderExecuted has copy, drop {
    limit_book_id: ID,
    order_id: u64,
    owner: address,
    position_id: u64,
    basis: u64,
}

public struct LimitOrderCancelled has copy, drop {
    limit_book_id: ID,
    order_id: u64,
    owner: address,
    refunded: u64,
}

// === Structs ===

/// Counterparty pool + Earn vault. `reserved_out` is the book value of payout
/// reserves locked in open tickets; pool value = idle liquidity + reserves.
/// LP yield = open fees + performance fees + knockout penalties + trader
/// losses; LP downside per ticket is bounded by its reserve, paid at open.
public struct MarginPool<phantom Quote> has key {
    id: UID,
    liquidity: Balance<Quote>,
    reserved_out: u64,
    insurance: Balance<Quote>,
    total_shares: u64,
    perf_bps: u64,
    penalty_bps: u64,
    open_fee_bps: u64,
}

/// An LP's pro-rata claim on a `MarginPool`.
public struct LpShare<phantom Quote> has key, store {
    id: UID,
    pool_id: ID,
    shares: u64,
}

/// Holds open tickets, reachable by id (permissionless liquidation needs this).
public struct LeverageBook<phantom Quote> has key {
    id: UID,
    positions: Table<u64, Ticket<Quote>>,
    next_id: u64,
}

/// One turbo ticket. `funds` seals margin + reserve — every coin that can ever
/// leave the position is inside it from open. `store`-only: lives in the book's
/// table and is consumed on close.
///
/// tp_value / sl_value: live bid·qty levels at which the ticket closes
/// permissionlessly (0 = disabled). Set at open or via set_tp_sl.
public struct Ticket<phantom Quote> has store {
    owner: address,
    funds: Balance<Quote>,
    margin: u64,
    basis: u64,
    reserved: u64,
    qty: u64,
    // market key (binary: strike/is_up; range: lower/higher)
    oracle_id: ID,
    expiry: u64,
    is_range: bool,
    strike: u64,
    is_up: bool,
    lower: u64,
    higher: u64,
    maint_bps: u64,
    opened_at: u64,
    // conditional exits (0 = not set)
    tp_value: u64,
    sl_value: u64,
    // set to true while this ticket is part of an active combo
    locked: bool,
}

/// Holds resting limit-entry orders with sealed escrow. An order fills
/// permissionlessly when the vault's ask crosses limit_basis.
public struct LimitBook<phantom Quote> has key {
    id: UID,
    orders: Table<u64, LimitOrder<Quote>>,
    next_id: u64,
}

/// A single limit-entry order. Escrow = margin committed; fills when the ask
/// for (oracle_id, expiry, key, qty) is ≤ limit_basis. order_ttl is the
/// wall-clock ms timestamp after which the order can be expired by anyone.
public struct LimitOrder<phantom Quote> has store {
    owner: address,
    escrow: Balance<Quote>,
    oracle_id: ID,
    expiry: u64,
    is_range: bool,
    strike: u64,
    is_up: bool,
    lower: u64,
    higher: u64,
    qty: u64,
    maint_bps: u64,
    limit_basis: u64,
    order_ttl: u64,
    tp_value: u64,
    sl_value: u64,
}

// === Pure math (the entire money flow — unit-tested exhaustively) ===

fun mul_bps(x: u64, bps: u64): u64 { (((x as u128) * (bps as u128)) / BPS) as u64 }

/// Dynamic force-close window τ_c in ms (model §6.2 eq. 8).
///
/// τ_c = [3·(qty/margin)·φ(0)/(1−θ)]²·5s
///     = 716_045_445_000·qty² / (denom_bps²·margin²)   ms
///
/// Conservative ATM upper bound: φ(0) ≈ 3989/10000, z=3, Δt=5 s.
/// Floored at FORCE_WINDOW_MS (resolution-risk minimum, §6.3).
fun force_close_window_ms(qty: u64, margin: u64, maint_bps: u64): u64 {
    let denom_bps = BPS - (maint_bps as u128);
    let num = 716_045_445_000u128 * (qty as u128) * (qty as u128);
    let den = denom_bps * denom_bps * (margin as u128) * (margin as u128);
    let tc = num / den;
    // Cap at 24 h; floor at the resolution-risk minimum.
    let capped = if (tc > 86_400_000u128) { 86_400_000u64 } else { tc as u64 };
    if (capped > FORCE_WINDOW_MS) { capped } else { FORCE_WINDOW_MS }
}

/// Per-epoch maintenance fee (model §7 eq. 12, κ=1).
///
/// f_epoch = basis·p(1−p)·Δt / τ
///
/// Fires when equity falls below this: the position can no longer afford
/// one more monitoring interval at the current mark and remaining tenor.
/// Returns 0 for degenerate inputs (mark at boundary, zero tau).
fun epoch_fee(basis: u64, qty: u64, value: u64, tau_ms: u64): u64 {
    if (value == 0 || value >= qty || tau_ms == 0) return 0;
    // p_bps = p scaled to BPS; pp = p(1−p) in 1/BPS units (max ≈ 2500 at ATM).
    let p_bps = (value as u128) * BPS / (qty as u128);
    let pp = p_bps * (BPS - p_bps) / BPS;
    // f_epoch = basis·pp·Δt / (BPS·τ)
    let num = (basis as u128) * pp * (EPOCH_DELTA_MS as u128);
    let den = BPS * (tau_ms as u128);
    (num / den) as u64
}

/// Ticket equity at mark-value `value` (= bid·qty, raw quote units):
/// clip(margin + value − basis, 0, margin + reserved).
public fun equity_of(margin: u64, basis: u64, value: u64, reserved: u64): u64 {
    let up = margin + value;
    if (up <= basis) return 0;
    let x = up - basis;
    let cap = margin + reserved;
    if (x > cap) cap else x
}

/// Knockout test: X ≤ maint_bps·margin/1e4 ⇔ value + margin ≤ basis + maint·margin
/// (all-additive form — no underflow).
public fun is_liquidatable_at(margin: u64, basis: u64, value: u64, maint_bps: u64): bool {
    value + margin <= basis + mul_bps(margin, maint_bps)
}

/// Settlement split for any exit. Returns (to_owner, to_insurance); the pool
/// keeps `margin + reserved − to_owner − to_insurance`.
///   close/force-close : perf fee on profit only (stays with the pool as LP yield)
///   liquidation       : penalty = min(X, penalty_bps·margin) → insurance,
///                       residual rebate → owner (model §2; kinder than confiscation
///                       and keeps Prop. 3's expected-cost identity exact)
public fun settle_amounts(
    margin: u64,
    basis: u64,
    reserved: u64,
    value: u64,
    perf_bps: u64,
    penalty_bps: u64,
    is_liquidation: bool,
): (u64, u64) {
    let x = equity_of(margin, basis, value, reserved);
    if (is_liquidation) {
        let penalty = mul_bps(margin, penalty_bps).min(x);
        (x - penalty, penalty)
    } else {
        let perf = if (x > margin) mul_bps(x - margin, perf_bps) else 0;
        (x - perf, 0)
    }
}

// === Pool lifecycle ===

/// Create and share a margin pool. Fee/penalty schedule is fixed at creation so
/// every later flow is permissionless without parameter games.
public fun create_pool<Quote>(
    perf_bps: u64,
    penalty_bps: u64,
    open_fee_bps: u64,
    ctx: &mut TxContext,
): ID {
    let pool = MarginPool<Quote> {
        id: object::new(ctx),
        liquidity: balance::zero(),
        reserved_out: 0,
        insurance: balance::zero(),
        total_shares: 0,
        perf_bps,
        penalty_bps,
        open_fee_bps,
    };
    let pool_id = object::id(&pool);
    event::emit(PoolCreated { pool_id, perf_bps, penalty_bps, open_fee_bps });
    transfer::share_object(pool);
    pool_id
}

/// Create and share the ticket book.
public fun create_book<Quote>(ctx: &mut TxContext): ID {
    let book = LeverageBook<Quote> { id: object::new(ctx), positions: table::new(ctx), next_id: 0 };
    let book_id = object::id(&book);
    transfer::share_object(book);
    book_id
}

/// Create and share the limit-entry order book.
public fun create_limit_book<Quote>(ctx: &mut TxContext): ID {
    let lb = LimitBook<Quote> { id: object::new(ctx), orders: table::new(ctx), next_id: 0 };
    let limit_book_id = object::id(&lb);
    event::emit(LimitBookCreated { limit_book_id });
    transfer::share_object(lb);
    limit_book_id
}

/// Supply quote; mint LP shares pro-rata to pool value.
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

/// Burn an LP share; withdraw the pro-rata value from IDLE liquidity only
/// (capital locked as ticket reserves cannot be pulled out from under traders).
public fun withdraw<Quote>(pool: &mut MarginPool<Quote>, share: LpShare<Quote>, ctx: &mut TxContext): Coin<Quote> {
    let LpShare { id, pool_id, shares } = share;
    assert!(pool_id == object::id(pool), EWrongPool);
    id.delete();
    let amount = (((shares as u128) * (pool_value(pool) as u128)) / (pool.total_shares as u128)) as u64;
    assert!(pool.liquidity.value() >= amount, EInsufficientLiquidity);
    pool.total_shares = pool.total_shares - shares;
    pool.liquidity.split(amount).into_coin(ctx)
}

// === Pool internals ===

/// Lock `amount` of idle liquidity as a ticket reserve.
public(package) fun reserve<Quote>(pool: &mut MarginPool<Quote>, amount: u64): Balance<Quote> {
    assert!(pool.liquidity.value() >= amount, EInsufficientLiquidity);
    pool.reserved_out = pool.reserved_out + amount;
    pool.liquidity.split(amount)
}

/// Return a ticket's remaining funds and release its reserve from the books.
/// `funds` < reserve ⇒ realized pool loss (the trader won — paid from the
/// reserve locked at open, never from anyone else); > ⇒ realized pool profit.
public(package) fun release<Quote>(pool: &mut MarginPool<Quote>, reserved: u64, funds: Balance<Quote>) {
    pool.reserved_out = pool.reserved_out - reserved;
    pool.liquidity.join(funds);
}

// === Open ===

/// Open a turbo ticket on a binary (continuous-strike) key. Trader-signed —
/// no keeper, no manager: the pool is the counterparty and the mark is read
/// from Predict's public quote. Returns the position id.
///
/// tp_value / sl_value: bid·qty levels for permissionless conditional close
/// (0 = disabled). Can also be set/updated later via set_tp_sl.
public fun open_binary<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    margin: Coin<Quote>,
    qty: u64,
    maint_bps: u64,
    tp_value: u64,
    sl_value: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    let key = market_key::new(oracle_id, expiry, strike, is_up);
    let (basis, _bid) = predict::get_trade_amounts(predict, oracle, key, qty, clock);
    open_ticket(pool, book, ctx.sender(), basis, oracle_id, expiry, false, strike, is_up, 0, 0, margin, qty, maint_bps, tp_value, sl_value, clock, ctx)
}

/// Open a turbo ticket on a vertical-range key.
public fun open_range<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    margin: Coin<Quote>,
    qty: u64,
    maint_bps: u64,
    tp_value: u64,
    sl_value: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    let key = range_key::new(oracle_id, expiry, lower, higher);
    let (basis, _bid) = predict::get_range_trade_amounts(predict, oracle, key, qty, clock);
    open_ticket(pool, book, ctx.sender(), basis, oracle_id, expiry, true, 0, false, lower, higher, margin, qty, maint_bps, tp_value, sl_value, clock, ctx)
}

public(package) fun open_ticket<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    owner: address,
    basis: u64,
    oracle_id: ID,
    expiry: u64,
    is_range: bool,
    strike: u64,
    is_up: bool,
    lower: u64,
    higher: u64,
    mut margin: Coin<Quote>,
    qty: u64,
    maint_bps: u64,
    tp_value: u64,
    sl_value: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    assert!(qty > 0, EZeroQuantity);
    assert!(maint_bps > 0 && maint_bps <= MAX_MAINT_BPS, EBadMaintenance);
    // Max payout of qty contracts is qty (raw quote units: $1 each).
    assert!(basis < qty, EBasisTooHigh);

    // Open fee → insurance; remainder is the working margin.
    let gross = margin.value();
    assert!(gross > 0, EZeroMargin);
    let fee = mul_bps(gross, pool.open_fee_bps);
    if (fee > 0) { pool.insurance.join(margin.split(fee, ctx).into_balance()); };
    let m = margin.value();
    assert!(m > 0, EZeroMargin);
    assert!(basis <= mul_bps(m, MAX_LEVERAGE_BPS), ELeverageTooHigh);

    // Reject opens inside the dynamic force-close window (§6.2).
    // Uses net margin m so the window accounts for the actual leverage.
    let window_ms = force_close_window_ms(qty, m, maint_bps);
    assert!(clock.timestamp_ms() + window_ms < expiry, ETooCloseToExpiry);

    // Seal margin + full reserve into the ticket (Prop. 2: nothing can ever be owed).
    let reserved = qty - basis;
    let mut funds = margin.into_balance();
    funds.join(reserve(pool, reserved));

    let position_id = book.next_id;
    book.next_id = position_id + 1;
    book.positions.add(position_id, Ticket<Quote> {
        owner,
        funds,
        margin: m,
        basis,
        reserved,
        qty,
        oracle_id,
        expiry,
        is_range,
        strike,
        is_up,
        lower,
        higher,
        maint_bps,
        opened_at: clock.timestamp_ms(),
        tp_value,
        sl_value,
        locked: false,
    });
    event::emit(TicketOpened {
        book_id: object::id(book),
        position_id,
        owner,
        is_range,
        qty,
        margin: m,
        basis,
        reserved,
        maint_bps,
        expiry,
        tp_value,
        sl_value,
        force_window_ms: window_ms,
    });
    position_id
}

// === TP / SL ===

/// Owner-signed: set or update the conditional-exit levels. Pass 0 to disable.
/// tp_value: close when live bid·qty >= tp_value (take-profit).
/// sl_value: close when live bid·qty <= sl_value (stop-loss; must be > 0 to enable).
public fun set_tp_sl<Quote>(
    book: &mut LeverageBook<Quote>,
    position_id: u64,
    tp_value: u64,
    sl_value: u64,
    ctx: &TxContext,
) {
    assert!(book.positions[position_id].owner == ctx.sender(), ENotOwner);
    let book_id = object::id(book);
    let pos = &mut book.positions[position_id];
    pos.tp_value = tp_value;
    pos.sl_value = sl_value;
    event::emit(TpSlUpdated { book_id, position_id, tp_value, sl_value });
}

// === Combo integration ===

/// Package-only: lock a ticket so the owner cannot close it independently.
/// Called by vault::request_combo_with_leverage when the ticket joins a combo.
public(package) fun lock_for_combo<Quote>(
    book: &mut LeverageBook<Quote>,
    position_id: u64,
    caller: address,
) {
    let pos = &mut book.positions[position_id];
    assert!(pos.owner == caller, ENotOwner);
    pos.locked = true;
}

/// Package-only: settle a combo-locked ticket and return the equity paid to owner.
/// Mirrors `settle` but is callable by the vault on behalf of the combo keeper.
/// Funds flow: insurance/perf fees → pool; equity → owner (transferred here).
/// Returns `to_owner` so the vault can record it in combo.record_settlement.
public(package) fun settle_for_combo<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    let pos = &book.positions[position_id];
    let value = ticket_value(pos, predict, oracle, clock);
    let Ticket {
        owner, mut funds, margin, basis, reserved,
        qty: _, oracle_id: _, expiry: _, is_range: _, strike: _, is_up: _,
        lower: _, higher: _, maint_bps: _, opened_at: _, tp_value: _, sl_value: _, locked: _,
    } = book.positions.remove(position_id);
    let book_id = object::id(book);
    let (to_owner, to_insurance) =
        settle_amounts(margin, basis, reserved, value, pool.perf_bps, pool.penalty_bps, false);
    let equity = to_owner + to_insurance;
    if (to_owner > 0) {
        transfer::public_transfer(funds.split(to_owner).into_coin(ctx), owner);
    };
    if (to_insurance > 0) { pool.insurance.join(funds.split(to_insurance)); };
    let returned = funds.value();
    release(pool, reserved, funds);
    event::emit(TicketClosed {
        book_id,
        position_id,
        owner,
        value,
        equity,
        to_owner,
        to_insurance,
        returned_to_pool: returned,
        liquidated: false,
    });
    to_owner
}

/// Permissionless take-profit execution. Fires when live bid·qty >= ticket.tp_value.
/// Settles with close semantics (perf fee on profit, no penalty).
public fun execute_tp<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let pos = &book.positions[position_id];
    let tp = pos.tp_value;
    assert!(tp > 0, EConditionNotMet);
    let value = ticket_value(pos, predict, oracle, clock);
    assert!(value >= tp, EConditionNotMet);
    settle(pool, book, predict, oracle, position_id, false, clock, ctx);
}

/// Permissionless stop-loss execution. Fires when live bid·qty <= ticket.sl_value.
/// Settles with close semantics (perf fee on profit, no penalty).
public fun execute_sl<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let pos = &book.positions[position_id];
    let sl = pos.sl_value;
    assert!(sl > 0, EConditionNotMet);
    let value = ticket_value(pos, predict, oracle, clock);
    assert!(value <= sl, EConditionNotMet);
    settle(pool, book, predict, oracle, position_id, false, clock, ctx);
}

// === Limit orders ===

/// Place a binary limit-entry order. Margin is escrowed immediately; the order
/// fills permissionlessly when `get_trade_amounts` returns basis ≤ limit_basis.
/// order_ttl: ms timestamp after which the order expires (anyone may call expire_limit).
/// tp_value / sl_value: forwarded to the opened ticket (0 = disabled).
#[allow(lint(self_transfer))]
public fun place_limit_binary<Quote>(
    limit_book: &mut LimitBook<Quote>,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    qty: u64,
    maint_bps: u64,
    limit_basis: u64,
    order_ttl: u64,
    tp_value: u64,
    sl_value: u64,
    escrow: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    place_order(limit_book, ctx.sender(), false, oracle_id, expiry, strike, is_up, 0, 0, qty, maint_bps, limit_basis, order_ttl, tp_value, sl_value, escrow, clock)
}

/// Place a range limit-entry order.
#[allow(lint(self_transfer))]
public fun place_limit_range<Quote>(
    limit_book: &mut LimitBook<Quote>,
    oracle_id: ID,
    expiry: u64,
    lower: u64,
    higher: u64,
    qty: u64,
    maint_bps: u64,
    limit_basis: u64,
    order_ttl: u64,
    tp_value: u64,
    sl_value: u64,
    escrow: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    place_order(limit_book, ctx.sender(), true, oracle_id, expiry, 0, false, lower, higher, qty, maint_bps, limit_basis, order_ttl, tp_value, sl_value, escrow, clock)
}

fun place_order<Quote>(
    limit_book: &mut LimitBook<Quote>,
    owner: address,
    is_range: bool,
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
    lower: u64,
    higher: u64,
    qty: u64,
    maint_bps: u64,
    limit_basis: u64,
    order_ttl: u64,
    tp_value: u64,
    sl_value: u64,
    escrow: Coin<Quote>,
    clock: &Clock,
): u64 {
    assert!(qty > 0, EZeroQuantity);
    assert!(maint_bps > 0 && maint_bps <= MAX_MAINT_BPS, EBadMaintenance);
    assert!(clock.timestamp_ms() < order_ttl, EOrderExpired);
    let escrow_amount = escrow.value();
    assert!(escrow_amount > 0, EZeroMargin);
    let order_id = limit_book.next_id;
    limit_book.next_id = order_id + 1;
    limit_book.orders.add(order_id, LimitOrder<Quote> {
        owner,
        escrow: escrow.into_balance(),
        oracle_id,
        expiry,
        is_range,
        strike,
        is_up,
        lower,
        higher,
        qty,
        maint_bps,
        limit_basis,
        order_ttl,
        tp_value,
        sl_value,
    });
    event::emit(LimitOrderPlaced {
        limit_book_id: object::id(limit_book),
        order_id,
        owner,
        is_range,
        qty,
        escrow: escrow_amount,
        limit_basis,
        order_ttl,
    });
    order_id
}

/// Permissionless fill: opens a turbo ticket for the order owner when the live
/// ask crosses limit_basis. Aborts if the order is expired or condition unmet.
public fun execute_limit<Quote>(
    pool: &mut MarginPool<Quote>,
    leverage_book: &mut LeverageBook<Quote>,
    limit_book: &mut LimitBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    order_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let order = &limit_book.orders[order_id];
    assert!(clock.timestamp_ms() <= order.order_ttl, EOrderExpired);

    // Fetch live ask and verify the condition.
    let basis = if (order.is_range) {
        let key = range_key::new(order.oracle_id, order.expiry, order.lower, order.higher);
        let (ask, _) = predict::get_range_trade_amounts(predict, oracle, key, order.qty, clock);
        ask
    } else {
        let key = market_key::new(order.oracle_id, order.expiry, order.strike, order.is_up);
        let (ask, _) = predict::get_trade_amounts(predict, oracle, key, order.qty, clock);
        ask
    };
    assert!(basis <= order.limit_basis, ELimitNotCrossed);

    // Extract order fields, remove from book.
    let LimitOrder {
        owner, escrow, oracle_id, expiry, is_range, strike, is_up, lower, higher,
        qty, maint_bps, limit_basis: _, order_ttl: _, tp_value, sl_value,
    } = limit_book.orders.remove(order_id);

    let limit_book_id = object::id(limit_book);
    let margin = escrow.into_coin(ctx);

    // Open the ticket on behalf of the original owner.
    let position_id = open_ticket(
        pool, leverage_book, owner, basis,
        oracle_id, expiry, is_range, strike, is_up, lower, higher,
        margin, qty, maint_bps, tp_value, sl_value, clock, ctx,
    );

    event::emit(LimitOrderExecuted { limit_book_id, order_id, owner, position_id, basis });
}

/// Owner cancels a resting order and recovers the escrow.
public fun cancel_limit<Quote>(
    limit_book: &mut LimitBook<Quote>,
    order_id: u64,
    ctx: &mut TxContext,
): Coin<Quote> {
    assert!(limit_book.orders[order_id].owner == ctx.sender(), ENotOwner);
    let LimitOrder { owner, escrow, .. } = limit_book.orders.remove(order_id);
    let refunded = escrow.value();
    event::emit(LimitOrderCancelled {
        limit_book_id: object::id(limit_book),
        order_id,
        owner,
        refunded,
    });
    escrow.into_coin(ctx)
}

/// Anyone may expire an order whose TTL has elapsed; escrow is returned to the owner.
public fun expire_limit<Quote>(
    limit_book: &mut LimitBook<Quote>,
    order_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<Quote> {
    let order = &limit_book.orders[order_id];
    assert!(clock.timestamp_ms() > order.order_ttl, EOrderExpired);
    let owner = order.owner;
    let LimitOrder { owner: _, escrow, .. } = limit_book.orders.remove(order_id);
    let refunded = escrow.value();
    event::emit(LimitOrderCancelled {
        limit_book_id: object::id(limit_book),
        order_id,
        owner,
        refunded,
    });
    escrow.into_coin(ctx)
}

// === Margin management ===

/// Top up a ticket's margin: lowers the knockout barrier and raises the equity
/// cap. Permissionless — adding funds only de-risks.
public fun add_margin<Quote>(book: &mut LeverageBook<Quote>, position_id: u64, payment: Coin<Quote>) {
    let pos = &mut book.positions[position_id];
    pos.margin = pos.margin + payment.value();
    pos.funds.join(payment.into_balance());
}

// === Close / liquidate / force-close ===

/// Owner-signed voluntary close at the live bid.
public fun close<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let pos = &book.positions[position_id];
    assert!(pos.owner == ctx.sender(), ENotOwner);
    assert!(!pos.locked, ELockedInCombo);
    settle(pool, book, predict, oracle, position_id, false, clock, ctx);
}

/// Permissionless liquidation — health is verified on-chain from the live bid
/// BEFORE settling, so a healthy ticket cannot be touched by anyone.
public fun liquidate<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let pos = &book.positions[position_id];
    let value = ticket_value(pos, predict, oracle, clock);
    assert!(is_liquidatable_at(pos.margin, pos.basis, value, pos.maint_bps), ENotLiquidatable);
    settle(pool, book, predict, oracle, position_id, true, clock, ctx);
}

/// Permissionless force-close. Eligible when either condition holds (§6.2/§7):
///   (a) remaining tenor < dynamic τ_c window (leverage × mark × keeper latency), OR
///   (b) current equity < next epoch fee (position can't afford another monitoring interval).
/// No penalty — close semantics (perf fee on profit only).
public fun force_close<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    position_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let pos = &book.positions[position_id];
    let expiry = pos.expiry;
    let now = clock.timestamp_ms();
    let window_ms = force_close_window_ms(pos.qty, pos.margin, pos.maint_bps);

    // Condition (a): inside the dynamic τ_c window.
    let in_window = now + window_ms >= expiry;
    if (!in_window) {
        // Condition (b): equity < epoch fee — too expensive to hold one more interval.
        let value = ticket_value(pos, predict, oracle, clock);
        let tau_ms = if (expiry > now) { expiry - now } else { 1 };
        let fee = epoch_fee(pos.basis, pos.qty, value, tau_ms);
        let equity = equity_of(pos.margin, pos.basis, value, pos.reserved);
        assert!(equity < fee, EForceWindowNotReached);
    };

    settle(pool, book, predict, oracle, position_id, false, clock, ctx);
}

/// Shared settlement: value at the live bid → pure split → pay out → release
/// the reserve. Total outflow can never exceed the ticket's sealed funds.
public(package) fun settle<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    position_id: u64,
    is_liquidation: bool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let pos = &book.positions[position_id];
    let value = ticket_value(pos, predict, oracle, clock);

    let Ticket {
        owner, mut funds, margin, basis, reserved, qty: _, oracle_id: _, expiry: _,
        is_range: _, strike: _, is_up: _, lower: _, higher: _, maint_bps: _, opened_at: _,
        tp_value: _, sl_value: _, locked: _,
    } = book.positions.remove(position_id);

    let (to_owner, to_insurance) =
        settle_amounts(margin, basis, reserved, value, pool.perf_bps, pool.penalty_bps, is_liquidation);
    let equity = to_owner + to_insurance;

    if (to_owner > 0) {
        transfer::public_transfer(funds.split(to_owner).into_coin(ctx), owner);
    };
    if (to_insurance > 0) {
        pool.insurance.join(funds.split(to_insurance));
    };
    let returned = funds.value();
    release(pool, reserved, funds);

    event::emit(TicketClosed {
        book_id: object::id(book),
        position_id,
        owner,
        value,
        equity,
        to_owner,
        to_insurance,
        returned_to_pool: returned,
        liquidated: is_liquidation,
    });
}

/// Live bid value of a ticket's key for its full quantity.
fun ticket_value<Quote>(pos: &Ticket<Quote>, predict: &Predict, oracle: &OracleSVI, clock: &Clock): u64 {
    if (pos.is_range) {
        let key = range_key::new(pos.oracle_id, pos.expiry, pos.lower, pos.higher);
        let (_ask, bid) = predict::get_range_trade_amounts(predict, oracle, key, pos.qty, clock);
        bid
    } else {
        let key = market_key::new(pos.oracle_id, pos.expiry, pos.strike, pos.is_up);
        let (_ask, bid) = predict::get_trade_amounts(predict, oracle, key, pos.qty, clock);
        bid
    }
}

// === Getters ===

public fun pool_value<Quote>(pool: &MarginPool<Quote>): u64 { pool.liquidity.value() + pool.reserved_out }
public fun pool_liquidity<Quote>(pool: &MarginPool<Quote>): u64 { pool.liquidity.value() }
public fun pool_reserved<Quote>(pool: &MarginPool<Quote>): u64 { pool.reserved_out }
public fun pool_insurance<Quote>(pool: &MarginPool<Quote>): u64 { pool.insurance.value() }
public fun pool_total_shares<Quote>(pool: &MarginPool<Quote>): u64 { pool.total_shares }
public fun lp_shares<Quote>(share: &LpShare<Quote>): u64 { share.shares }

public fun has_position<Quote>(book: &LeverageBook<Quote>, id: u64): bool { book.positions.contains(id) }
public fun position_owner<Quote>(book: &LeverageBook<Quote>, id: u64): address { book.positions[id].owner }
public fun position_margin<Quote>(book: &LeverageBook<Quote>, id: u64): u64 { book.positions[id].margin }
public fun position_basis<Quote>(book: &LeverageBook<Quote>, id: u64): u64 { book.positions[id].basis }
public fun position_reserved<Quote>(book: &LeverageBook<Quote>, id: u64): u64 { book.positions[id].reserved }
public fun position_funds<Quote>(book: &LeverageBook<Quote>, id: u64): u64 { book.positions[id].funds.value() }
public fun position_tp<Quote>(book: &LeverageBook<Quote>, id: u64): u64 { book.positions[id].tp_value }
public fun position_sl<Quote>(book: &LeverageBook<Quote>, id: u64): u64 { book.positions[id].sl_value }

/// Current dynamic force-close window for a position (re-derived on the fly from
/// stored qty/margin/maint_bps). Keeper calls force_close by expiry − this value.
public fun position_force_window<Quote>(book: &LeverageBook<Quote>, id: u64): u64 {
    let p = &book.positions[id];
    force_close_window_ms(p.qty, p.margin, p.maint_bps)
}

public fun has_order<Quote>(lb: &LimitBook<Quote>, id: u64): bool { lb.orders.contains(id) }
public fun order_owner<Quote>(lb: &LimitBook<Quote>, id: u64): address { lb.orders[id].owner }
public fun order_escrow<Quote>(lb: &LimitBook<Quote>, id: u64): u64 { lb.orders[id].escrow.value() }
public fun order_limit_basis<Quote>(lb: &LimitBook<Quote>, id: u64): u64 { lb.orders[id].limit_basis }

/// Live health view: (value, liquidation threshold value). Liquidatable iff
/// value + margin ≤ basis + maint·margin — i.e. value ≤ threshold.
public fun position_health<Quote>(
    book: &LeverageBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    id: u64,
    clock: &Clock,
): (u64, u64) {
    let pos = &book.positions[id];
    let value = ticket_value(pos, predict, oracle, clock);
    let threshold = pos.basis + mul_bps(pos.margin, pos.maint_bps) - pos.margin;
    (value, threshold)
}

// === Test-only ===

#[test_only]
public fun mul_bps_for_testing(x: u64, bps: u64): u64 { mul_bps(x, bps) }

#[test_only]
public fun force_close_window_ms_for_testing(qty: u64, margin: u64, maint_bps: u64): u64 {
    force_close_window_ms(qty, margin, maint_bps)
}

#[test_only]
public fun epoch_fee_for_testing(basis: u64, qty: u64, value: u64, tau_ms: u64): u64 {
    epoch_fee(basis, qty, value, tau_ms)
}

#[test_only]
/// Seed the insurance fund directly (unit tests have no open-fee flow).
public fun seed_insurance_for_testing<Quote>(pool: &mut MarginPool<Quote>, funds: Balance<Quote>) {
    pool.insurance.join(funds);
}

#[test_only]
/// Insert a ticket without Predict (basis/value supplied by the test). Funds
/// must equal margin + reserved, with the reserve drawn from the pool.
/// Pass expiry=0 for tests that don't need force-close timing; otherwise
/// pass a future timestamp (ms) to test dynamic force-window logic.
public fun open_for_testing<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    owner: address,
    margin: Coin<Quote>,
    basis: u64,
    qty: u64,
    maint_bps: u64,
    expiry: u64,
): u64 {
    let m = margin.value();
    let reserved = qty - basis;
    let mut funds = margin.into_balance();
    funds.join(reserve(pool, reserved));
    let position_id = book.next_id;
    book.next_id = position_id + 1;
    book.positions.add(position_id, Ticket<Quote> {
        owner, funds, margin: m, basis, reserved, qty,
        oracle_id: object::id_from_address(@0xABC), expiry, is_range: false,
        strike: 0, is_up: true, lower: 0, higher: 0, maint_bps, opened_at: 0,
        tp_value: 0, sl_value: 0,
    });
    position_id
}

#[test_only]
/// Settle a ticket at a test-supplied value (no Predict), mirroring `settle`.
public fun settle_for_testing<Quote>(
    pool: &mut MarginPool<Quote>,
    book: &mut LeverageBook<Quote>,
    position_id: u64,
    value: u64,
    is_liquidation: bool,
    ctx: &mut TxContext,
): (u64, u64, u64) {
    let Ticket { owner, mut funds, margin, basis, reserved, .. } = book.positions.remove(position_id);
    let (to_owner, to_insurance) =
        settle_amounts(margin, basis, reserved, value, pool.perf_bps, pool.penalty_bps, is_liquidation);
    if (to_owner > 0) {
        transfer::public_transfer(funds.split(to_owner).into_coin(ctx), owner);
    };
    if (to_insurance > 0) { pool.insurance.join(funds.split(to_insurance)); };
    let returned = funds.value();
    release(pool, reserved, funds);
    (to_owner, to_insurance, returned)
}
