// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Admin capability. The holder can tune protocol parameters (skew κ, caps,
/// risk limits) once those config modules land. Minted once at publish.
module cerida::manager;

/// One-time witness used in `init`.
public struct MANAGER has drop {}

/// Admin capability — holder performs privileged config mutations.
public struct AdminCap has key, store {
    id: UID,
}

fun init(_: MANAGER, ctx: &mut TxContext) {
    transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
}

/// Burn the cap to permanently renounce admin rights.
public fun destroy(cap: AdminCap) {
    let AdminCap { id } = cap;
    id.delete();
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(MANAGER {}, ctx);
}
