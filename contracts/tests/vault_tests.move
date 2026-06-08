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
    let i = intent::new_binary(USER, oid(), 100, 75_000, true, 50, 500);
    assert_eq!(i.user(), USER);
    assert_eq!(i.escrowed(), 500);
    assert_eq!(i.qty(), 50);
    assert_eq!(i.is_range(), false);
    let (user, escrowed) = intent::destroy(i);
    assert_eq!(user, USER);
    assert_eq!(escrowed, 500);
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
    let intent_id = vault::request_mint_binary(&mut v, oid(), 1_780_000_000_000, 75_000, true, 100, coin, s.ctx());

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
