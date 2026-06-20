module cerida::windows_tests;

use cerida::windows::{Self, WindowBook};
use deepbook_predict::registry;
use sui::{clock, coin, object, test_scenario as ts, transfer};

public struct QUOTE has drop {}

const LP:     address = @0xA1;
const TRADER: address = @0xB0;

// 3-band book config
const BAND_COUNT:     u64 = 3;
const SPREAD_BPS:     u64 = 100;  // 1%
const SKEW_ALPHA_BPS: u64 = 500;  // 5% per unit of over-representation

// 4 strike boundaries → 3 bands: [60, 65), [65, 70), [70, 75)  (×10^9)
const S0: u64 = 60_000_000_000;
const S1: u64 = 65_000_000_000;
const S2: u64 = 70_000_000_000;
const S3: u64 = 75_000_000_000;

// Canonical test epoch
const EXPIRY:  u64 = 3_600_000; // 1 h in ms (clock starts at 0 in tests)
const ORACLE_ADDR: address = @0xABC;

// Canonical bet sizes
const QTY:   u64 = 10_000_000; // 10 dUSDC
const BASIS: u64 = 3_000_000;  // 30% mark × qty

// ── Helpers ───────────────────────────────────────────────────────────────────

fun new_book(s: &mut ts::Scenario): (WindowBook<QUOTE>, ID) {
    let admin = registry::create_admin_cap_for_testing(s.ctx());
    let cap   = registry::create_oracle_cap(&admin, s.ctx());
    transfer::public_transfer(admin, LP);
    let id = windows::create_and_share<QUOTE>(cap, BAND_COUNT, SPREAD_BPS, SKEW_ALPHA_BPS, s.ctx());
    s.next_tx(LP);
    (ts::take_shared_by_id<WindowBook<QUOTE>>(s, id), id)
}

fun strikes(): vector<u64> { vector[S0, S1, S2, S3] }

fun roll(book: &mut WindowBook<QUOTE>, s: &mut ts::Scenario): (u64, ID) {
    let oracle_id = object::id_from_address(ORACLE_ADDR);
    let clk = clock::create_for_testing(s.ctx());
    let eid = windows::roll_epoch(book, oracle_id, EXPIRY, strikes(), &clk, s.ctx());
    clk.destroy_for_testing();
    (eid, oracle_id)
}

// ── Epoch tests ───────────────────────────────────────────────────────────────

#[test]
fun roll_epoch_creates_epoch_with_correct_bands() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);

    let (eid, _) = roll(&mut book, &mut s);

    assert!(eid == 0, 0);
    assert!(!windows::epoch_settled(&book, eid), 1);
    assert!(windows::epoch_total_qty(&book, eid) == 0, 2);
    // Bands start at zero inventory
    assert!(windows::epoch_band_qty(&book, eid, 0) == 0, 3);
    assert!(windows::epoch_band_qty(&book, eid, 1) == 0, 4);
    assert!(windows::epoch_band_qty(&book, eid, 2) == 0, 5);
    // Strikes stored correctly
    let st = windows::epoch_strikes(&book, eid);
    assert!(st[0] == S0 && st[1] == S1 && st[2] == S2 && st[3] == S3, 6);

    ts::return_shared(book);
    s.end();
}

#[test, expected_failure(abort_code = windows::EStrikesLength)]
fun roll_epoch_wrong_strikes_count_aborts() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let oracle_id = object::id_from_address(ORACLE_ADDR);
    let clk = clock::create_for_testing(s.ctx());
    // Only 3 values for a 3-band book (needs 4)
    windows::roll_epoch(&mut book, oracle_id, EXPIRY, vector[S0, S1, S2], &clk, s.ctx());
    clk.destroy_for_testing();
    ts::return_shared(book);
    s.end();
}

#[test, expected_failure(abort_code = windows::EEpochExpired)]
fun roll_epoch_past_expiry_aborts() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let oracle_id = object::id_from_address(ORACLE_ADDR);
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(EXPIRY + 1); // clock past expiry
    windows::roll_epoch(&mut book, oracle_id, EXPIRY, strikes(), &clk, s.ctx());
    clk.destroy_for_testing();
    ts::return_shared(book);
    s.end();
}

// ── Betting tests ─────────────────────────────────────────────────────────────

