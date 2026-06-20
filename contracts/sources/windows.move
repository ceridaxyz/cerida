/// Rolling-window range market — Cerida's POOLED band product. Each epoch
/// exposes a shared ladder of price bands; users buy band payoffs, the LP pool
/// earns spread+skew, and Predict covers the winning payouts.
///
/// ── Responsibility boundary (read with vault.move) ─────────────────────────
/// This module owns ONLY: band pricing, bet recording, LP-pool accounting, and
/// the epoch lifecycle (roll → settle). It NEVER touches Predict directly —
/// every Predict mint/redeem is owner-gated and routed through the vault keeper.
/// The full bet→hedge→settle→claim lifecycle spans BOTH files:
///   * `vault::execute_window_bet`   mints the Predict range hedge, then calls
///                                   `compute_bet_price` + `record_bet` here.
///   * `vault::execute_epoch_payout` redeems the Predict position after `settle_epoch`,
///                                   parks proceeds in `vault.settlements[epoch]`.
///   * `vault::claim_window_bet`     permissionless winner claim from settlements.
/// So this module on its own is intentionally incomplete: no hedge custody and
/// no payout path live here, by design.
///
/// ── Terms & money flow (de-overloaded) ─────────────────────────────────────
///   basis       user's total payment for a bet  =  svi_ask + spread + skew
///   svi_ask     fair value from Predict's range pricing; funds the hedge mint.
///               Lives in Predict, NOT in `pool`.
///   spread+skew LP revenue (passed in as `lp_revenue`); the ONLY money that
///               ever enters `pool`.
///   skew        inventory control — an over-bought band is priced higher.
///   pool        LP principal + accrued spread/skew revenue. Holds NO payout
///               reserve: Predict covers winners, so the pool carries zero
///               directional risk. (One balance, two roles — principal and
///               revenue — tracked together; LP shares are pro-rata over both.)
///
/// Band boundaries are an INPUT to `roll_epoch` (any monotonic ladder). The
/// off-chain equal-probability quantile (mark ≈ 1/N) is the default, not a
/// constraint.
module cerida::windows;

use deepbook_predict::{
    i64,
    oracle::{Self, OracleSVI, OracleSVICap, SVIParams, PriceData},
    predict::{Self, Predict},
    range_key,
};
use sui::{
    balance::{Self, Balance},
    clock::Clock,
    coin::{Self, Coin},
    event,
    table::{Self, Table},
};

// ── Constants ─────────────────────────────────────────────────────────────────

const PRICE_SCALE: u64 = 1_000_000_000;
const BPS: u64 = 10_000;

// ── Errors ────────────────────────────────────────────────────────────────────

const EStrikesLength: u64 = 0;
const EEpochExpired: u64 = 1;
const EEpochNotFound: u64 = 2;
const EEpochAlreadySettled: u64 = 3;
const EBandOutOfRange: u64 = 4;
const EZeroQty: u64 = 5;
const ESlippage: u64 = 6;
/// `lp_revenue` passed to `record_bet` doesn't equal `total_basis - svi_ask` —
/// the vault split the user's payment incorrectly.
const EBasisMismatch: u64 = 7;
const ENotSettled: u64 = 8;
const ETicketMismatch: u64 = 9;
const EZeroShares: u64 = 10;

// ── Core objects ──────────────────────────────────────────────────────────────

public struct WindowBook<phantom Quote> has key {
    id: UID,
    oracle_cap: OracleSVICap,
    band_count: u64,
    spread_bps: u64,
    skew_alpha_bps: u64,
    epochs: Table<u64, Epoch>,
    next_epoch_id: u64,
    /// LP capital plus accumulated spread/skew revenue. Predict covers payouts
    /// so no worst-case reservation is tracked here.
    pool: Balance<Quote>,
    total_lp_shares: u64,
}

public struct Epoch has store {
    oracle_id: ID,
    expiry: u64,
    strikes: vector<u64>,
    qty_sold: vector<u64>,
    basis_collected: vector<u64>,
    total_qty: u64,
    bets: Table<u64, Bet>,
    next_bet_id: u64,
    winning_band: Option<u64>,
    settled: bool,
}

public struct Bet has store {
    owner: address,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    basis: u64,
}

/// Transferable claim on a bet.
public struct BetTicket has key, store {
    id: UID,
    book_id: ID,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    basis: u64,
}

