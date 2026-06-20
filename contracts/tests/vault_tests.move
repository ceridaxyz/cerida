// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module cerida::vault_tests;

use cerida::intent;
use cerida::position_token::{Self, PositionToken};
use cerida::vault::{Self, CeridaVault};
use sui::coin;
use sui::test_scenario as ts;
use std::unit_test::assert_eq;

/// Dummy quote asset for tests.
public struct QUOTE has drop {}

const KEEPER: address = @0xCA;
const USER: address = @0xB0;

fun oid(): ID { object::id_from_address(@0xABC) }

#[test]
fun binary_token_roundtrip() {
    let ctx = &mut tx_context::dummy();
    let token = position_token::new_binary(oid(), oid(), 100, 75_000, true, 50, ctx);
    assert_eq!(token.qty(), 50);
    assert_eq!(token.strike(), 75_000);
    assert_eq!(token.is_up(), true);
    assert_eq!(token.is_range(), false);
    assert_eq!(token.expiry(), 100);
    position_token::burn(token);
}

#[test]
fun range_token_roundtrip() {
    let ctx = &mut tx_context::dummy();
    let token = position_token::new_range(oid(), oid(), 100, 74_000, 76_000, 50, ctx);
    assert_eq!(token.is_range(), true);
    assert_eq!(token.lower(), 74_000);
    assert_eq!(token.higher(), 76_000);
    position_token::burn(token);
}

#[test]
fun intent_carries_user_and_escrow() {
    let i = intent::new_predict_binary(USER, oid(), 100, 75_000, true, 50, 500, 0);
    assert_eq!(i.user(), USER);
    assert_eq!(i.escrowed(), 500);
    assert_eq!(i.qty(), 50);
    assert_eq!(i.is_range(), false);
    assert_eq!(i.max_cost(), 0);
    let (user, escrowed) = intent::destroy(i);
    assert_eq!(user, USER);
    assert_eq!(escrowed, 500);
}

#[test]
fun intent_carries_max_cost() {
    let i = intent::new_predict_binary(USER, oid(), 100, 75_000, true, 100, 1_000, 450);
    assert_eq!(i.max_cost(), 450);
    intent::destroy(i);
}

#[test]
fun intent_range_carries_max_cost() {
    let i = intent::new_predict_range(USER, oid(), 100, 62_000, 64_000, 100, 1_000, 300);
    assert_eq!(i.max_cost(), 300);
    assert_eq!(i.is_range(), true);
    intent::destroy(i);
}

#[test]
fun create_then_request_escrows_and_records() {
    let mut s = ts::begin(KEEPER);
    // keeper creates the vault + backing manager
    vault::create<QUOTE>(s.ctx());

    // a user escrows quote and records a binary mint request
    s.next_tx(USER);
    let mut v = s.take_shared<CeridaVault<QUOTE>>();
    let coin = coin::mint_for_testing<QUOTE>(500, s.ctx());
    let intent_id = vault::request_mint_binary(&mut v, oid(), 1_780_000_000_000, 75_000, true, 100, 0, coin, s.ctx());

    assert_eq!(intent_id, 0);
    assert_eq!(vault::escrow_value(&v), 500);
    assert!(vault::has_intent(&v, 0));
    let i = vault::borrow_intent(&v, 0);
    assert_eq!(intent::user(i), USER);
    assert_eq!(intent::escrowed(i), 500);
    assert_eq!(intent::qty(i), 100);

    ts::return_shared(v);
    s.end();
}

#[test]
fun keeper_is_creator() {
    let mut s = ts::begin(KEEPER);
    vault::create<QUOTE>(s.ctx());
    s.next_tx(KEEPER);
    let v = s.take_shared<CeridaVault<QUOTE>>();
    assert_eq!(vault::keeper(&v), KEEPER);
    ts::return_shared(v);
    s.end();
}

// === Fungibility: split / merge / same_key ===

#[test]
fun split_reduces_original_and_creates_piece() {
    let ctx = &mut tx_context::dummy();
    let mut token = position_token::new_binary(oid(), oid(), 100, 75_000, true, 100, ctx);
    let piece = token.split(40, ctx);
    assert_eq!(token.qty(), 60);
    assert_eq!(piece.qty(), 40);
    // The split piece claims the same position, so it's fungible with the rest.
    assert!(position_token::same_key(&token, &piece));
    position_token::burn(token);
    position_token::burn(piece);
}

#[test]
fun merge_adds_quantities() {
    let ctx = &mut tx_context::dummy();
    let mut a = position_token::new_binary(oid(), oid(), 100, 75_000, true, 60, ctx);
    let b = position_token::new_binary(oid(), oid(), 100, 75_000, true, 40, ctx);
    a.merge(b);
    assert_eq!(a.qty(), 100);
    position_token::burn(a);
}

