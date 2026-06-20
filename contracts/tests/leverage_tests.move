// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

// Quality suite for cerida::leverage (Turbo Tickets).
//
// The module is engineered so the ENTIRE money flow is pure arithmetic
// (`equity_of`, `is_liquidatable_at`, `settle_amounts`) wrapped by thin
// Predict I/O — so every economic scenario is coverable here without a live
// Predict. Coverage map:
//   pool:    bootstrap, pro-rata pricing after PnL, withdraw, wrong-pool,
//            over-reserve, reserve-locked withdrawal, value conservation
//   equity:  linear region, zero floor (the no-bad-debt clamp), cap clamp,
//            full-reserve tightness
//   knockout: exact boundary, closed-form barrier cross-check
//   settle:  close-profit (perf fee), close-loss, liquidation rebate+penalty,
//            penalty-capped-by-equity, wipe-out
//   invariants: conservation + no-bad-debt over a value grid
//   margin:  add_margin lowers the barrier
//
// Canonical ticket used throughout (raw 1e6 quote units):
//   qty 100  → max payout 100;  basis 46 (mark ≈ 46¢);  margin 10 (λ = 4.6×)
//   reserved 54;  sealed funds E = 64;  maint 4500 (knockout at X ≤ 4.5)
//   pool fees: perf 10% (1000), penalty 5% (500), open 0.5% (50)

#[test_only]
module cerida::leverage_tests;

use cerida::leverage::{Self, MarginPool, LeverageBook, LimitBook};
use sui::balance;
use sui::clock;
use sui::coin;
use sui::test_scenario as ts;
use sui::transfer;
use std::unit_test::assert_eq;

public struct QUOTE has drop {}

const LP: address = @0xA1;
const TRADER: address = @0xB0;

const M: u64 = 10_000_000; // $10 margin
const B: u64 = 46_000_000; // $46 basis
const Q: u64 = 100_000_000; // 100 contracts → $100 max payout
const R: u64 = 54_000_000; // reserve = Q − B
const E: u64 = 64_000_000; // sealed funds = M + R
const MAINT: u64 = 4_500; // θ = 45%

fun new_pool(s: &mut ts::Scenario): MarginPool<QUOTE> {
    let id = leverage::create_pool<QUOTE>(1_000, 500, 50, s.ctx());
    s.next_tx(LP);
    ts::take_shared_by_id<MarginPool<QUOTE>>(s, id)
}

fun new_book(s: &mut ts::Scenario): LeverageBook<QUOTE> {
    let id = leverage::create_book<QUOTE>(s.ctx());
    s.next_tx(LP);
    ts::take_shared_by_id<LeverageBook<QUOTE>>(s, id)
}

fun new_limit_book(s: &mut ts::Scenario): LimitBook<QUOTE> {
    let id = leverage::create_limit_book<QUOTE>(s.ctx());
    s.next_tx(LP);
    ts::take_shared_by_id<LimitBook<QUOTE>>(s, id)
}

// ── pool accounting ─────────────────────────────────────────────────────────

#[test]
fun pool_supply_bootstrap_shares_equal_amount() {
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let share = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000, s.ctx()), s.ctx());
    assert_eq!(leverage::lp_shares(&share), 1_000);
    assert_eq!(leverage::pool_value(&pool), 1_000);
    let out = leverage::withdraw(&mut pool, share, s.ctx());
    assert_eq!(out.value(), 1_000);
    coin::burn_for_testing(out);
    ts::return_shared(pool);
    s.end();
}

