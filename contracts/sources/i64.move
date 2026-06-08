// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Signed integer with normalized zero. Used to track net vault inventory at a
/// strike — `UP liability − DOWN liability` — which can be either sign.
/// Self-contained: only additive ops are needed for inventory accounting.
module cerida::i64;

const EOverflow: u64 = 0;

const MAX_U64: u128 = 18446744073709551615;

public struct I64 has copy, drop, store {
    magnitude: u64,
    is_negative: bool,
}

public fun magnitude(value: &I64): u64 {
    value.magnitude
}

public fun is_negative(value: &I64): bool {
    value.is_negative
}

public fun is_zero(value: &I64): bool {
    value.magnitude == 0
}

public fun zero(): I64 {
    I64 { magnitude: 0, is_negative: false }
}

public fun from_u64(value: u64): I64 {
    I64 { magnitude: value, is_negative: false }
}

/// Normalizes a zero magnitude to the canonical non-negative zero.
public fun from_parts(magnitude: u64, is_negative: bool): I64 {
    if (magnitude == 0) zero()
    else I64 { magnitude, is_negative }
}

public fun neg(value: &I64): I64 {
    if (value.magnitude == 0) zero()
    else I64 { magnitude: value.magnitude, is_negative: !value.is_negative }
}

public fun add(a: &I64, b: &I64): I64 {
    if (a.is_negative == b.is_negative) {
        let sum = (a.magnitude as u128) + (b.magnitude as u128);
        assert!(sum <= MAX_U64, EOverflow);
        from_parts(sum as u64, a.is_negative)
    } else if (a.magnitude >= b.magnitude) {
        from_parts(a.magnitude - b.magnitude, a.is_negative)
    } else {
        from_parts(b.magnitude - a.magnitude, b.is_negative)
    }
}

public fun sub(a: &I64, b: &I64): I64 {
    let neg_b = neg(b);
    add(a, &neg_b)
}