#[test]
fun split_then_merge_is_identity() {
    let ctx = &mut tx_context::dummy();
    let mut token = position_token::new_range(oid(), oid(), 100, 74_000, 76_000, 100, ctx);
    let piece = token.split(30, ctx);
    token.merge(piece);
    assert_eq!(token.qty(), 100);
    position_token::burn(token);
}

#[test]
fun same_key_distinguishes_positions() {
    let ctx = &mut tx_context::dummy();
    let a = position_token::new_binary(oid(), oid(), 100, 75_000, true, 10, ctx);
    let up = position_token::new_binary(oid(), oid(), 100, 75_000, true, 10, ctx);
    let down = position_token::new_binary(oid(), oid(), 100, 75_000, false, 10, ctx);
    assert!(position_token::same_key(&a, &up));
    assert!(!position_token::same_key(&a, &down)); // opposite side ≠ fungible
    position_token::burn(a);
    position_token::burn(up);
    position_token::burn(down);
}

#[test, expected_failure]
fun split_rejects_full_amount() {
    let ctx = &mut tx_context::dummy();
    let mut token = position_token::new_binary(oid(), oid(), 100, 75_000, true, 50, ctx);
    let piece = token.split(50, ctx); // amount must be < qty
    position_token::burn(token);
    position_token::burn(piece);
}

#[test, expected_failure]
fun merge_rejects_different_key() {
    let ctx = &mut tx_context::dummy();
    let mut a = position_token::new_binary(oid(), oid(), 100, 75_000, true, 60, ctx);
    let b = position_token::new_binary(oid(), oid(), 100, 76_000, true, 40, ctx); // different strike
    a.merge(b);
    position_token::burn(a);
}

// === Partial redeem ===

#[test]
fun request_redeem_partial_returns_remainder() {
    let mut s = ts::begin(KEEPER);
    vault::create<QUOTE>(s.ctx());

    s.next_tx(USER);
    let mut v = s.take_shared<CeridaVault<QUOTE>>();
    // A token claiming this vault, 100 contracts.
    let token = position_token::new_binary(object::id(&v), oid(), 100, 75_000, true, 100, s.ctx());

    // Sell only 40; the other 60 should come straight back to the holder.
    let redeem_id = vault::request_redeem(&mut v, token, 40, s.ctx());
    assert_eq!(redeem_id, 0);
    ts::return_shared(v);

    s.next_tx(USER);
    let remainder = s.take_from_sender<PositionToken>();
    assert_eq!(remainder.qty(), 60);
    position_token::burn(remainder);
    s.end();
}

#[test, expected_failure]
fun request_redeem_rejects_excess_qty() {
    let mut s = ts::begin(KEEPER);
    vault::create<QUOTE>(s.ctx());

    s.next_tx(USER);
    let mut v = s.take_shared<CeridaVault<QUOTE>>();
    let token = position_token::new_binary(object::id(&v), oid(), 100, 75_000, true, 100, s.ctx());
    let _ = vault::request_redeem(&mut v, token, 101, s.ctx()); // > qty
    ts::return_shared(v);
    s.end();
}

// === Limit order (cancel) ===

#[test]
fun cancel_mint_intent_refunds_escrow() {
    let mut s = ts::begin(KEEPER);
    vault::create<QUOTE>(s.ctx());

    s.next_tx(USER);
    let mut v = s.take_shared<CeridaVault<QUOTE>>();
    let coin = coin::mint_for_testing<QUOTE>(500, s.ctx());
    let intent_id = vault::request_mint_binary(&mut v, oid(), 100, 75_000, true, 100, 450, coin, s.ctx());
    assert_eq!(vault::escrow_value(&v), 500);
    assert!(vault::has_intent(&v, intent_id));

    // user cancels — escrow returns, intent gone
    vault::cancel_mint_intent(&mut v, intent_id, s.ctx());
    assert!(!vault::has_intent(&v, intent_id));
    assert_eq!(vault::escrow_value(&v), 0);

    ts::return_shared(v);
    s.next_tx(USER);
    let refund = s.take_from_sender<sui::coin::Coin<QUOTE>>();
    assert_eq!(refund.value(), 500);
    coin::burn_for_testing(refund);
    s.end();
}

#[test, expected_failure(abort_code = vault::ENotIntentOwner)]
fun cancel_mint_intent_nonowner_aborts() {
    let mut s = ts::begin(KEEPER);
    vault::create<QUOTE>(s.ctx());

    s.next_tx(USER);
    let mut v = s.take_shared<CeridaVault<QUOTE>>();
    let coin = coin::mint_for_testing<QUOTE>(500, s.ctx());
    let intent_id = vault::request_mint_binary(&mut v, oid(), 100, 75_000, true, 100, 0, coin, s.ctx());

    // KEEPER tries to cancel USER's intent — should abort
    s.next_tx(KEEPER);
    vault::cancel_mint_intent(&mut v, intent_id, s.ctx());

    ts::return_shared(v);
    s.end();
}
