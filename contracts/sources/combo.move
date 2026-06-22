// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Multi-leg combo positions on top of the Cerida vault.
///
/// A Combo groups N binary/range legs under a single entry stored via
/// dynamic field on the vault's UID. Each leg maps 1-to-1 to a vault intent
/// and (after execute_combo_mint) holds the resulting PositionToken internally
/// instead of transferring it to the user.
///
/// Two settlement modes:
///   PORTFOLIO (0) — legs settle independently; accumulated payouts claimable
///                   any time after each leg settles.
///   PARLAY    (1) — all legs must win; any loss triggers immediate return of
///                   remaining stake to owner with zero payout.
///
/// Combo kinds (informational / UI only):
///   SPREAD (0), CONDOR (1), LADDER (2), DIAGONAL (3),
///   CROSS_ASSET (4), TEMPORAL_CONDOR (5), CUSTOM (6)
module cerida::combo;

use cerida::position_token::PositionToken;
use sui::{balance::Balance, dynamic_field, event, table::{Self, Table}};

// === Constants ===

#[allow(unused_const)]
// Mode
const MODE_PORTFOLIO: u8 = 0;
#[allow(unused_const)]
const MODE_PARLAY:    u8 = 1;

// Status
const STATUS_ACTIVE:  u8 = 0;
const STATUS_WON:     u8 = 1;
const STATUS_LOST:    u8 = 2;
const STATUS_PENDING: u8 = 3;  // builder in-progress, not yet finalized

#[allow(unused_const)]
// Leg kind
const LEG_BINARY:   u8 = 0;
#[allow(unused_const)]
const LEG_RANGE:    u8 = 1;
#[allow(unused_const)]
const LEG_LEVERAGE: u8 = 2;

#[allow(unused_const)]
// Combo kind
const KIND_SPREAD:          u8 = 0;
#[allow(unused_const)]
const KIND_CONDOR:          u8 = 1;
#[allow(unused_const)]
const KIND_LADDER:          u8 = 2;
#[allow(unused_const)]
const KIND_DIAGONAL:        u8 = 3;
#[allow(unused_const)]
const KIND_CROSS_ASSET:     u8 = 4;
#[allow(unused_const)]
const KIND_TEMPORAL_CONDOR: u8 = 5;
#[allow(unused_const)]
const KIND_CUSTOM:          u8 = 6;

// === Errors ===
const EWrongVault:        u64 = 0;
const EAlreadySettled:    u64 = 1;
const ELegAlreadyDone:    u64 = 2;
const ENotOwner:          u64 = 3;
const ENotAllSettled:     u64 = 4;
const ENoToken:           u64 = 5;
const ELeverageInParlay:  u64 = 6;
const ENotPending:        u64 = 7;
const ENotEnoughLegs:     u64 = 8;

// === Structs ===

/// One leg inside a combo. Holds the PositionToken after execute_combo_mint.
public struct ComboLeg has store {
    kind:        u8,    // LEG_BINARY | LEG_RANGE | LEG_LEVERAGE
    oracle_id:   ID,
    expiry:      u64,
    strike:      u64,   // binary only
    lower:       u64,   // range only
    higher:      u64,   // range only
    is_up:       bool,  // binary only
    qty:         u64,
    intent_id:   u64,   // vault intent id (binary/range); 0 for leverage
    position_id: u64,   // LeverageBook position id (leverage only); 0 for binary/range
    token:       Option<PositionToken>,
    settled:     bool,
    won:         bool,
    payout:      u64,
}

/// The combo entry stored as a dynamic field on the vault.
public struct ComboEntry has store {
    vault_id:       ID,
    owner:          address,
    mode:           u8,    // MODE_PORTFOLIO | MODE_PARLAY
    kind:           u8,    // KIND_* constants
    legs:           vector<ComboLeg>,
    settled_count:  u8,
    wins:           u8,
    accumulated:    u64,   // sum of payouts so far
    status:         u8,    // STATUS_*
    last_expiry:    u64,   // ms of the latest leg's expiry
}

/// Key for the combo table dynamic field on the vault.
public struct ComboTableKey has copy, drop, store {}

// === Events ===