#[test]
fun place_bet_deducts_basis_from_payment() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let lp_share = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(100_000_000, s.ctx()), s.ctx());
    let (eid, _) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk  = clock::create_for_testing(s.ctx());
    let pay  = coin::mint_for_testing<QUOTE>(BASIS + 500, s.ctx()); // 500 excess
    let tick = windows::place_bet_for_testing(&mut book, eid, 1, QTY, BASIS, pay, &clk, s.ctx());

    // Pool gained exactly BASIS; no reservation — idle = seed + BASIS
    assert!(windows::pool_idle(&book) == 100_000_000 + BASIS, 0);
    assert!(windows::epoch_band_qty(&book, eid, 1) == QTY, 1);
    assert!(windows::epoch_band_basis(&book, eid, 1) == BASIS, 2);
    assert!(windows::epoch_total_qty(&book, eid) == QTY, 3);

    transfer::public_transfer(tick, TRADER);
    clk.destroy_for_testing();
    transfer::public_transfer(lp_share, LP);
    ts::return_shared(book);
    s.end();
}

#[test]
fun place_bet_reserves_worst_case_across_bands() {
    let mut s = ts::begin(LP);
    // Seed LP so there's enough idle capital
    let (mut book, _) = new_book(&mut s);
    let lp_share = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(100_000_000, s.ctx()), s.ctx());
    let (eid, _) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());

    // Band 0: qty=15, basis=5
    let t0 = windows::place_bet_for_testing(
        &mut book, eid, 0, 15_000_000, 5_000_000,
        coin::mint_for_testing<QUOTE>(5_000_000, s.ctx()), &clk, s.ctx()
    );
    // Band 1: qty=10, basis=3  → max still 15
    let t1 = windows::place_bet_for_testing(
        &mut book, eid, 1, 10_000_000, 3_000_000,
        coin::mint_for_testing<QUOTE>(3_000_000, s.ctx()), &clk, s.ctx()
    );
    // Band 0 again: qty=20 total → max becomes 20
    let t2 = windows::place_bet_for_testing(
        &mut book, eid, 0, 5_000_000, 1_500_000,
        coin::mint_for_testing<QUOTE>(1_500_000, s.ctx()), &clk, s.ctx()
    );

    // Predict backs payouts — no reservation. Pool idle = seed + all basis collected.
    let total_basis = 5_000_000 + 3_000_000 + 1_500_000;
    assert!(windows::pool_idle(&book) == 100_000_000 + total_basis, 0);

    transfer::public_transfer(t0, TRADER);
    transfer::public_transfer(t1, TRADER);
    transfer::public_transfer(t2, TRADER);
    clk.destroy_for_testing();
    transfer::public_transfer(lp_share, LP);
    ts::return_shared(book);
    s.end();
}

#[test, expected_failure(abort_code = windows::ESlippage)]
fun place_bet_slippage_aborts() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let (eid, _) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let pay = coin::mint_for_testing<QUOTE>(BASIS - 1, s.ctx());
    let tick = windows::place_bet_for_testing(&mut book, eid, 0, QTY, BASIS, pay, &clk, s.ctx());
    transfer::public_transfer(tick, TRADER); // dead code — abort happens inside call
    clk.destroy_for_testing();
    ts::return_shared(book);
    s.end();
}

#[test, expected_failure(abort_code = windows::EEpochExpired)]
fun place_bet_after_expiry_aborts() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let (eid, _) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(EXPIRY);
    let pay  = coin::mint_for_testing<QUOTE>(BASIS, s.ctx());
    let tick = windows::place_bet_for_testing(&mut book, eid, 0, QTY, BASIS, pay, &clk, s.ctx());
    transfer::public_transfer(tick, TRADER);
    clk.destroy_for_testing();
    ts::return_shared(book);
    s.end();
}

#[test, expected_failure(abort_code = windows::EBandOutOfRange)]
fun place_bet_invalid_band_aborts() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let (eid, _) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let pay = coin::mint_for_testing<QUOTE>(BASIS, s.ctx());
    let tick = windows::place_bet_for_testing(&mut book, eid, BAND_COUNT, QTY, BASIS, pay, &clk, s.ctx());
    transfer::public_transfer(tick, TRADER);
    clk.destroy_for_testing();
    ts::return_shared(book);
    s.end();
}

