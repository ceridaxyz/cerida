// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module cerida::manager_tests;

use cerida::manager::{Self, AdminCap};
use sui::test_scenario as ts;

const ADMIN: address = @0xA;

#[test]
fun init_mints_admin_cap_to_sender() {
    let mut scenario = ts::begin(ADMIN);
    manager::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    assert!(scenario.has_most_recent_for_sender<AdminCap>());

    scenario.end();
}

#[test]
fun destroy_renounces_cap() {
    let mut scenario = ts::begin(ADMIN);
    manager::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<AdminCap>();
    manager::destroy(cap);

    scenario.next_tx(ADMIN);
    assert!(!scenario.has_most_recent_for_sender<AdminCap>());

    scenario.end();
}