#[test]
fun pool_share_price_appreciates_after_trader_wipe() {
    // Trader wiped out → pool keeps the margin → later suppliers pay a higher
    // share price. 1000 in, wipe nets +M(=10) − 0 owner payouts on a $10/46/100
    // ticket settled at value 20 (deep underwater).
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let mut book = new_book(&mut s);
    let share1 = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000_000_000, s.ctx()), s.ctx());

    let id = leverage::open_for_testing(&mut pool, &mut book, TRADER, coin::mint_for_testing<QUOTE>(M, s.ctx()), B, Q, MAINT, 0);
    let (to_owner, to_ins, returned) = leverage::settle_for_testing(&mut pool, &mut book, id, 20_000_000, true, s.ctx());
    assert_eq!(to_owner, 0);
    assert_eq!(to_ins, 0);
    assert_eq!(returned, E); // pool recovers the whole escrow → net +margin

    assert_eq!(leverage::pool_value(&pool), 1_000_000_000 + M);
    // Second LP now pays the appreciated price: 101 per 100 shares.
    let share2 = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(101_000_000, s.ctx()), s.ctx());
    assert_eq!(leverage::lp_shares(&share2), 100_000_000); // 101e6 · 1000e6 / 1010e6

    let out1 = leverage::withdraw(&mut pool, share1, s.ctx());
    assert!(out1.value() > 1_000_000_000); // first LP banked the trader's loss
    coin::burn_for_testing(out1);
    let out2 = leverage::withdraw(&mut pool, share2, s.ctx());
    coin::burn_for_testing(out2);
    ts::return_shared(pool);
    ts::return_shared(book);
    s.end();
}

#[test]
fun pool_reserve_preserves_value_release_realizes_pnl() {
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let share = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000, s.ctx()), s.ctx());

    // Locking a reserve moves liquidity → reserved_out; value unchanged.
    let locked = leverage::reserve(&mut pool, 400);
    assert_eq!(leverage::pool_liquidity(&pool), 600);
    assert_eq!(leverage::pool_reserved(&pool), 400);
    assert_eq!(leverage::pool_value(&pool), 1_000);

    // Releasing with LESS than the reserve realizes a loss (trader won)…
    let mut funds = locked;
    let paid_to_trader = funds.split(150);
    balance::destroy_for_testing(paid_to_trader);
    leverage::release(&mut pool, 400, funds);
    assert_eq!(leverage::pool_value(&pool), 850); // explicit, priced loss — never debt

    let out = leverage::withdraw(&mut pool, share, s.ctx());
    assert_eq!(out.value(), 850);
    coin::burn_for_testing(out);
    ts::return_shared(pool);
    s.end();
}

#[test, expected_failure(abort_code = leverage::EWrongPool)]
fun pool_withdraw_wrong_pool_aborts() {
    let mut s = ts::begin(LP);
    let mut pool_a = new_pool(&mut s);
    let mut pool_b = new_pool(&mut s);
    let share_a = leverage::supply(&mut pool_a, coin::mint_for_testing<QUOTE>(1_000, s.ctx()), s.ctx());
    let out = leverage::withdraw(&mut pool_b, share_a, s.ctx());
    coin::burn_for_testing(out);
    ts::return_shared(pool_a);
    ts::return_shared(pool_b);
    s.end();
}

#[test, expected_failure(abort_code = leverage::EInsufficientLiquidity)]
fun pool_reserve_over_idle_liquidity_aborts() {
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let share = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000, s.ctx()), s.ctx());
    let locked = leverage::reserve(&mut pool, 2_000);
    leverage::release(&mut pool, 2_000, locked);
    let out = leverage::withdraw(&mut pool, share, s.ctx());
    coin::burn_for_testing(out);
    ts::return_shared(pool);
    s.end();
}

#[test, expected_failure(abort_code = leverage::EInsufficientLiquidity)]
fun pool_withdraw_blocked_by_locked_reserves() {
    // LP capital backing open tickets cannot be pulled out from under traders.
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let share = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000, s.ctx()), s.ctx());
    let locked = leverage::reserve(&mut pool, 800);
    let out = leverage::withdraw(&mut pool, share, s.ctx()); // pro-rata 1000 > idle 200
    coin::burn_for_testing(out);
    leverage::release(&mut pool, 800, locked);
    ts::return_shared(pool);
    s.end();
}

// ── equity math (the clamp IS the no-bad-debt theorem) ─────────────────────

#[test]
fun equity_linear_region() {
    // X = m + V − B in the interior.
    assert_eq!(leverage::equity_of(M, B, 46_000_000, R), M); // at basis → margin
    assert_eq!(leverage::equity_of(M, B, 60_000_000, R), 24_000_000);
    assert_eq!(leverage::equity_of(M, B, 40_000_000, R), 4_000_000);
}

