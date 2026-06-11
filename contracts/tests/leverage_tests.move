// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module cerida::leverage_tests;

use cerida::leverage::{Self, MarginPool};
use sui::coin;
use sui::test_scenario as ts;
use std::unit_test::assert_eq;

public struct QUOTE has drop {}

const LP: address = @0xA1;

// === Pure math (no Predict needed) ===

#[test]
fun reconcile_open_borrow_used() {
    // margin 100, 5× (50_000 bps), cost 480 → E=500, debt=380, init=100, repay=20.
    let (debt, init, repay, refund) = leverage::reconcile_open(100, 50_000, 480);
    assert_eq!(debt, 380);
    assert_eq!(init, 100);
    assert_eq!(repay, 20);
    assert_eq!(refund, 0);
    assert_eq!(repay + refund + 480, 500); // repay + refund + cost == E
}

#[test]
fun reconcile_open_margin_only() {
    // margin 100, 5×, cost 80 (< margin) → no borrow used: debt=0, init=80, full borrow back.
    let (debt, init, repay, refund) = leverage::reconcile_open(100, 50_000, 80);
    assert_eq!(debt, 0);
    assert_eq!(init, 80);
    assert_eq!(repay, 400);
    assert_eq!(refund, 20);
    assert_eq!(repay + refund + 80, 500);
}

#[test]
fun liquidatable_boundary() {
    // debt 380, init 100, maint 4500 bps → threshold = 380 + 45 = 425.
    assert!(leverage::is_liquidatable_at(425, 380, 100, 4500)); // == threshold → liquidatable
    assert!(!leverage::is_liquidatable_at(426, 380, 100, 4500)); // above → safe
    assert!(leverage::is_liquidatable_at(400, 380, 100, 4500)); // below → liquidatable
}

#[test]
fun mul_bps_and_price_of() {
    assert_eq!(leverage::mul_bps_for_testing(100, 4500), 45);
    assert_eq!(leverage::mul_bps_for_testing(1000, 50), 5); // 0.5% open fee on 1000
    // cost 480 over 1000 contracts → per-contract mark 0.48 (480_000_000 at 1e9 scale)
    assert_eq!(leverage::price_of_for_testing(480, 1000), 480_000_000);
}

// === Pool accounting ===

#[test]
fun pool_supply_borrow_repay_withdraw() {
    let mut s = ts::begin(LP);
    let pool_id = leverage::create_pool<QUOTE>(s.ctx());

    s.next_tx(LP);
    let mut pool = ts::take_shared_by_id<MarginPool<QUOTE>>(&s, pool_id);

    // Bootstrap: first supplier gets shares == amount.
    let c = coin::mint_for_testing<QUOTE>(1000, s.ctx());
    let share = leverage::supply(&mut pool, c, s.ctx());
    assert_eq!(leverage::lp_shares(&share), 1000);
    assert_eq!(leverage::pool_total_shares(&pool), 1000);
    assert_eq!(leverage::pool_value(&pool), 1000);

    // Borrow moves idle liquidity into debt; pool value is preserved.
    let borrowed = leverage::borrow(&mut pool, 400);
    assert_eq!(leverage::pool_liquidity(&pool), 600);
    assert_eq!(leverage::pool_debt(&pool), 400);
    assert_eq!(leverage::pool_value(&pool), 1000);

    // Repaying the principal restores liquidity and clears debt.
    leverage::repay_loan(&mut pool, 400, borrowed);
    assert_eq!(leverage::pool_liquidity(&pool), 1000);
    assert_eq!(leverage::pool_debt(&pool), 0);

    // Full withdraw returns the principal and burns the shares.
    let out = leverage::withdraw(&mut pool, share, s.ctx());
    assert_eq!(out.value(), 1000);
    assert_eq!(leverage::pool_total_shares(&pool), 0);
    coin::burn_for_testing(out);

    ts::return_shared(pool);
    s.end();
}

#[test, expected_failure]
fun withdraw_wrong_pool_aborts() {
    let mut s = ts::begin(LP);
    let a_id = leverage::create_pool<QUOTE>(s.ctx());
    let b_id = leverage::create_pool<QUOTE>(s.ctx());

    s.next_tx(LP);
    let mut pool_a = ts::take_shared_by_id<MarginPool<QUOTE>>(&s, a_id);
    let mut pool_b = ts::take_shared_by_id<MarginPool<QUOTE>>(&s, b_id);

    let c = coin::mint_for_testing<QUOTE>(1000, s.ctx());
    let share_a = leverage::supply(&mut pool_a, c, s.ctx());
    let out = leverage::withdraw(&mut pool_b, share_a, s.ctx()); // EWrongPool

    coin::burn_for_testing(out);
    ts::return_shared(pool_a);
    ts::return_shared(pool_b);
    s.end();
}

#[test, expected_failure]
fun borrow_over_liquidity_aborts() {
    let mut s = ts::begin(LP);
    let pool_id = leverage::create_pool<QUOTE>(s.ctx());

    s.next_tx(LP);
    let mut pool = ts::take_shared_by_id<MarginPool<QUOTE>>(&s, pool_id);
    let c = coin::mint_for_testing<QUOTE>(1000, s.ctx());
    let share = leverage::supply(&mut pool, c, s.ctx());

    let borrowed = leverage::borrow(&mut pool, 2000); // > liquidity → EInsufficientLiquidity

    leverage::repay_loan(&mut pool, 2000, borrowed);
    let out = leverage::withdraw(&mut pool, share, s.ctx());
    coin::burn_for_testing(out);
    ts::return_shared(pool);
    s.end();
}
