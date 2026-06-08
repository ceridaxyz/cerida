// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Fixed-point math helpers in `float_scaling` (1e9) units. Intermediate
/// products use u128 to avoid overflow before scaling back down.
module cerida::math;

use cerida::constants;

const EZeroDivisor: u64 = 0;
const EOverflow: u64 = 1;

const MAX_U64: u128 = 18446744073709551615;

/// Fixed-point multiply: `a * b / 1e9`.
public fun mul(a: u64, b: u64): u64 {
    let product = ((a as u128) * (b as u128)) / (constants::float_scaling!() as u128);
    assert!(product <= MAX_U64, EOverflow);
    product as u64
}

/// Fixed-point divide: `a / b` carrying 1e9 scaling, i.e. `a * 1e9 / b`.
public fun div(a: u64, b: u64): u64 {
    assert!(b > 0, EZeroDivisor);
    let quotient = ((a as u128) * (constants::float_scaling!() as u128)) / (b as u128);
    assert!(quotient <= MAX_U64, EOverflow);
    quotient as u64
}

/// Plain `a * b / c` with no implicit scaling. Used for ratios where the result
/// is a raw count, not a fixed-point fraction.
public fun mul_div(a: u64, b: u64, c: u64): u64 {
    assert!(c > 0, EZeroDivisor);
    let result = ((a as u128) * (b as u128)) / (c as u128);
    assert!(result <= MAX_U64, EOverflow);
    result as u64
}

public fun min(a: u64, b: u64): u64 {
    if (a < b) a else b
}

public fun max(a: u64, b: u64): u64 {
    if (a > b) a else b
}