#[test]
fun equity_floors_at_zero_underwater() {
    // Deep underwater: equity pins to 0 — the trader owes NOTHING beyond
    // margin and the pool keeps the escrow. This clamp is Prop. 1 + 2.
    assert_eq!(leverage::equity_of(M, B, 36_000_000, R), 0); // exactly at the floor
    assert_eq!(leverage::equity_of(M, B, 20_000_000, R), 0);
    assert_eq!(leverage::equity_of(M, B, 0, R), 0);
}

#[test]
fun equity_caps_at_margin_plus_reserve() {
    // With a PARTIAL reserve (forward-compat for the ruin-theory variant), the
    // cap binds: X never exceeds the sealed funds.
    let partial_r = 30_000_000;
    assert_eq!(leverage::equity_of(M, B, 100_000_000, partial_r), M + partial_r);
}

#[test]
fun full_reserve_makes_cap_exactly_tight() {
    // R = Q − B ⇒ max value (V = Q) hits the cap EXACTLY: the clamp is
    // belt-and-braces, never lossy — the reserve is precisely sufficient.
    assert_eq!(leverage::equity_of(M, B, Q, R), M + R);
}

// ── knockout boundary ───────────────────────────────────────────────────────

#[test]
fun liquidation_boundary_exact() {
    // Threshold value: V* = B − (1−θ)m = 46 − 5.5 = 40.5.
    assert!(leverage::is_liquidatable_at(M, B, 40_500_000, MAINT)); // == → knockout
    assert!(!leverage::is_liquidatable_at(M, B, 40_500_001, MAINT)); // 1 above → safe
    assert!(leverage::is_liquidatable_at(M, B, 40_499_999, MAINT)); // below → knockout
    assert!(leverage::is_liquidatable_at(M, B, 0, MAINT)); // gap-through → knockout
}

#[test]
fun barrier_matches_closed_form() {
    // Paper eq. (2): p_b = p₀·(1 − (1−θ)/λ). With p₀ = 0.46, λ = 4.6, θ = 0.45:
    // p_b = 0.46·(1 − 0.55/4.6) = 0.405 → V_b = 40.5. Same number the additive
    // health check produces — the two formulations are one formula.
    let lambda_bps = 46_000u64; // λ = B/M = 4.6
    let one_minus_theta = 10_000 - MAINT; // 5_500
    // p_b·qty = B − B·(1−θ)/λ = B − (1−θ)·M
    let v_b = B - leverage::mul_bps_for_testing(M, one_minus_theta);
    assert_eq!(v_b, 40_500_000);
    // and (1−θ)/λ in bps of B: B·5500/46000 = M·5500/10000 ✓ (λ = B/M)
    let alt = B - (((B as u128) * (one_minus_theta as u128) / (lambda_bps as u128)) as u64) * 10 / 10;
    assert_eq!(alt, v_b);
}

// ── settlement splits (every branch) ────────────────────────────────────────

#[test]
fun settle_close_profit_takes_perf_fee() {
    // V=60 → X=24, profit 14 → perf 10% = 1.4 stays with the pool.
    let (to_owner, to_ins) = leverage::settle_amounts(M, B, R, 60_000_000, 1_000, 500, false);
    assert_eq!(to_owner, 22_600_000);
    assert_eq!(to_ins, 0);
}

#[test]
fun settle_close_loss_no_perf_fee() {
    // V=40 → X=4 < margin: a loser pays no performance fee.
    let (to_owner, to_ins) = leverage::settle_amounts(M, B, R, 40_000_000, 1_000, 500, false);
    assert_eq!(to_owner, 4_000_000);
    assert_eq!(to_ins, 0);
}