public struct WindowLpShare has key, store {
    id: UID,
    book_id: ID,
    shares: u64,
}

// ── Events ────────────────────────────────────────────────────────────────────

public struct EpochRolled has copy, drop {
    book_id: ID,
    epoch_id: u64,
    oracle_id: ID,
    expiry: u64,
    strikes: vector<u64>,
}

public struct BetPlaced has copy, drop {
    book_id: ID,
    epoch_id: u64,
    bet_id: u64,
    band_idx: u64,
    qty: u64,
    basis: u64,
    adjusted_mark: u64,
    skew_bps: u64,
}

public struct EpochSettled has copy, drop {
    book_id: ID,
    epoch_id: u64,
    settlement_price: u64,
    winning_band: Option<u64>,
}

public struct PayoutClaimed has copy, drop {
    book_id: ID,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    payout: u64,
    owner: address,
}

// ── Creation ──────────────────────────────────────────────────────────────────

public fun create_window_book<Quote>(
    oracle_cap: OracleSVICap,
    band_count: u64,
    spread_bps: u64,
    skew_alpha_bps: u64,
    ctx: &mut TxContext,
): WindowBook<Quote> {
    WindowBook {
        id: object::new(ctx),
        oracle_cap,
        band_count,
        spread_bps,
        skew_alpha_bps,
        epochs: table::new(ctx),
        next_epoch_id: 0,
        pool: balance::zero(),
        total_lp_shares: 0,
    }
}

public fun create_and_share<Quote>(
    oracle_cap: OracleSVICap,
    band_count: u64,
    spread_bps: u64,
    skew_alpha_bps: u64,
    ctx: &mut TxContext,
): ID {
    let book = create_window_book<Quote>(oracle_cap, band_count, spread_bps, skew_alpha_bps, ctx);
    let id = object::id(&book);
    sui::transfer::share_object(book);
    id
}

// ── Oracle feeding ────────────────────────────────────────────────────────────

public fun feed_prices<Quote>(
    book: &WindowBook<Quote>,
    oracle: &mut OracleSVI,
    prices: PriceData,
    clock: &Clock,
) {
    oracle::update_prices(oracle, &book.oracle_cap, prices, clock);
}

public fun feed_svi<Quote>(
    book: &WindowBook<Quote>,
    oracle: &mut OracleSVI,
    svi: SVIParams,
    clock: &Clock,
) {
    oracle::update_svi(oracle, &book.oracle_cap, svi, clock);
}

// ── Epoch rolling ─────────────────────────────────────────────────────────────

public fun roll_epoch<Quote>(
    book: &mut WindowBook<Quote>,
    oracle_id: ID,
    expiry: u64,
    strikes: vector<u64>,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    assert!(strikes.length() == book.band_count + 1, EStrikesLength);
    assert!(clock.timestamp_ms() < expiry, EEpochExpired);

    let n = book.band_count;
    let mut qty_sold = vector[];
    let mut basis_collected = vector[];
    n.do!(|_| {
        qty_sold.push_back(0u64);
        basis_collected.push_back(0u64);
    });

    let epoch_id = book.next_epoch_id;
    book.next_epoch_id = epoch_id + 1;

    event::emit(EpochRolled { book_id: object::id(book), epoch_id, oracle_id, expiry, strikes });

    book.epochs.add(epoch_id, Epoch {
        oracle_id,
        expiry,
        strikes,
        qty_sold,
        basis_collected,
        total_qty: 0,
        bets: table::new(ctx),
        next_bet_id: 0,
        winning_band: option::none(),
        settled: false,
    });

    epoch_id
}

// ── Settlement ────────────────────────────────────────────────────────────────

/// Permissionless: records the winning band once the oracle is settled.
/// Fund distribution is handled separately by vault::execute_epoch_payout.
public fun settle_epoch<Quote>(
    book: &mut WindowBook<Quote>,
    oracle: &OracleSVI,
    epoch_id: u64,
) {
    assert!(book.epochs.contains(epoch_id), EEpochNotFound);
    assert!(oracle::is_settled(oracle), ENotSettled);

    let epoch = &mut book.epochs[epoch_id];
    assert!(!epoch.settled, EEpochAlreadySettled);
    assert!(oracle::id(oracle) == epoch.oracle_id, ETicketMismatch);

    let settlement_price = oracle::settlement_price(oracle).destroy_some();
    let winning = find_winning_band(&epoch.strikes, settlement_price);

    epoch.winning_band = winning;
    epoch.settled = true;

    event::emit(EpochSettled {
        book_id: object::id(book),
        epoch_id,
        settlement_price,
        winning_band: winning,
    });
}

