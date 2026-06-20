# Cerida Leverage — Turbo Tickets

> `cerida::leverage` · [model: `paper/leverage-model.md`](../paper/leverage-model.md) · [validation: `simulations/leverage_mc.ts`](../simulations/leverage_mc.ts) · [tests: `contracts/tests/leverage_tests.move`](../contracts/tests/leverage_tests.move)

Leveraged exposure to DeepBook Predict's prediction shares (continuous-strike
binaries and vertical ranges) with **zero bad debt by construction** — not as a
managed risk, but as a theorem. A trader posts margin; the pool locks the
ticket's maximum payout at open; equity tracks Predict's live mark with a
knockout barrier and a hard floor at zero. Nothing is ever lent, so nothing can
ever be owed.

| Property | Value |
|---|---|
| Instrument | knockout ("turbo") ticket on the mark `p = N(d2)` |
| Counterparty | the `MarginPool` (LPs) — Predict is used only as the price oracle |
| Trader max loss | the posted margin, prepaid — always |
| Pool max loss/ticket | the reserve, locked at open — always |
| Bad debt | **impossible** (no debt object exists; model Prop. 2) |
| Trust model | fully permissionless — no keeper, no custodian, no admin in the hot path |
| Leverage | up to 50× on-chain backstop; usable leverage is moneyness/tenor-scaled (§ Risk) |
| Settlement gap | never touched: tickets are force-closed before expiry, and even a missed force-close pays at most the locked reserve |

---

## 1. How it works

### The one formula