public struct ComboCreated has copy, drop {
    vault_id:    ID,
    combo_id:    u64,
    owner:       address,
    mode:        u8,
    kind:        u8,
    leg_count:   u8,
    last_expiry: u64,
}

public struct ComboMintExecuted has copy, drop {
    vault_id: ID,
    combo_id: u64,
    leg_index: u8,
    intent_id: u64,
}

public struct ComboLegSettled has copy, drop {
    vault_id:  ID,
    combo_id:  u64,
    leg_index: u8,
    won:       bool,
    payout:    u64,
}

public struct ComboSettled has copy, drop {
    vault_id:  ID,
    combo_id:  u64,
    status:    u8,
    total_payout: u64,
}


// ── Table helpers (called by vault.move) ─────────────────────────────────────

/// Ensure the combo table exists on `uid` and return a mutable borrow.
public(package) fun table_mut(uid: &mut UID, ctx: &mut TxContext): &mut Table<u64, ComboEntry> {
    if (!dynamic_field::exists_(uid, ComboTableKey {})) {
        dynamic_field::add(uid, ComboTableKey {}, table::new<u64, ComboEntry>(ctx));
    };
    dynamic_field::borrow_mut(uid, ComboTableKey {})
}

public(package) fun table_ref(uid: &UID): &Table<u64, ComboEntry> {
    dynamic_field::borrow(uid, ComboTableKey {})
}

// ── Leg constructors ─────────────────────────────────────────────────────────

public(package) fun new_binary_leg(
    oracle_id: ID, expiry: u64, strike: u64, is_up: bool, qty: u64, intent_id: u64,
): ComboLeg {
    ComboLeg {
        kind: LEG_BINARY, oracle_id, expiry, strike, lower: 0, higher: 0,
        is_up, qty, intent_id, position_id: 0,
        token: option::none(), settled: false, won: false, payout: 0,
    }
}

public(package) fun new_range_leg(
    oracle_id: ID, expiry: u64, lower: u64, higher: u64, qty: u64, intent_id: u64,
): ComboLeg {
    ComboLeg {
        kind: LEG_RANGE, oracle_id, expiry, strike: 0, lower, higher,
        is_up: false, qty, intent_id, position_id: 0,
        token: option::none(), settled: false, won: false, payout: 0,
    }
}

public(package) fun new_leverage_leg(
    oracle_id: ID, expiry: u64, position_id: u64, qty: u64,
): ComboLeg {
    ComboLeg {
        kind: LEG_LEVERAGE, oracle_id, expiry,
        strike: 0, lower: 0, higher: 0, is_up: false,
        qty, intent_id: 0, position_id,
        token: option::none(), settled: false, won: false, payout: 0,
    }
}

// ── Entry lifecycle (called by vault.move) ───────────────────────────────────

/// Create a new ComboEntry in the vault's dynamic combo table.
/// Called by vault::request_combo after all leg intents are recorded.
public(package) fun create_entry(
    uid:         &mut UID,
    vault_id:    ID,
    owner:       address,
    mode:        u8,
    kind:        u8,
    legs:        vector<ComboLeg>,
    last_expiry: u64,
    next_id:     u64,
    ctx:         &mut TxContext,
): u64 {
    // Leverage legs cannot participate in parlay — equity is paid out immediately
    // on settlement so we cannot revoke it if another leg loses.
    if (mode == MODE_PARLAY) {
        legs.do_ref!(|leg| assert!(leg.kind != LEG_LEVERAGE, ELeverageInParlay));
    };
    let combo_id = next_id;
    let leg_count = legs.length() as u8;
    let entry = ComboEntry {
        vault_id, owner, mode, kind, legs,
        settled_count: 0, wins: 0, accumulated: 0,
        status: STATUS_ACTIVE, last_expiry,
    };
    table_mut(uid, ctx).add(combo_id, entry);
    event::emit(ComboCreated { vault_id, combo_id, owner, mode, kind, leg_count, last_expiry });
    combo_id
}

// ── Builder API (PTB-friendly, avoids vector<Struct> args) ──────────────────