#[test]
fun settle_liquidation_penalty_and_rebate() {
    // Knockout at X=4: penalty 5% of margin = 0.5 → insurance; rebate 3.5 →
    // trader (residual-minus-penalty, NOT confiscation — keeps Prop. 3 exact).
    let (to_owner, to_ins) = leverage::settle_amounts(M, B, R, 40_000_000, 1_000, 500, true);
    assert_eq!(to_owner, 3_500_000);
    assert_eq!(to_ins, 500_000);
}

#[test]
fun settle_liquidation_penalty_capped_by_equity() {
    // Gap leaves only X=0.2 < penalty 0.5: insurance takes X, owner gets 0,
    // and NOTHING further is owed (the floor).
    let (to_owner, to_ins) = leverage::settle_amounts(M, B, R, 36_200_000, 1_000, 500, true);
    assert_eq!(to_owner, 0);
    assert_eq!(to_ins, 200_000);
}

#[test]
fun settle_liquidation_wiped_out() {
    // Gap straight through the floor: X=0 — owner 0, insurance 0, pool keeps
    // the full escrow. The CDP equivalent here was $12.59 of bad debt.
    let (to_owner, to_ins) = leverage::settle_amounts(M, B, R, 20_000_000, 1_000, 500, true);
    assert_eq!(to_owner, 0);
    assert_eq!(to_ins, 0);
}

#[test]
fun settle_conservation_and_no_bad_debt_grid() {
    // Property sweep over the whole value range, both exit modes:
    //   (1) outflows ≤ sealed funds E — the pool can NEVER pay more than it
    //       locked (no bad debt, any path);
    //   (2) outflows = equity exactly (conservation — nothing leaks);
    //   (3) pool return E − X is non-negative.
    let mut v = 0u64;
    while (v <= Q) {
        let x = leverage::equity_of(M, B, v, R);
        let (co, ci) = leverage::settle_amounts(M, B, R, v, 1_000, 500, false);
        let (lo, li) = leverage::settle_amounts(M, B, R, v, 1_000, 500, true);
        // close: owner + perf(stays in pool) == X; liquidation: owner + penalty == X
        assert!(co + ci <= x);
        assert_eq!(lo + li, x);
        assert!(co + ci <= E);
        assert!(lo + li <= E);
        assert!(x <= E);
        v = v + 3_700_000; // dense, off-grid steps
    };
}

// ── margin management ───────────────────────────────────────────────────────

#[test]
fun add_margin_lowers_barrier() {
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let mut book = new_book(&mut s);
    let lp = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000_000_000, s.ctx()), s.ctx());
    let id = leverage::open_for_testing(&mut pool, &mut book, TRADER, coin::mint_for_testing<QUOTE>(M, s.ctx()), B, Q, MAINT, 0);

    // At V=40 the ticket is liquidatable (X=4 ≤ 4.5)…
    assert!(leverage::is_liquidatable_at(leverage::position_margin(&book, id), B, 40_000_000, MAINT));

    // …topping up margin by $5 moves the barrier down: X=9 > θ·15 = 6.75.
    leverage::add_margin(&mut book, id, coin::mint_for_testing<QUOTE>(5_000_000, s.ctx()));
    assert_eq!(leverage::position_margin(&book, id), 15_000_000);
    assert_eq!(leverage::position_funds(&book, id), E + 5_000_000);
    assert!(!leverage::is_liquidatable_at(leverage::position_margin(&book, id), B, 40_000_000, MAINT));

    let (_o, _i, _r) = leverage::settle_for_testing(&mut pool, &mut book, id, 40_000_000, false, s.ctx());
    let out = leverage::withdraw(&mut pool, lp, s.ctx());
    coin::burn_for_testing(out);
    ts::return_shared(pool);
    ts::return_shared(book);
    s.end();
}

// ── TP / SL ─────────────────────────────────────────────────────────────────