// ── LP ────────────────────────────────────────────────────────────────────────

public fun supply<Quote>(
    book: &mut WindowBook<Quote>,
    payment: Coin<Quote>,
    ctx: &mut TxContext,
): WindowLpShare {
    let amount = payment.value();
    assert!(amount > 0, EZeroShares);

    let shares = if (book.total_lp_shares == 0 || book.pool.value() == 0) {
        amount
    } else {
        ((amount as u128) * (book.total_lp_shares as u128) / (book.pool.value() as u128)) as u64
    };

    book.pool.join(payment.into_balance());
    book.total_lp_shares = book.total_lp_shares + shares;

    WindowLpShare { id: object::new(ctx), book_id: object::id(book), shares }
}

/// LPs can withdraw their full pro-rata share at any time. Since Predict backs
/// all payouts, there is no worst-case reservation blocking withdrawals.
public fun withdraw<Quote>(
    book: &mut WindowBook<Quote>,
    share: WindowLpShare,
    ctx: &mut TxContext,
): Coin<Quote> {
    let WindowLpShare { id, book_id, shares } = share;
    id.delete();
    assert!(book_id == object::id(book), ETicketMismatch);
    assert!(shares > 0, EZeroShares);

    let amount = ((shares as u128) * (book.pool.value() as u128) / (book.total_lp_shares as u128)) as u64;
    book.total_lp_shares = book.total_lp_shares - shares;
    book.pool.split(amount).into_coin(ctx)
}

// ── Getters ───────────────────────────────────────────────────────────────────

/// LP pool balance (spread/skew revenue + initial capital). No reservation is
/// subtracted — Predict covers all payouts.
public fun pool_balance<Quote>(book: &WindowBook<Quote>): u64 { book.pool.value() }

/// Alias kept for test compatibility.
public fun pool_idle<Quote>(book: &WindowBook<Quote>): u64 { book.pool.value() }

public fun epoch_band_qty<Quote>(book: &WindowBook<Quote>, epoch_id: u64, band: u64): u64 {
    book.epochs[epoch_id].qty_sold[band]
}

public fun epoch_band_basis<Quote>(book: &WindowBook<Quote>, epoch_id: u64, band: u64): u64 {
    book.epochs[epoch_id].basis_collected[band]
}

public fun epoch_total_qty<Quote>(book: &WindowBook<Quote>, epoch_id: u64): u64 {
    book.epochs[epoch_id].total_qty
}

public fun epoch_winning_band<Quote>(book: &WindowBook<Quote>, epoch_id: u64): Option<u64> {
    book.epochs[epoch_id].winning_band
}

public fun epoch_settled<Quote>(book: &WindowBook<Quote>, epoch_id: u64): bool {
    book.epochs[epoch_id].settled
}

public fun epoch_strikes<Quote>(book: &WindowBook<Quote>, epoch_id: u64): vector<u64> {
    book.epochs[epoch_id].strikes
}

// ── Package entry points (called by vault) ────────────────────────────────────

/// Compute the live ask price for a band bet. Returns (svi_ask, total_basis):
///   svi_ask     — fair value paid to Predict for the range position
///   total_basis — svi_ask + spread + skew (what user pays in total)
public(package) fun compute_bet_price<Quote>(
    book: &WindowBook<Quote>,
    predict: &Predict,
    oracle: &OracleSVI,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    clock: &Clock,
): (u64, u64) {
    let epoch = &book.epochs[epoch_id];
    let lower = epoch.strikes[band_idx];
    let higher = epoch.strikes[band_idx + 1];
    let key = range_key::new(epoch.oracle_id, epoch.expiry, lower, higher);
    let (raw_cost, _) = predict::get_range_trade_amounts(predict, oracle, key, qty, clock);

    let raw_ask = (raw_cost as u128) * (PRICE_SCALE as u128) / (qty as u128);
    let spread_adj = raw_ask * (book.spread_bps as u128) / (BPS as u128);
    let base_ask = raw_ask + spread_adj;

    let (skew_adj, _) = compute_skew(
        epoch.qty_sold[band_idx],
        epoch.total_qty,
        book.band_count,
        book.skew_alpha_bps,
        base_ask,
    );
    let adjusted_ask = base_ask + skew_adj;
    let total_basis = ((adjusted_ask * (qty as u128)) / (PRICE_SCALE as u128)) as u64;

    (raw_cost, total_basis)
}