/// In the market-maker model there is no pool capacity check — Predict covers
/// payouts, so bets succeed even with an empty LP pool.
#[test]
fun place_bet_empty_pool_succeeds() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s); // pool is empty
    let (eid, _) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let pay = coin::mint_for_testing<QUOTE>(30_000_000, s.ctx());
    let tick = windows::place_bet_for_testing(&mut book, eid, 0, 100_000_000, 30_000_000, pay, &clk, s.ctx());
    assert!(windows::pool_idle(&book) == 30_000_000, 0);
    transfer::public_transfer(tick, TRADER);
    clk.destroy_for_testing();
    ts::return_shared(book);
    s.end();
}

// ── Settlement tests ──────────────────────────────────────────────────────────

#[test]
fun settle_epoch_finds_winning_band() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let (eid, oracle_id) = roll(&mut book, &mut s);

    // price = 67e9 → band 1: [65e9, 70e9)
    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, 67_000_000_000);
    assert!(windows::epoch_settled(&book, eid), 0);
    assert!(windows::epoch_winning_band(&book, eid) == option::some(1), 1);

    ts::return_shared(book);
    s.end();
}

#[test]
fun settle_epoch_price_at_lower_boundary_wins() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let (eid, oracle_id) = roll(&mut book, &mut s);

    // S2 = 70e9 exactly → band 2: [70e9, 75e9)
    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, S2);
    assert!(windows::epoch_winning_band(&book, eid) == option::some(2), 0);

    ts::return_shared(book);
    s.end();
}

#[test]
fun settle_epoch_price_below_all_bands_no_winner() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let (eid, oracle_id) = roll(&mut book, &mut s);

    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, S0 - 1);
    assert!(windows::epoch_winning_band(&book, eid) == option::none(), 0);

    ts::return_shared(book);
    s.end();
}

#[test]
fun settle_epoch_price_at_upper_bound_no_winner() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let (eid, oracle_id) = roll(&mut book, &mut s);

    // S3 = 75e9 = upper limit, not included in any band
    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, S3);
    assert!(windows::epoch_winning_band(&book, eid) == option::none(), 0);

    ts::return_shared(book);
    s.end();
}

#[test]
fun settle_epoch_records_winning_band() {
    let mut s = ts::begin(LP);
    let lp_seed = 50_000_000u64;
    let (mut book, _) = new_book(&mut s);
    let lp = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(lp_seed, s.ctx()), s.ctx());
    let (eid, oracle_id) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let tick = windows::place_bet_for_testing(
        &mut book, eid, 0, QTY, BASIS,
        coin::mint_for_testing<QUOTE>(BASIS, s.ctx()), &clk, s.ctx()
    );
    // In the market-maker model pool_idle == lp_seed + basis (no reservation).
    assert!(windows::pool_idle(&book) == lp_seed + BASIS, 0);

    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, S0 - 1); // no winner
    // pool_idle unchanged — settlement only records winning_band, doesn't move pool funds.
    assert!(windows::pool_idle(&book) == lp_seed + BASIS, 1);
    assert!(windows::epoch_winning_band(&book, eid) == option::none(), 2);

    clk.destroy_for_testing();
    transfer::public_transfer(tick, TRADER);
    transfer::public_transfer(lp, LP);
    ts::return_shared(book);
    s.end();
}

#[test, expected_failure(abort_code = windows::EEpochAlreadySettled)]
fun settle_epoch_twice_aborts() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let (eid, oracle_id) = roll(&mut book, &mut s);
    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, 67_000_000_000);
    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, 67_000_000_000);
    ts::return_shared(book);
    s.end();
}

// ── Claim tests ───────────────────────────────────────────────────────────────

#[test]
fun claim_winning_ticket_pays_qty() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let lp = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(100_000_000, s.ctx()), s.ctx());
    let (eid, oracle_id) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let tick = windows::place_bet_for_testing(
        &mut book, eid, 1, QTY, BASIS,
        coin::mint_for_testing<QUOTE>(BASIS, s.ctx()), &clk, s.ctx()
    );

    // Settle with price in band 1
    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, 67_000_000_000);

    let payout = windows::claim_for_testing(&mut book, tick, s.ctx());
    assert!(payout.value() == QTY, 0);

    coin::burn_for_testing(payout);
    clk.destroy_for_testing();
    transfer::public_transfer(lp, LP);
    ts::return_shared(book);
    s.end();
}