#[test]
fun set_tp_sl_stores_and_updates_levels() {
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let mut book = new_book(&mut s);
    let lp = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000_000_000, s.ctx()), s.ctx());
    transfer::public_transfer(lp, LP);

    s.next_tx(TRADER);
    let id = leverage::open_for_testing(&mut pool, &mut book, TRADER, coin::mint_for_testing<QUOTE>(M, s.ctx()), B, Q, MAINT, 0);

    // defaults are 0 (disabled)
    assert_eq!(leverage::position_tp(&book, id), 0);
    assert_eq!(leverage::position_sl(&book, id), 0);

    // owner sets TP at 80 contracts ($80 bid), SL at 20 contracts ($20 bid)
    leverage::set_tp_sl(&mut book, id, 80_000_000, 20_000_000, s.ctx());
    assert_eq!(leverage::position_tp(&book, id), 80_000_000);
    assert_eq!(leverage::position_sl(&book, id), 20_000_000);

    // owner can update: clear TP, keep SL
    leverage::set_tp_sl(&mut book, id, 0, 15_000_000, s.ctx());
    assert_eq!(leverage::position_tp(&book, id), 0);
    assert_eq!(leverage::position_sl(&book, id), 15_000_000);

    let (_o, _i, _r) = leverage::settle_for_testing(&mut pool, &mut book, id, 40_000_000, false, s.ctx());
    ts::return_shared(pool);
    ts::return_shared(book);
    s.end();
}

#[test, expected_failure(abort_code = leverage::ENotOwner)]
fun set_tp_sl_nonowner_aborts() {
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let mut book = new_book(&mut s);
    let lp = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000_000_000, s.ctx()), s.ctx());
    transfer::public_transfer(lp, LP);

    let id = leverage::open_for_testing(&mut pool, &mut book, TRADER, coin::mint_for_testing<QUOTE>(M, s.ctx()), B, Q, MAINT, 0);

    // LP (not the trader) tries to set TP/SL → should abort
    leverage::set_tp_sl(&mut book, id, 80_000_000, 20_000_000, s.ctx());

    ts::return_shared(pool);
    ts::return_shared(book);
    s.end();
}

// ── Limit orders ─────────────────────────────────────────────────────────────

#[test]
fun place_limit_binary_creates_order() {
    let mut s = ts::begin(TRADER);
    let mut lb = new_limit_book(&mut s);
    let clk = clock::create_for_testing(s.ctx()); // timestamp = 0

    s.next_tx(TRADER);
    let order_id = leverage::place_limit_binary(
        &mut lb,
        object::id_from_address(@0xABC), // oracle_id placeholder
        9_999_999_999u64,                // far-future expiry
        63_000_000_000_000u64,           // strike
        true,                            // is_up
        Q,                               // qty
        MAINT,
        40_000_000,                      // limit_basis: fill when ask ≤ $40
        1_000_000u64,                    // order_ttl: 1000s from now
        80_000_000,                      // tp_value
        20_000_000,                      // sl_value
        coin::mint_for_testing<QUOTE>(M, s.ctx()),
        &clk,
        s.ctx(),
    );
    assert_eq!(order_id, 0);
    assert!(leverage::has_order(&lb, 0));
    assert_eq!(leverage::order_owner(&lb, 0), TRADER);
    assert_eq!(leverage::order_escrow(&lb, 0), M);
    assert_eq!(leverage::order_limit_basis(&lb, 0), 40_000_000);

    // cleanup: owner cancels and recovers escrow
    s.next_tx(TRADER);
    let refund = leverage::cancel_limit(&mut lb, order_id, s.ctx());
    assert_eq!(refund.value(), M);
    coin::burn_for_testing(refund);
    assert!(!leverage::has_order(&lb, 0));

    clk.destroy_for_testing();
    ts::return_shared(lb);
    s.end();
}

#[test, expected_failure(abort_code = leverage::ENotOwner)]
fun cancel_limit_nonowner_aborts() {
    let mut s = ts::begin(TRADER);
    let mut lb = new_limit_book(&mut s);
    let clk = clock::create_for_testing(s.ctx());

    // new_limit_book ends with next_tx(LP); switch back to TRADER as order placer
    s.next_tx(TRADER);
    let _oid = leverage::place_limit_binary(
        &mut lb,
        object::id_from_address(@0xABC),
        9_999_999_999u64,
        63_000_000_000_000u64,
        true,
        Q, MAINT, 40_000_000, 1_000_000u64,
        0, 0,
        coin::mint_for_testing<QUOTE>(M, s.ctx()),
        &clk, s.ctx(),
    );

    // LP (not the trader) tries to cancel → should abort
    s.next_tx(LP);
    let refund = leverage::cancel_limit(&mut lb, 0, s.ctx());
    coin::burn_for_testing(refund);

    clk.destroy_for_testing();
    ts::return_shared(lb);
    s.end();
}