/// Record a bet after the vault has already minted the Predict range hedge.
/// `lp_revenue` is the spread+skew portion of the user's payment (total_basis - svi_ask).
/// No pool reservation — Predict covers the payout.
public(package) fun record_bet<Quote>(
    book: &mut WindowBook<Quote>,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    svi_ask: u64,
    total_basis: u64,
    lp_revenue: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
): BetTicket {
    assert!(qty > 0, EZeroQty);
    assert!(book.epochs.contains(epoch_id), EEpochNotFound);

    // Money-flow identity: basis = svi_ask (funds the hedge, held in Predict) +
    // lp_revenue (spread+skew, the only part that enters the pool). Enforced so
    // a bad vault split can never silently mis-credit the LP pool.
    assert!(svi_ask <= total_basis, EBasisMismatch);
    assert!(lp_revenue.value() == total_basis - svi_ask, EBasisMismatch);

    let epoch = &mut book.epochs[epoch_id];
    assert!(!epoch.settled, EEpochAlreadySettled);
    assert!(clock.timestamp_ms() < epoch.expiry, EEpochExpired);
    assert!(band_idx < book.band_count, EBandOutOfRange);

    // Spread+skew revenue goes to LP pool.
    book.pool.join(lp_revenue.into_balance());

    let new_qty_band = epoch.qty_sold[band_idx] + qty;
    *epoch.qty_sold.borrow_mut(band_idx) = new_qty_band;
    *epoch.basis_collected.borrow_mut(band_idx) = epoch.basis_collected[band_idx] + total_basis;
    epoch.total_qty = epoch.total_qty + qty;

    let bet_id = epoch.next_bet_id;
    epoch.next_bet_id = bet_id + 1;
    epoch.bets.add(bet_id, Bet { owner: ctx.sender(), epoch_id, band_idx, qty, basis: total_basis });

    event::emit(BetPlaced {
        book_id: object::id(book),
        epoch_id,
        bet_id,
        band_idx,
        qty,
        basis: total_basis,
        adjusted_mark: 0,
        skew_bps: 0,
    });

    BetTicket { id: object::new(ctx), book_id: object::id(book), epoch_id, band_idx, qty, basis: total_basis }
}

/// Burn a BetTicket and return its fields for vault-level settlement.
public(package) fun consume_ticket(ticket: BetTicket): (ID, u64, u64, u64) {
    let BetTicket { id, book_id, epoch_id, band_idx, qty, basis: _ } = ticket;
    id.delete();
    (book_id, epoch_id, band_idx, qty)
}