/// Create an empty pending combo. Call push_leg ≥ 2 times, then finalize_entry.
public(package) fun begin_entry(
    uid:     &mut UID,
    vault_id: ID,
    owner:   address,
    mode:    u8,
    kind:    u8,
    next_id: u64,
    ctx:     &mut TxContext,
): u64 {
    let combo_id = next_id;
    let entry = ComboEntry {
        vault_id, owner, mode, kind, legs: vector[],
        settled_count: 0, wins: 0, accumulated: 0,
        status: STATUS_PENDING, last_expiry: 0,
    };
    table_mut(uid, ctx).add(combo_id, entry);
    combo_id
}

/// Append a leg to a pending entry. Aborts if the entry is already finalized.
public(package) fun push_leg(uid: &mut UID, combo_id: u64, leg: ComboLeg) {
    let table = dynamic_field::borrow_mut<ComboTableKey, Table<u64, ComboEntry>>(uid, ComboTableKey {});
    let entry = table.borrow_mut(combo_id);
    assert!(entry.status == STATUS_PENDING, ENotPending);
    entry.legs.push_back(leg);
}

/// Finalize a pending combo: validate ≥ 2 legs, PARLAY constraint, compute
/// last_expiry, set STATUS_ACTIVE, and emit ComboCreated.
public(package) fun finalize_entry(uid: &mut UID, vault_id: ID, combo_id: u64) {
    let table = dynamic_field::borrow_mut<ComboTableKey, Table<u64, ComboEntry>>(uid, ComboTableKey {});
    let entry = table.borrow_mut(combo_id);
    assert!(entry.status == STATUS_PENDING, ENotPending);
    assert!(entry.legs.length() >= 2, ENotEnoughLegs);
    if (entry.mode == MODE_PARLAY) {
        entry.legs.do_ref!(|leg| assert!(leg.kind != LEG_LEVERAGE, ELeverageInParlay));
    };
    let mut last_expiry = 0u64;
    let mut i = 0u64;
    while (i < entry.legs.length()) {
        if (entry.legs[i].expiry > last_expiry) { last_expiry = entry.legs[i].expiry };
        i = i + 1;
    };
    entry.last_expiry = last_expiry;
    entry.status = STATUS_ACTIVE;
    let leg_count  = entry.legs.length() as u8;
    let owner      = entry.owner;
    let mode       = entry.mode;
    let kind       = entry.kind;
    event::emit(ComboCreated { vault_id, combo_id, owner, mode, kind, leg_count, last_expiry });
}

// ────────────────────────────────────────────────────────────────────────────

/// Store a PositionToken into the combo leg after execute_combo_mint.
public(package) fun store_token(
    uid:       &mut UID,
    combo_id:  u64,
    leg_index: u64,
    token:     PositionToken,
    vault_id:  ID,
    intent_id: u64,
) {
    let table = dynamic_field::borrow_mut<ComboTableKey, Table<u64, ComboEntry>>(uid, ComboTableKey {});
    let entry = table.borrow_mut(combo_id);
    assert!(entry.vault_id == vault_id, EWrongVault);
    assert!(entry.status != STATUS_PENDING, ENotPending);
    let leg = &mut entry.legs[leg_index];
    assert!(!leg.settled, ELegAlreadyDone);
    leg.token.fill(token);
    event::emit(ComboMintExecuted { vault_id, combo_id, leg_index: leg_index as u8, intent_id });
}

/// Pop the PositionToken from a leg so the vault can redeem it.
public(package) fun take_token(
    uid:       &mut UID,
    combo_id:  u64,
    leg_index: u64,
): PositionToken {
    let table = dynamic_field::borrow_mut<ComboTableKey, Table<u64, ComboEntry>>(uid, ComboTableKey {});
    let entry = table.borrow_mut(combo_id);
    let leg = &mut entry.legs[leg_index];
    assert!(leg.token.is_some(), ENoToken);
    leg.token.extract()
}