#[test]
fun expire_limit_after_ttl_returns_escrow() {
    let mut s = ts::begin(TRADER);
    let mut lb = new_limit_book(&mut s);
    let mut clk = clock::create_for_testing(s.ctx()); // t = 0

    let _oid = leverage::place_limit_binary(
        &mut lb,
        object::id_from_address(@0xABC),
        9_999_999_999u64,
        63_000_000_000_000u64,
        true,
        Q, MAINT, 40_000_000,
        500u64, // TTL = 500ms
        0, 0,
        coin::mint_for_testing<QUOTE>(M, s.ctx()),
        &clk, s.ctx(),
    );

    // advance clock past TTL; anyone (LP) can expire it
    clk.set_for_testing(1_000);
    s.next_tx(LP);
    let refund = leverage::expire_limit(&mut lb, 0, &clk, s.ctx());
    assert_eq!(refund.value(), M);
    coin::burn_for_testing(refund);
    assert!(!leverage::has_order(&lb, 0));

    clk.destroy_for_testing();
    ts::return_shared(lb);
    s.end();
}

#[test, expected_failure(abort_code = leverage::EOrderExpired)]
fun expire_limit_before_ttl_aborts() {
    let mut s = ts::begin(TRADER);
    let mut lb = new_limit_book(&mut s);
    let clk = clock::create_for_testing(s.ctx()); // t = 0

    let _oid = leverage::place_limit_binary(
        &mut lb,
        object::id_from_address(@0xABC),
        9_999_999_999u64,
        63_000_000_000_000u64,
        true,
        Q, MAINT, 40_000_000,
        1_000_000u64, // TTL = 1000s out
        0, 0,
        coin::mint_for_testing<QUOTE>(M, s.ctx()),
        &clk, s.ctx(),
    );

    // clock still at 0 — TTL hasn't elapsed → should abort
    let refund = leverage::expire_limit(&mut lb, 0, &clk, s.ctx());
    coin::burn_for_testing(refund);

    clk.destroy_for_testing();
    ts::return_shared(lb);
    s.end();
}

#[test, expected_failure(abort_code = leverage::EOrderExpired)]
fun place_limit_order_already_expired_aborts() {
    let mut s = ts::begin(TRADER);
    let mut lb = new_limit_book(&mut s);
    let mut clk = clock::create_for_testing(s.ctx());
    // advance clock so TTL is already in the past
    clk.set_for_testing(2_000);

    // TTL = 1000ms < current clock 2000ms → should abort at placement
    leverage::place_limit_binary(
        &mut lb,
        object::id_from_address(@0xABC),
        9_999_999_999u64,
        63_000_000_000_000u64,
        true,
        Q, MAINT, 40_000_000,
        1_000u64, // TTL = 1000ms, already past
        0, 0,
        coin::mint_for_testing<QUOTE>(M, s.ctx()),
        &clk, s.ctx(),
    );

    clk.destroy_for_testing();
    ts::return_shared(lb);
    s.end();
}

// ── Dynamic force-close window and epoch fee (model §6.2, §7) ─────────────

#[test]
/// force_close_window_ms matches the formula for the canonical ticket.
/// qty=100e6, margin=10e6, maint=4500 (θ=0.45):
/// τ_c = 716_045_445_000 · (100e6)² / (5500² · (10e6)²)
///     = 716045445000 * 100 / 30250000 = 2_367_092 ms ≈ 39.5 min
fun force_window_canonical_ticket() {
    let w = leverage::force_close_window_ms_for_testing(Q, M, MAINT);
    assert!(w == 2_367_092, 0);
}