#[test]
fun claim_losing_ticket_pays_zero() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let lp = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(100_000_000, s.ctx()), s.ctx());
    let (eid, oracle_id) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let tick = windows::place_bet_for_testing(
        &mut book, eid, 0, QTY, BASIS,
        coin::mint_for_testing<QUOTE>(BASIS, s.ctx()), &clk, s.ctx()
    );

    // Settle with price in band 1 (not band 0)
    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, 67_000_000_000);

    let payout = windows::claim_for_testing(&mut book, tick, s.ctx());
    assert!(payout.value() == 0, 0);

    coin::burn_for_testing(payout);
    clk.destroy_for_testing();
    transfer::public_transfer(lp, LP);
    ts::return_shared(book);
    s.end();
}

#[test]
fun claim_no_winner_epoch_pays_zero() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let lp = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(100_000_000, s.ctx()), s.ctx());
    let (eid, oracle_id) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let tick = windows::place_bet_for_testing(
        &mut book, eid, 1, QTY, BASIS,
        coin::mint_for_testing<QUOTE>(BASIS, s.ctx()), &clk, s.ctx()
    );

    // Settle outside all bands
    windows::settle_epoch_for_testing(&mut book, eid, oracle_id, 1_000_000);

    let payout = windows::claim_for_testing(&mut book, tick, s.ctx());
    assert!(payout.value() == 0, 0);

    coin::burn_for_testing(payout);
    clk.destroy_for_testing();
    transfer::public_transfer(lp, LP);
    ts::return_shared(book);
    s.end();
}

#[test, expected_failure(abort_code = windows::ENotSettled)]
fun claim_before_settlement_aborts() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let lp = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(100_000_000, s.ctx()), s.ctx());
    transfer::public_transfer(lp, LP);
    let (eid, _) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let tick = windows::place_bet_for_testing(
        &mut book, eid, 1, QTY, BASIS,
        coin::mint_for_testing<QUOTE>(BASIS, s.ctx()), &clk, s.ctx()
    );
    // Claim without settling
    let payout = windows::claim_for_testing(&mut book, tick, s.ctx());
    coin::burn_for_testing(payout);
    clk.destroy_for_testing();
    ts::return_shared(book);
    s.end();
}

// ── LP tests ──────────────────────────────────────────────────────────────────

#[test]
fun lp_supply_first_depositor_shares_equal_amount() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let share = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(1_000_000, s.ctx()), s.ctx());
    assert!(windows::pool_idle(&book) == 1_000_000, 0);
    transfer::public_transfer(share, LP);
    ts::return_shared(book);
    s.end();
}

#[test]
fun lp_withdraw_receives_proportional_share() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);

    // Two LPs deposit equal amounts
    let s1 = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(1_000_000, s.ctx()), s.ctx());
    let s2 = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(1_000_000, s.ctx()), s.ctx());

    // First LP withdraws
    let out = windows::withdraw(&mut book, s1, s.ctx());
    assert!(out.value() == 1_000_000, 0);
    coin::burn_for_testing(out);
    transfer::public_transfer(s2, LP);
    ts::return_shared(book);
    s.end();
}

/// In the market-maker model the pool only holds LP capital + spread/skew revenue.
/// Predict covers payouts, so there is no reservation and LPs can always withdraw.
#[test]
fun lp_withdraw_succeeds_during_active_epoch() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);

    let share = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(10_000_000, s.ctx()), s.ctx());
    let (eid, _) = roll(&mut book, &mut s);

    s.next_tx(TRADER);
    let clk = clock::create_for_testing(s.ctx());
    let tick = windows::place_bet_for_testing(
        &mut book, eid, 0, 13_000_000, 3_000_000,
        coin::mint_for_testing<QUOTE>(3_000_000, s.ctx()), &clk, s.ctx()
    );

    // LP withdraws during an active epoch — no block.
    s.next_tx(LP);
    let out = windows::withdraw(&mut book, share, s.ctx());
    // pool holds lp_seed(10M) + basis(3M) = 13M; LP owns 100% → 13_000_000
    assert!(out.value() == 13_000_000, 0);
    coin::burn_for_testing(out);

    clk.destroy_for_testing();
    transfer::public_transfer(tick, TRADER);
    ts::return_shared(book);
    s.end();
}

// ── Inventory skew math tests ─────────────────────────────────────────────────

#[test]
fun compute_skew_cold_band_returns_zero() {
    // Band has no sales yet — total_qty == 0 → no skew
    let (adj, skew_bps) = windows::compute_skew_for_testing(0, 0, 3, 500, 500_000_000);
    assert!(adj == 0, 0);
    assert!(skew_bps == 0, 1);
}