/// Record a leg's settlement result. Returns true when all legs are done.
/// In parlay mode, any loss sets status to LOST immediately.
/// `accumulate`: set false for leverage legs whose equity was already paid to the
/// owner directly — prevents double-counting in the combo's claimable balance.
public(package) fun record_settlement(
    uid:        &mut UID,
    vault_id:   ID,
    combo_id:   u64,
    leg_index:  u64,
    won:        bool,
    payout:     u64,
    accumulate: bool,
): bool /* all_done */ {
    let table = dynamic_field::borrow_mut<ComboTableKey, Table<u64, ComboEntry>>(uid, ComboTableKey {});
    let entry = table.borrow_mut(combo_id);
    assert!(entry.vault_id == vault_id, EWrongVault);
    assert!(entry.status == STATUS_ACTIVE, EAlreadySettled);

    let leg = &mut entry.legs[leg_index];
    assert!(!leg.settled, ELegAlreadyDone);
    leg.settled = true;
    leg.won     = won;
    leg.payout  = payout;
    entry.settled_count = entry.settled_count + 1;
    if (won && accumulate) {
        entry.wins        = entry.wins + 1;
        entry.accumulated = entry.accumulated + payout;
    } else if (won) {
        entry.wins = entry.wins + 1;
    };

    event::emit(ComboLegSettled { vault_id, combo_id, leg_index: leg_index as u8, won, payout });

    // Parlay: first loss kills the combo; forfeit any accumulated winnings from earlier legs.
    if (entry.mode == MODE_PARLAY && !won) {
        entry.accumulated = 0;
        entry.status = STATUS_LOST;
        event::emit(ComboSettled { vault_id, combo_id, status: STATUS_LOST, total_payout: 0 });
        return true
    };

    let all_done = entry.settled_count == (entry.legs.length() as u8);
    if (all_done) {
        let all_won = entry.wins == entry.settled_count;
        entry.status = if (all_won) { STATUS_WON } else { STATUS_LOST };
        let tp = if (all_won) { entry.accumulated } else { 0 };
        event::emit(ComboSettled { vault_id, combo_id, status: entry.status, total_payout: tp });
    };
    all_done
}

/// Remove and return the ComboEntry for claiming. Validates caller is owner.
public(package) fun take_for_claim(
    uid:      &mut UID,
    combo_id: u64,
    caller:   address,
): ComboEntry {
    let table = dynamic_field::borrow_mut<ComboTableKey, Table<u64, ComboEntry>>(uid, ComboTableKey {});
    let entry = table.borrow(combo_id);
    assert!(entry.owner == caller, ENotOwner);
    let all_settled = entry.settled_count == (entry.legs.length() as u8);
    assert!(all_settled, ENotAllSettled);
    table.remove(combo_id)
}

// ── ComboEntry accessors ─────────────────────────────────────────────────────

public fun entry_owner(e: &ComboEntry):       address { e.owner }
public fun entry_mode(e: &ComboEntry):        u8      { e.mode }
public fun entry_status(e: &ComboEntry):      u8      { e.status }
public fun entry_accumulated(e: &ComboEntry): u64     { e.accumulated }
public fun entry_leg_count(e: &ComboEntry):   u64     { e.legs.length() }
public fun entry_last_expiry(e: &ComboEntry): u64     { e.last_expiry }

public fun leg_kind(e: &ComboEntry, i: u64):        u8   { e.legs[i].kind }
public fun leg_oracle_id(e: &ComboEntry, i: u64):   ID   { e.legs[i].oracle_id }
public fun leg_expiry(e: &ComboEntry, i: u64):      u64  { e.legs[i].expiry }
public fun leg_intent_id(e: &ComboEntry, i: u64):   u64  { e.legs[i].intent_id }
public fun leg_position_id(e: &ComboEntry, i: u64): u64  { e.legs[i].position_id }
public fun leg_is_settled(e: &ComboEntry, i: u64):  bool { e.legs[i].settled }
public fun leg_has_token(e: &ComboEntry, i: u64):   bool { e.legs[i].token.is_some() }
public fun is_leverage_leg(e: &ComboEntry, i: u64): bool { e.legs[i].kind == LEG_LEVERAGE }

/// Destroy a ComboEntry after its payout has been extracted.
public(package) fun destroy_entry(e: ComboEntry) {
    let ComboEntry { legs, .. } = e;
    legs.destroy!(|leg| {
        let ComboLeg { kind, token, .. } = leg;
        if (kind == LEG_LEVERAGE) {
            // Leverage legs have no PositionToken — equity was transferred at settlement.
            token.destroy_none();
        } else {
            // Any remaining predict token (e.g. voided leg) must be burned.
            token.destroy!(|t| cerida::position_token::burn_for_combo(t));
        }
    });
}