A ticket is `(margin m, qty q, market key, maint θ)`. At open the pool computes
the **basis** `B` (Predict's ask for `q` contracts) and seals

```
escrow E = m + R,   R = q − B          (R = reserve: the max profit, since q
                                        contracts can never be worth more than $1 each)
```

inside the position. From then on, at live bid-value `V = bid·q`:

```
equity   X = clip( m + V − B ,  0 ,  m + R )
knockout when X ≤ θ·m            (equivalently  V ≤ B − (1−θ)·m)
```

Every exit pays out of the sealed escrow and returns the rest to the pool.
Total outflow can never exceed `E` — that inequality *is* the no-bad-debt
guarantee, and it holds path-by-path, gaps included.

### Lifecycle

```
                         ┌──────────────────────────────────────────────┐
 trader ──open_binary──▶ │  Ticket { funds: m + R, basis, maint, key }  │
        ──open_range───▶ │  (sealed; lives in the shared LeverageBook)  │
                         └──────┬──────────────┬──────────────┬─────────┘
                                │              │              │
                       close (owner)   liquidate (ANYONE,  force_close (ANYONE,
                       at live bid     health checked      inside the 2-min
                                       on-chain)           pre-expiry window)
                                │              │              │
                                ▼              ▼              ▼
                    owner: X − perf fee   owner: (X − π·m)⁺   owner: X − perf fee
                    pool:  E − X + fee    insurance: min(X,π·m) pool: E − X + fee
                                          pool: E − X
```

- **`open_*`** — trader-signed. Pays an open fee (→ insurance), seals margin +
  reserve, records the ticket. Rejected inside the pre-expiry window.
- **`close`** — owner-signed, any time, at the live bid.
- **`liquidate`** — permissionless. The contract re-computes health from
  Predict's live bid *before* settling; a healthy ticket cannot be touched.
  The knocked-out trader keeps the residual equity minus a penalty.
- **`force_close`** — permissionless inside `FORCE_WINDOW_MS` (2 min) before
  expiry (and any time after). Close semantics, no penalty. This is the gap
  policy: no leveraged position rides the $1/$0 settlement jump. If everyone
  misses the window, solvency is still intact — a settled $1 mark pays exactly
  the reserve the pool already locked.
- **`add_margin`** — permissionless top-up: lowers the knockout barrier, raises
  the equity cap.

### The pool (LP side)

`MarginPool` is the counterparty and the Earn product:

```
pool_value = idle liquidity + reserved_out (book value of locked reserves)
LP shares  : supply → shares = amount · total_shares / pool_value
             withdraw → pro-rata of pool_value, payable from IDLE liquidity only
revenue    : open fees + perf fees (10% of trader profit) + knockout penalties
             + trader losses (margins kept on losing tickets)
downside   : per ticket, bounded by its reserve — committed and funded at open
insurance  : fee-funded buffer (open fees + penalties); reserved for future
             partial-reserve mode (see Roadmap)
```

Withdrawals cannot pull capital that backs open tickets
(`EInsufficientLiquidity`); LPs exit from idle liquidity as tickets recycle.

---

## 2. Function reference

All functions are generic over `Quote` (dUSDC on testnet). Prices/marks are
1e9-scaled; quantities and cash are raw quote units (1e6 dUSDC decimals);
`qty = 100_000_000` means 100 contracts = $100 max payout.

### Pool

```move
public fun create_pool<Quote>(perf_bps: u64, penalty_bps: u64, open_fee_bps: u64,
                              ctx: &mut TxContext): ID
```
Creates and shares a pool. The fee schedule is **immutable after creation** so
every later flow is permissionless without parameter games. Production values:
`(1000, 500, 50)` = 10% performance, 5% knockout penalty, 0.5% open.

```move
public fun create_book<Quote>(ctx: &mut TxContext): ID
```
Creates and shares the ticket book (a `Table` keyed by position id — the
id-addressable custody that permissionless liquidation requires).

```move
public fun supply<Quote>(pool, payment: Coin<Quote>, ctx): LpShare<Quote>
public fun withdraw<Quote>(pool, share: LpShare<Quote>, ctx): Coin<Quote>
```
LP entry/exit. `supply` mints shares pro-rata to `pool_value` (first supplier:
`shares = amount`). `withdraw` burns the share for its pro-rata value, from idle
liquidity only. Aborts: `EZeroMargin`, `EWrongPool`, `EInsufficientLiquidity`.

### Trading

```move
public fun open_binary<Quote>(
    pool: &mut MarginPool<Quote>, book: &mut LeverageBook<Quote>,
    predict: &Predict, oracle: &OracleSVI,
    oracle_id: ID, expiry: u64, strike: u64, is_up: bool,
    margin: Coin<Quote>, qty: u64, maint_bps: u64,
    clock: &Clock, ctx: &mut TxContext,
): u64   // position id

public fun open_range<Quote>( ... lower: u64, higher: u64 ... ): u64
```
Trader-signed open. Reads the basis from `predict::get_trade_amounts` (ask side)
at the moment of execution — there is no two-phase escrow because nothing here
needs a keeper. The implied leverage is `basis / margin_after_fee`.
Aborts: `EZeroQuantity`, `EZeroMargin`, `EBadMaintenance` (maint ∉ (0, 9000]),
`ETooCloseToExpiry` (inside the force window), `EBasisTooHigh` (degenerate
mark ≥ $1), `ELeverageTooHigh` (basis > 50× margin),
`EInsufficientLiquidity` (pool can't fund the reserve).

```move
public fun close<Quote>(pool, book, predict: &Predict, oracle, position_id: u64,
                        clock, ctx)
```
Owner-signed exit at the live bid. Performance fee (`perf_bps`) applies to
profit only (`X > m`); a losing close pays no fee. Abort: `ENotOwner`.

```move
public fun liquidate<Quote>(pool, book, predict: &Predict, oracle,
                            position_id: u64, clock, ctx)
```
**Anyone may call.** The contract values the ticket at the live bid and asserts
`is_liquidatable_at` *before* settling — health is verified on-chain, so the
call is trustless in both directions (no privileged liquidator, no griefing of
healthy positions). The trader receives the residual equity minus
`min(X, penalty_bps·m)`; the penalty goes to insurance. Abort: `ENotLiquidatable`.

```move
public fun force_close<Quote>(pool, book, predict: &Predict, oracle,
                              position_id: u64, clock, ctx)
```
**Anyone may call** once `now + FORCE_WINDOW_MS ≥ expiry`. Close semantics
(perf fee, no penalty). Abort: `EForceWindowNotReached`.

```move
public fun add_margin<Quote>(book, position_id: u64, payment: Coin<Quote>)
```
Permissionless margin top-up (only de-risks).

### Views

```move
pool_value / pool_liquidity / pool_reserved / pool_insurance / pool_total_shares / lp_shares
has_position / position_owner / position_margin / position_basis / position_reserved / position_funds
position_health(book, predict, oracle, id, clock): (u64, u64)   // (live value, knockout threshold)
equity_of(margin, basis, value, reserved): u64                   // pure
is_liquidatable_at(margin, basis, value, maint_bps): bool        // pure
settle_amounts(margin, basis, reserved, value, perf_bps, penalty_bps, is_liq): (u64, u64)  // pure
```

The three pure functions are the *entire* economic engine; the on-chain
functions only wire Predict I/O and balances around them. Bots and frontends
should use the same functions (or their TS ports) so quoted numbers match
settlement exactly.

---

## 3. Events

```move
PoolCreated   { pool_id, perf_bps, penalty_bps, open_fee_bps }
TicketOpened  { book_id, position_id, owner, is_range, qty, margin, basis, reserved, maint_bps, expiry }
TicketClosed  { book_id, position_id, owner, value, equity, to_owner, to_insurance, returned_to_pool, liquidated }
```

`TicketClosed` satisfies, on every emission:
`to_owner + to_insurance = equity ≤ margin + reserved` and
`to_owner + to_insurance + returned_to_pool = margin + reserved` (conservation —
indexers can assert this as an integrity check).

## 4. Errors

| Code | Name | Meaning |
|---|---|---|
| 0 | `EZeroQuantity` | qty = 0 |
| 1 | `EZeroMargin` | margin (or post-fee margin) = 0 |
| 2 | `EInsufficientLiquidity` | reserve or withdrawal exceeds idle liquidity |
| 3 | `ELeverageTooHigh` | basis > 50× margin (hard backstop) |
| 4 | `ENotLiquidatable` | health check failed — ticket is safe |
| 5 | `EWrongPool` | LP share from a different pool |
| 6 | `ENotOwner` | close caller isn't the ticket owner |
| 7 | `EBadMaintenance` | maint_bps ∉ (0, 9000] |
| 8 | `ETooCloseToExpiry` | open attempted inside the force window |
| 9 | `EForceWindowNotReached` | force_close before the window |
| 10 | `EBasisTooHigh` | quoted basis ≥ max payout (mark ≥ $1) |

## 5. Constants & parameters

| Parameter | Where | Value | Mutable? |
|---|---|---|---|
| `MAX_LEVERAGE_BPS` | contract | 500_000 (50×) | no |
| `MAX_MAINT_BPS` | contract | 9_000 | no |
| `FORCE_WINDOW_MS` | contract | 120_000 (2 min) | no |
| `perf_bps / penalty_bps / open_fee_bps` | per pool | set at `create_pool` | no (immutable) |
| `maint_bps` (θ) | per ticket | trader-chosen ∈ (0, 9000] | at open only |

---

## 6. Risk model (what is guaranteed vs. what is policy)

**Guaranteed by the contract (theorems, hold on every path):**
- Trader can never lose more than margin + open fee.
- Pool can never pay more than the reserve it locked at open; no bad debt.
- A healthy ticket cannot be liquidated (health is re-checked on-chain).
- Settlement gaps cannot create insolvency, even if force-close is missed.

**Policy (off-chain, protects the *trader's experience*, not solvency):**
- **Usable leverage** (model §6.1): beyond `λ_max(p₀, τ, Δt)` knockout is
  near-certain (~97% measured for ATM 1h at λ ≥ 10). Frontends should cap the
  leverage slider dynamically: ITM ≈ 10–25×, ATM ≈ 2–6×, OTM ≈ 1–3× (5s
  monitoring), the 50× backstop reachable only on calm high-probability
  markets. A soft cap (warn + confirm) is acceptable — nobody's solvency
  depends on it.
- Liquidation/force-close **bots**: anyone can run one. Liveness affects only
  capital recycling speed and trader UX, never solvency.

**Known gaps (deliberate, see Roadmap):** no caller incentive on
`liquidate`/`force_close` yet (penalty goes to insurance, not the caller); no
TP/SL or limit-entry primitives; full reserve is capital-hungry for the pool.

---

## 7. Integration (TypeScript)

Open an ATM UP ticket, ~2.3× ($20 margin, 100 contracts at ~46¢ basis):

```ts
const tx = new Transaction();
const [margin] = tx.splitCoins(tx.object(dusdcCoinId), [tx.pure.u64(20n * DUSDC_SCALE)]);
tx.moveCall({
  target: `${cerida}::leverage::open_binary`,
  typeArguments: [dusdcType],
  arguments: [
    tx.object(marginPoolId), tx.object(leverageBookId),
    tx.object(predictId), tx.object(oracleId),
    tx.pure.id(oracleId), tx.pure.u64(expiry),
    tx.pure.u64(63_000n * PRICE_SCALE), tx.pure.bool(true),   // strike, UP
    margin, tx.pure.u64(100n * DUSDC_SCALE),                  // qty: 100 contracts
    tx.pure.u64(4500n),                                       // θ = 45%
    tx.object(CLOCK),
  ],
});
```

Frontend numbers (all derivable client-side before signing):

```
contracts q     = chosen by slider:  q = m·λ / p_ask
basis B         = p_ask · q                      (quote get_trade_amounts)
max win         = m + (q − B) − perf fee         (the reserve IS the max win)
knockout (mark) = p_ask · (1 − (1−θ)/λ)
knockout (BTC)  = invert N(d2) at that mark      (solve on the SVI surface)
liq est.        = first-passage estimate          (see paper §6)
fees            = 0.5% open · 10% of profit · 5% of margin on knockout
auto-close      = expiry − 2 min                  (force window)
```

A liquidation bot is ~20 lines: poll `position_health(id)` for open ids (from
`TicketOpened` events minus `TicketClosed`), call `liquidate` when
`value ≤ threshold`; call `force_close` when `now ≥ expiry − 120s`. Both calls
are safe to race — losers just abort.

## 8. Testing

- **Unit (18, every economic branch):** `cd contracts && bin/sui move test --build-env testnet --gas-limit 100000000000` — pool accounting, equity clamps, knockout boundary + closed-form cross-check, all five settlement splits, conservation/no-bad-debt property grid, add_margin.
- **E2E (localnet):** `bun run --filter cerida-local deploy && …setup && …flow` — open→close (conservation visible in `TicketClosed`) and open→liquidate under a $63k→$55k crash (full escrow returns to pool; the CDP baseline lost $12.59 on the same path).
- **Monte Carlo:** `PATHS=20000 bun simulations/leverage_mc.ts` — reproduces the model's λ_max table and the CDP bad-debt comparison.

## 9. Roadmap

1. **Liquidator/force-closer tip** — split a slice of the penalty to the caller so bots are self-incentivized.
2. **TP/SL + limit entries** — pre-authorized conditional orders (escrowed intent + permissionless execution at quoted trigger), reusing the vault's intent pattern.
3. **Partial reserve** — reserve to a quantile with Cramér–Lundberg ruin bound `ε` (paper roadmap §): multiplies pool capacity at an explicit, priced insolvency tolerance, backed by the insurance fund.
4. **Auto-roll ("everlasting ticket")** — roll equity into the next expiry at force-close, funding-style (Paradigm everlasting options).
5. **λ_max service** — publish the usable-leverage cap per market (moneyness × tenor × keeper latency) for frontends to consume.