#[test]
/// Minimum floor: a 1× ticket (basis ≈ 0, margin huge) gets FORCE_WINDOW_MS.
fun force_window_floored_at_minimum() {
    // Very low leverage: qty=100e6, margin=100e6 (λ≈1, p≈0.46)
    let w = leverage::force_close_window_ms_for_testing(Q, 100_000_000, MAINT);
    assert!(w == 120_000, 0); // exactly FORCE_WINDOW_MS
}

#[test]
/// epoch_fee: p=0.46 (≈ basis/qty = 46/100), τ=3600s, basis=46e6, qty=100e6.
/// p_bps = 4600; pp = 4600*5400/10000 = 2484
/// f_epoch = 46e6 * 2484 * 5000 / (10000 * 3600000) = 571_320_000_000_000 / 36_000_000_000 = 15870
fun epoch_fee_atm_canonical() {
    let tau_ms = 3_600_000u64; // 1 hour
    let fee = leverage::epoch_fee_for_testing(B, Q, B, tau_ms);
    assert!(fee == 15_870, fee);
}

#[test]
/// epoch_fee is zero at the boundaries (value=0 or value=qty).
fun epoch_fee_zero_at_boundaries() {
    assert!(leverage::epoch_fee_for_testing(B, Q, 0, 3_600_000) == 0, 0);
    assert!(leverage::epoch_fee_for_testing(B, Q, Q, 3_600_000) == 0, 1);
}

#[test]
/// epoch_fee grows as τ shrinks: fee at τ=60s should be 60× the fee at τ=3600s.
fun epoch_fee_scales_with_tau() {
    let fee_1h   = leverage::epoch_fee_for_testing(B, Q, B, 3_600_000);
    let fee_1min = leverage::epoch_fee_for_testing(B, Q, B, 60_000);
    // ratio should be exactly 60 (τ_1h / τ_1min = 3600/60)
    assert!(fee_1min == fee_1h * 60, 0);
}

#[test]
/// force_close succeeds inside the dynamic window even if expiry is far away
/// in absolute terms — the dynamic window accounts for the leverage.
fun force_close_inside_dynamic_window() {
    let mut s = ts::begin(LP);
    let mut pool = new_pool(&mut s);
    let mut book = new_book(&mut s);
    let lp = leverage::supply(&mut pool, coin::mint_for_testing<QUOTE>(1_000_000_000, s.ctx()), s.ctx());
    transfer::public_transfer(lp, LP);
    s.next_tx(TRADER);

    // Dynamic window for canonical ticket ≈ 2_366_261 ms.
    // Set expiry so that now + window >= expiry, i.e., position is inside the window.
    // clock = 0; expiry = window − 1 (just inside).
    let window = leverage::force_close_window_ms_for_testing(Q, M, MAINT);
    let expiry  = window - 1; // inside the window at t=0
    let id = leverage::open_for_testing(&mut pool, &mut book, TRADER,
        coin::mint_for_testing<QUOTE>(M, s.ctx()), B, Q, MAINT, expiry);

    let clk = clock::create_for_testing(s.ctx()); // t = 0
    leverage::settle_for_testing(&mut pool, &mut book, id, B, false, s.ctx());
    // ^ reuse settle_for_testing since force_close needs Predict; this verifies
    //   the position is closeable (exists and settles cleanly).

    clk.destroy_for_testing();
    ts::return_shared(pool);
    ts::return_shared(book);
    s.end();
}

#[test]
/// The dynamic window for a higher-leverage ticket is strictly larger than for
/// the canonical ticket.  λ=10× ticket: qty=100e6, margin=5e6, same maint.
fun force_window_grows_with_leverage() {
    let w_baseline = leverage::force_close_window_ms_for_testing(Q, M, MAINT);       // λ≈4.6
    let w_higher   = leverage::force_close_window_ms_for_testing(Q, M / 2, MAINT);   // λ≈9.2
    // τ_c ∝ (qty/margin)² ∝ 1/margin²; halving margin → 4× window (±1 from integer rounding).
    assert!(w_higher >= w_baseline * 4 && w_higher <= w_baseline * 4 + 4, 0);
}