#[test]
fun compute_skew_uniform_distribution_returns_zero() {
    // Each band has equal qty → actual_share = 1/N → no skew
    // band_qty=10, total_qty=30, band_count=3 → actual=10×3/30=1 = expected
    let (adj, skew_bps) = windows::compute_skew_for_testing(10, 30, 3, 500, 500_000_000);
    assert!(adj == 0, 0);
    assert!(skew_bps == 0, 1);
}

#[test]
fun compute_skew_hot_band_raises_price() {
    // Band has ALL the volume: band_qty=30, total_qty=30, band_count=3
    // actual_share = 1.0, expected_share = 1/3
    // excess = (30×3 - 30) / 30 = 60/30 = 2
    // skew_bps = 500 × 2 = 1000 bps (capped at BPS)
    let base_ask = 500_000_000u128; // 50%
    let (adj, skew_bps) = windows::compute_skew_for_testing(30, 30, 3, 500, base_ask);
    assert!(skew_bps == 1000, 0);
    // adj = base_ask × 1000 / 10000 = 50_000_000
    assert!(adj == 50_000_000, 1);
}

#[test]
fun compute_skew_caps_at_bps() {
    // Very hot band: skew formula would exceed BPS — should be capped at 10_000
    let (_, skew_bps) = windows::compute_skew_for_testing(
        1_000_000, 1_000_000, 2, 10_000, 1_000_000_000
    );
    assert!(skew_bps <= 10_000, 0);
}

// ── find_winning_band edge cases ──────────────────────────────────────────────

#[test]
fun winning_band_exact_boundaries() {
    let st = strikes();
    // Exactly at S0: band 0
    assert!(windows::find_winning_band_for_testing(&st, S0) == option::some(0), 0);
    // Exactly at S1: band 1
    assert!(windows::find_winning_band_for_testing(&st, S1) == option::some(1), 1);
    // Exactly at S2: band 2
    assert!(windows::find_winning_band_for_testing(&st, S2) == option::some(2), 2);
    // S3 (upper bound): no winner
    assert!(windows::find_winning_band_for_testing(&st, S3) == option::none(), 3);
    // Below all bands: no winner
    assert!(windows::find_winning_band_for_testing(&st, 0) == option::none(), 4);
    // S1 - 1: still band 0
    assert!(windows::find_winning_band_for_testing(&st, S1 - 1) == option::some(0), 5);
}

// ── Multi-epoch test ───────────────────────────────────────────────────────────

#[test]
fun two_epochs_independent_settlement() {
    let mut s = ts::begin(LP);
    let (mut book, _) = new_book(&mut s);
    let lp = windows::supply(&mut book, coin::mint_for_testing<QUOTE>(100_000_000, s.ctx()), s.ctx());

    // Roll epoch 0 and 1 with different oracle ids
    let oracle0 = object::id_from_address(@0xAA);
    let oracle1 = object::id_from_address(@0xBB);
    let clk = clock::create_for_testing(s.ctx());

    s.next_tx(TRADER);
    let eid0 = windows::roll_epoch(&mut book, oracle0, EXPIRY, strikes(), &clk, s.ctx());
    let eid1 = windows::roll_epoch(&mut book, oracle1, EXPIRY + 1, strikes(), &clk, s.ctx());

    let t0 = windows::place_bet_for_testing(
        &mut book, eid0, 0, QTY, BASIS,
        coin::mint_for_testing<QUOTE>(BASIS, s.ctx()), &clk, s.ctx()
    );
    let t1 = windows::place_bet_for_testing(
        &mut book, eid1, 2, QTY, BASIS,
        coin::mint_for_testing<QUOTE>(BASIS, s.ctx()), &clk, s.ctx()
    );

    // Settle epoch 0 (band 0 wins), epoch 1 (band 2 wins)
    windows::settle_epoch_for_testing(&mut book, eid0, oracle0, S0 + 1);
    windows::settle_epoch_for_testing(&mut book, eid1, oracle1, S2 + 1);

    let p0 = windows::claim_for_testing(&mut book, t0, s.ctx());
    let p1 = windows::claim_for_testing(&mut book, t1, s.ctx());
    assert!(p0.value() == QTY, 0);
    assert!(p1.value() == QTY, 1);

    coin::burn_for_testing(p0);
    coin::burn_for_testing(p1);
    clk.destroy_for_testing();
    transfer::public_transfer(lp, LP);
    ts::return_shared(book);
    s.end();
}