/// Returns (oracle_id, expiry, lower_strike, higher_strike) for a band.
public(package) fun epoch_band_range<Quote>(
    book: &WindowBook<Quote>,
    epoch_id: u64,
    band_idx: u64,
): (ID, u64, u64, u64) {
    let epoch = &book.epochs[epoch_id];
    (epoch.oracle_id, epoch.expiry, epoch.strikes[band_idx], epoch.strikes[band_idx + 1])
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fun compute_skew(
    band_qty: u64,
    total_qty: u64,
    band_count: u64,
    skew_alpha_bps: u64,
    base_ask: u128,
): (u128, u64) {
    if (total_qty == 0) return (0, 0);

    let actual_n = (band_qty as u128) * (band_count as u128);
    let expected_n = total_qty as u128;
    if (actual_n <= expected_n) return (0, 0);

    let excess = actual_n - expected_n;
    let skew_bps_u128 = (skew_alpha_bps as u128) * excess / expected_n;
    let skew_bps = if (skew_bps_u128 > (BPS as u128)) { BPS } else { skew_bps_u128 as u64 };
    let adj = base_ask * (skew_bps as u128) / (BPS as u128);
    (adj, skew_bps)
}

fun find_winning_band(strikes: &vector<u64>, price: u64): Option<u64> {
    let n = strikes.length() - 1;
    if (price < strikes[0] || price >= strikes[n]) return option::none();
    let mut i = 0u64;
    while (i < n) {
        if (price >= strikes[i] && price < strikes[i + 1]) return option::some(i);
        i = i + 1;
    };
    option::none()
}

// ── Test-only helpers ─────────────────────────────────────────────────────────

/// Direct bet entry for tests — bypasses vault and Predict. Deposits the full
/// `basis` into the pool (simulating svi_ask + spread + skew in one step).
/// No pool reservation — consistent with the new market-maker model.
#[test_only]
public fun place_bet_for_testing<Quote>(
    book: &mut WindowBook<Quote>,
    epoch_id: u64,
    band_idx: u64,
    qty: u64,
    basis: u64,
    payment: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
): BetTicket {
    assert!(qty > 0, EZeroQty);
    assert!(book.epochs.contains(epoch_id), EEpochNotFound);

    let epoch = &mut book.epochs[epoch_id];
    assert!(!epoch.settled, EEpochAlreadySettled);
    assert!(clock.timestamp_ms() < epoch.expiry, EEpochExpired);
    assert!(band_idx < book.band_count, EBandOutOfRange);
    assert!(payment.value() >= basis, ESlippage);

    let mut funds = payment.into_balance();
    let change_amt = funds.value() - basis;
    let change = funds.split(change_amt);
    book.pool.join(funds);
    if (change.value() > 0) {
        sui::transfer::public_transfer(change.into_coin(ctx), ctx.sender());
    } else {
        balance::destroy_zero(change);
    };

    let new_qty_band = epoch.qty_sold[band_idx] + qty;
    *epoch.qty_sold.borrow_mut(band_idx) = new_qty_band;
    *epoch.basis_collected.borrow_mut(band_idx) = epoch.basis_collected[band_idx] + basis;
    epoch.total_qty = epoch.total_qty + qty;

    let bet_id = epoch.next_bet_id;
    epoch.next_bet_id = bet_id + 1;
    epoch.bets.add(bet_id, Bet { owner: ctx.sender(), epoch_id, band_idx, qty, basis });

    BetTicket { id: object::new(ctx), book_id: object::id(book), epoch_id, band_idx, qty, basis }
}

/// Claim backed by pool balance — for tests only (production claims go through
/// vault::claim_window_bet which redeems from Predict).
#[test_only]
public fun claim_for_testing<Quote>(
    book: &mut WindowBook<Quote>,
    ticket: BetTicket,
    ctx: &mut TxContext,
): Coin<Quote> {
    let BetTicket { id, book_id, epoch_id, band_idx, qty, basis: _ } = ticket;
    id.delete();
    assert!(book_id == object::id(book), ETicketMismatch);
    assert!(book.epochs.contains(epoch_id), EEpochNotFound);

    let epoch = &book.epochs[epoch_id];
    assert!(epoch.settled, ENotSettled);

    let payout = if (epoch.winning_band == option::some(band_idx)) { qty } else { 0 };
    let owner = ctx.sender();

    event::emit(PayoutClaimed { book_id, epoch_id, band_idx, qty, payout, owner });

    if (payout > 0) {
        book.pool.split(payout).into_coin(ctx)
    } else {
        coin::zero<Quote>(ctx)
    }
}

#[test_only]
public fun settle_epoch_for_testing<Quote>(
    book: &mut WindowBook<Quote>,
    epoch_id: u64,
    oracle_id: ID,
    settlement_price: u64,
) {
    assert!(book.epochs.contains(epoch_id), EEpochNotFound);
    let epoch = &mut book.epochs[epoch_id];
    assert!(!epoch.settled, EEpochAlreadySettled);
    assert!(oracle_id == epoch.oracle_id, ETicketMismatch);

    let winning = find_winning_band(&epoch.strikes, settlement_price);
    epoch.winning_band = winning;
    epoch.settled = true;

    event::emit(EpochSettled {
        book_id: object::id(book),
        epoch_id,
        settlement_price,
        winning_band: winning,
    });
}

#[test_only]
public fun compute_skew_for_testing(
    band_qty: u64,
    total_qty: u64,
    band_count: u64,
    alpha_bps: u64,
    base_ask: u128,
): (u128, u64) {
    compute_skew(band_qty, total_qty, band_count, alpha_bps, base_ask)
}

#[test_only]
public fun find_winning_band_for_testing(strikes: &vector<u64>, price: u64): Option<u64> {
    find_winning_band(strikes, price)
}
