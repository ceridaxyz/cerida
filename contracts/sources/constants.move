// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0

/// Package-wide constants. All prices/probabilities are 9-decimal fixed point:
/// `float_scaling` (1e9) represents 1.0 — i.e. a probability of 100% or a $1
/// binary payout. A fair price of 0.42 is `420_000_000`.
module cerida::constants;

/// 1.0 in fixed point. Probabilities and the $1 binary payout both scale by this.
public macro fun float_scaling(): u64 { 1_000_000_000 }

/// Default skew coefficient κ: the maximum mid shift applied when the book is
/// fully one-sided (|inventory| ≥ depth). 0.08 = 8¢.
public macro fun default_skew_k(): u64 { 80_000_000 }

/// Hard cap on the skew shift regardless of κ. Keeps the quoted mid close enough
/// to fair that existing holders' mark-to-market never whipsaws. 0.08 = 8¢.
public macro fun default_max_skew(): u64 { 80_000_000 }

/// Lowest price the vault will ever quote a mid at (0.5¢). Prevents 0/1 quotes.
public macro fun min_price(): u64 { 5_000_000 }

/// Highest price the vault will ever quote a mid at (99.5¢).
public macro fun max_price(): u64 { 995_000_000 }
