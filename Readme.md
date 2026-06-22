# Cerida — Comprehensive Architecture

Cerida is a DeFi product layer on Sui that wraps [DeepBook Predict](https://github.com/MystenLabs/deepbookv3/tree/main/packages/predict). It exposes three user-facing products — **binary/range options**, **leveraged positions (Turbo Tickets)**, and **window bets** — plus a **combo** system that combines legs from any product into multi-leg positions. All products funnel through a single shared gateway: `CeridaVault<Quote>`.

---

## Table of Contents

1. [High-Level System Map](#1-high-level-system-map)
2. [Shared Objects Reference](#2-shared-objects-reference)
3. [Intent Queue: the Request/Execute Pattern](#3-intent-queue-the-requestexecute-pattern)
4. [Product: Binary & Range Options](#4-product-binary--range-options)
5. [Product: Leverage (Turbo Tickets)](#5-product-leverage-turbo-tickets)
6. [Product: Window Bets](#6-product-window-bets)
7. [Product: Combos](#7-product-combos)
8. [LP Accounting & Yield](#8-lp-accounting--yield)
9. [Trust Model & Permission Table](#9-trust-model--permission-table)
10. [Event Reference](#10-event-reference)
11. [Money Flow Diagrams](#11-money-flow-diagrams)
12. [Module Summary](#12-module-summary)

---

## 1. High-Level System Map

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          USER / KEEPER                                  │
└──────────────┬────────────────┬──────────────────┬──────────────────────┘
               │ binary/range   │ leverage          │ window bets / combos
               ▼                ▼                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      CeridaVault<Quote>                                  │
│                                                                          │
│  escrow: Balance<Quote>          ← funds parked between request/execute  │
│  intents: Table<u64, Intent>     ← typed pending keeper work             │
│  redeems: Table<u64, RedeemTicket>                                       │
│  settlements: Table<u64, Balance> ← epoch/combo payouts ready to claim   │
│  positions: Table<u64, PositionTicket> ← custodied TP/SL positions       │
│  exposure: Table<key, NetExposure>  ← LP net inventory per market key    │
│  next_combo_id, next_intent_id, …                                        │
│                                                                          │
│  manager_id ──────────────────────────────────────────────────────────┐  │
│  keeper (address)                                                     │  │
└──────────────────────────────────────────────────────────┬────────────┘  │
                                                           │               │
                                          ┌────────────────┘               │
                                          ▼                                │
                                 PredictManager                            │
                                 (shared, owner-gated)                     │
                                          │                                │
                                          ▼                                │
                               DeepBook Predict Protocol                   │
                               (binary/range mints & redeems)              │
                                                                           │
       ┌───────────────────────────────────────────────────────────────────┘
       │
       ├── MarginPool<Quote>     (shared)  ← LP capital backing leverage
       ├── LeverageBook<Quote>   (shared)  ← open leverage positions
       ├── LimitBook<Quote>      (shared)  ← pending limit-entry orders
       └── WindowBook<Quote>     (shared)  ← epoch state + LP pool for window bets
```

---

## 2. Shared Objects Reference

| Object | Type | Created by | Purpose |
| --- | --- | --- | --- |
| `CeridaVault<Quote>` | Shared | `vault::create` | Single entry point for all products |
| `PredictManager` | Shared | `vault::create` (internally) | Owner-gated Predict account |
| `MarginPool<Quote>` | Shared | `leverage::create_pool` | LP capital; backs leverage ticket reserves |
| `LeverageBook<Quote>` | Shared | `leverage::create_book` | Tracks all open leverage positions |
| `LimitBook<Quote>` | Shared | `leverage::create_limit_book` | Stores resting limit-entry orders |
| `WindowBook<Quote>` | Shared | `windows::create_and_share` | Epoch state + LP pool for window bets |

### Owned / transferable objects

| Object | Created by | Who holds it |
| --- | --- | --- |
| `LpShare<Quote>` | `leverage::supply` | LP (transferable) |
| `WindowLpShare` | `windows::supply` | Window LP (transferable) |
| `BetTicket` | `vault::execute_window_bet` | Bettor (transferable) |
| `PositionToken` | `vault::execute_mint` (if no TP/SL) | Trader |
| `ComboEntry` (dynamic field on vault UID) | `vault::request_combo` | Keyed by `combo_id` on vault |

### `CeridaVault` field layout

```move
public struct CeridaVault<phantom Quote> has key {
    id: UID,
    manager_id: ID,          // ID of the PredictManager this vault owns
    keeper: address,         // only this address may execute intents
    escrow: Balance<Quote>,  // aggregated user payments, pending execution
    intents: Table<u64, Intent>,        // intent_id → pending work
    next_intent_id: u64,
    redeems: Table<u64, RedeemTicket>,  // redeem_id → pending redemption
    next_redeem_id: u64,
    settlements: Table<u64, Balance<Quote>>,  // epoch_id or combo_slot → claimable balance
    next_combo_id: u64,
    positions: Table<u64, PositionTicket>,    // position_id → custodied TP/SL token
    next_position_id: u64,
    exposure: Table<vector<u8>, NetExposure>, // BCS key → (yes_qty, no_qty)
}
```

---

## 3. Intent Queue: the Request/Execute Pattern

Every product that needs a Predict write follows the same two-step pattern:

```
Step 1 — User:   request_*(vault, …, payment)
  • Payment is joined into vault.escrow
  • An Intent is created and stored in vault.intents[intent_id]
  • An event is emitted so the keeper can index it
  • intent_id is returned to the user

Step 2 — Keeper: execute_*(vault, manager, predict, oracle, intent_id, clock, ctx)
  • Keeper identity is verified: ctx.sender() == vault.keeper
  • Manager identity is verified: object::id(manager) == vault.manager_id
  • The intent is removed from the table (atomic — no double-execution)
  • Funds flow from vault.escrow into PredictManager, then into Predict
  • The product-specific output (PositionToken, BetTicket, Ticket) is created
```

**Intent kinds** (encoded as `u8` in `intent.move`):

| Kind                   | Value | Used by                   |
| ---------------------- | ----- | ------------------------- |
| `KIND_PREDICT_BINARY`  | 0     | `request_mint_binary`     |
| `KIND_PREDICT_RANGE`   | 1     | `request_mint_range`      |
| `KIND_LEVERAGE_BINARY` | 2     | `request_leverage_binary` |
| `KIND_LEVERAGE_RANGE`  | 3     | `request_leverage_range`  |
| `KIND_WINDOW_BET`      | 4     | `request_window_bet`      |

Combo predict legs reuse `KIND_PREDICT_BINARY` / `KIND_PREDICT_RANGE` — the combo relationship is tracked in the separate `ComboEntry` dynamic field.

**Cancellation**: Any intent can be cancelled by the original user before the keeper executes it:

```
vault::cancel_mint_intent(vault, intent_id, ctx)
  → removes intent from table
  → refunds escrowed balance to user
  → emits MintCancelled
```

---

## 4. Product: Binary & Range Options

### What it is

The vault acts as a market-maker for binary (YES/NO at a strike price) and range (in-band or out-of-band) contracts issued by DeepBook Predict. Users pay the Predict ask price. The LP's inventory naturally hedges: every YES sold that is later matched by a NO sold reduces the LP's directional risk to zero at that key.

### Objects involved

- `CeridaVault<Quote>`
- `PredictManager` (accessed via manager_id)
- `Predict` (DeepBook Predict protocol)
- `OracleSVI` (price + SVI surface)
- `Clock`

### Binary mint flow

```
User calls:
  vault::request_mint_binary(
    vault,
    oracle_id,    // ID of the OracleSVI
    expiry,       // unix ms timestamp
    strike,       // scaled 1e9 (e.g. $63,000 = 63_000 * 1e9)
    is_up,        // true = YES/UP, false = NO/DOWN
    qty,          // number of contracts
    max_cost,     // max total cost accepted (0 = market order)
    tp_value,     // bid·qty level to auto-exit at profit (0 = disabled)
    sl_value,     // bid·qty level to auto-exit at loss (0 = disabled)
    payment,      // Coin<Quote> — must be ≥ ask price
    ctx,
  ) → intent_id: u64

  State changes:
    vault.escrow  += payment
    vault.intents[intent_id] = Intent { KIND_PREDICT_BINARY, user, oracle_id,
                                        expiry, strike, is_up, qty, escrowed,
                                        max_cost, tp_value, sl_value }
  Event: MintRequested { vault_id, intent_id, user, oracle_id, expiry,
                         is_range: false, qty, escrowed, max_cost }

─────────────────────────────────────────────────────────────────────────

Keeper calls:
  vault::execute_mint(vault, manager, predict, oracle, intent_id, clock, ctx)

  Checks:
    ctx.sender() == vault.keeper
    object::id(manager) == vault.manager_id
    live ask ≤ max_cost  (if max_cost > 0; else ELimitNotMet → keeper retries)

  State changes:
    intent removed from vault.intents
    vault.escrow.split(ask) → manager.deposit → predict::mint
    vault.escrow.split(refund) → returned to user  (overpayment rebate)
    vault.exposure[binary_key(oracle_id, expiry, strike)].yes_qty += qty   (if is_up)
                                                              .no_qty  += qty   (if !is_up)
    If tp_value > 0 || sl_value > 0:
      PositionToken → vault.positions[position_id] = PositionTicket { user, token, tp, sl }
      Event: PositionMonitored { vault_id, position_id, user, oracle_id, expiry, qty, tp_value, sl_value }
    Else:
      PositionToken transferred to user
  Event: ExposureChanged { vault_id, key, yes_qty, no_qty }
  Event: MintExecuted { vault_id, intent_id, user, qty, cost, refunded }
```

### Range mint flow

```
User calls:
  vault::request_mint_range(
    vault, oracle_id, expiry,
    lower,     // lower strike boundary (scaled 1e9)
    higher,    // upper strike boundary (scaled 1e9)
    qty, max_cost, tp_value, sl_value, payment, ctx,
  ) → intent_id: u64

  Same escrow + intent pattern as binary.
  Event: MintRequested { …, is_range: true, … }

─────────────────────────────────────────────────────────────────────────

Keeper calls:
  vault::execute_mint(vault, manager, predict, oracle, intent_id, clock, ctx)

  Uses predict::mint_range instead of predict::mint.
  Exposure tracked as yes_qty only (range has no natural NO complement):
    vault.exposure[range_key(oracle_id, expiry, lower, higher)].yes_qty += qty
```

### Redemption flow

```
User calls:
  vault::request_redeem(vault, token, qty, ctx) → redeem_id: u64

  • token: PositionToken received from execute_mint
  • qty: may be < token.qty() for partial redemption — remainder token returned to user
  • token parked in vault.redeems[redeem_id]
  Event: RedeemRequested { vault_id, redeem_id, user, qty }

─────────────────────────────────────────────────────────────────────────

Keeper calls:
  vault::execute_redeem(vault, manager, predict, oracle, redeem_id, clock, ctx)

  • Calls predict::redeem or predict::redeem_range
  • payout = manager.balance change after redemption
  • payout transferred to user
  • PositionToken burned
  • vault.exposure[key] decremented
  Events: ExposureChanged, RedeemExecuted { vault_id, redeem_id, user, qty, payout, is_settled }
```

### TP/SL exit flow

When a position is custodied for monitoring (`tp_value > 0 || sl_value > 0`):

```
Anyone calls:
  vault::execute_position_exit(vault, manager, predict, oracle, position_id, clock, ctx)

  Checks:
    live bid·qty >= tp_value  (take-profit), OR
    live bid·qty <= sl_value  (stop-loss)
    → if neither: EConditionNotMet (transaction aborts safely)

  Executes predict::redeem / predict::redeem_range
  Transfers payout to original position owner
  Burns PositionToken
  Decrements exposure

  Events: ExposureChanged, PositionExited { vault_id, position_id, user, qty, payout, hit_tp }
```

Owner may also reclaim the token without executing:

```
vault::cancel_position_monitoring(vault, position_id, ctx)
  → asserts ctx.sender() == position.user
  → transfers PositionToken back to user
  → removes from vault.positions
```

### Exposure tracking

```
NetExposure { yes_qty: u64, no_qty: u64 }

Binary key = BCS({ oracle_id, expiry, strike })
  YES mint (is_up=true):  yes_qty += qty
  NO mint  (is_up=false): no_qty  += qty
  Redemption reverses the above.

Range key = BCS({ oracle_id, expiry, lower, higher })
  Range mint: yes_qty += qty (no complement concept for range)
  Redemption: yes_qty -= qty

LP is fully hedged at a key when yes_qty == no_qty.
Net imbalance = |yes_qty − no_qty| is the LP's directional risk at that key.
```

---

## 5. Product: Leverage (Turbo Tickets)

### Model

Fully-reserved synthetic leverage. The pool is the **counterparty**, not a lender. No debt object exists.

```
Ticket equity (mark-to-market):
  X = clip( margin + bid·qty − basis , 0 , margin + reserved )

  where:
    margin   = user's collateral after open_fee deduction
    basis    = Predict ask at open (cost of the protocol's hedge position)
    reserved = qty − basis  (pool capital locked as the payout ceiling)
    bid·qty  = current mark value of qty contracts at Predict bid price

Knockout (liquidation eligible) when:
  X ≤ maint_bps × margin / 10_000

Because Predict contracts are bounded at $1 each:
  max(bid·qty) = qty
  max(X)       = margin + reserved = margin + qty − basis < qty + margin
  Total sealed funds = margin + reserved  (pre-funded at open, Prop. 2)
  → bad debt is impossible by construction
```

**On-chain leverage cap**: `basis ≤ 50 × margin` (500% in bps = 500,000 bps). The dynamic, lower usable-leverage cap is policy enforced off-chain.

**Force-close window**: positions inside `τ_c = force_close_window_ms(qty, margin, maint_bps)` of expiry may be force-closed by anyone, preventing them from reaching expiry with unresolvable leverage.

### Required objects

```
MarginPool<Quote>     — LP capital pool (create_pool)
LeverageBook<Quote>   — position state   (create_book)
LimitBook<Quote>      — limit orders     (create_limit_book)  [optional]
```

Pool fees are fixed at creation:

- `open_fee_bps` — deducted from margin at open → `pool.insurance`
- `perf_bps` — taken from profit at close → stays in `pool.liquidity`
- `penalty_bps` — taken from equity at liquidation → `pool.insurance`

### Market-open flow (via vault)

```
User calls:
  vault::request_leverage_binary(
    vault, oracle_id, expiry, strike, is_up, qty,
    maint_bps,    // knockout threshold (1–9000 bps = 0.01%–90%)
    tp_value,     // optional take-profit level (bid·qty)
    sl_value,     // optional stop-loss level (bid·qty)
    margin,       // Coin<Quote>
    ctx,
  ) → intent_id: u64

  State changes:
    vault.escrow += margin
    vault.intents[intent_id] = Intent { KIND_LEVERAGE_BINARY, … }
  Event: LeverageOpenRequested { vault_id, intent_id, user, oracle_id, expiry,
                                  is_range: false, qty, escrowed }

─────────────────────────────────────────────────────────────────────────

Keeper calls:
  vault::execute_leverage_open(
    vault, manager, predict, oracle,
    pool,          // &mut MarginPool<Quote>
    book,          // &mut LeverageBook<Quote>
    intent_id, clock, ctx,
  )

  Checks:
    ctx.sender() == vault.keeper
    object::id(manager) == vault.manager_id

  Computes:
    basis = predict::get_trade_amounts(predict, oracle, key, qty, clock).ask

  Opens Predict hedge (protocol position):
    vault.escrow.split(basis) → manager.deposit → predict::mint(key, qty)

  Opens Turbo Ticket:
    leverage::open_ticket(pool, book, user, basis, …, margin_coin, qty, maint_bps, tp, sl, clock, ctx)
      ├── fee = open_fee_bps × gross_margin → pool.insurance
      ├── m = gross_margin − fee   (working margin)
      ├── asserts basis ≤ 50×m  (leverage cap)
      ├── asserts clock.ms + force_window < expiry
      ├── reserved = qty − basis
      ├── pool.reserve(reserved) → splits from pool.liquidity, increments pool.reserved_out
      ├── ticket.funds = m + reserved  (sealed, never re-opened)
      └── book.positions[position_id] = Ticket { owner, funds, margin: m, basis, reserved, … }

  Event: LeverageOpenExecuted { vault_id, intent_id, user, position_id, basis }
  Event: TicketOpened { book_id, position_id, owner, qty, margin, basis, reserved,
                        maint_bps, expiry, tp_value, sl_value, force_window_ms }
```

### Closing paths

All closing paths call the shared internal `settle()`:

```
settle(pool, book, predict, oracle, position_id, is_liquidation, clock, ctx):
  1. value = ticket_value(pos, predict, oracle, clock)
              = predict bid price for qty contracts at the ticket's key
  2. (to_owner, to_insurance) = settle_amounts(margin, basis, reserved, value,
                                               perf_bps, penalty_bps, is_liquidation)
  3. funds.split(to_owner) → transferred to owner
  4. funds.split(to_insurance) → pool.insurance
  5. funds.remainder → pool.liquidity (via release: decrements reserved_out)
  Event: TicketClosed { book_id, position_id, owner, value, equity,
                        to_owner, to_insurance, returned_to_pool, liquidated }
```

**Settlement split formulas**:

```
Close / force-close / TP / SL (is_liquidation = false):
  X          = clip(margin + value − basis, 0, margin + reserved)
  perf_fee   = perf_bps × max(X − margin, 0) / 10_000
  to_owner   = X − perf_fee
  to_insurance = 0
  pool_gain  = (margin + reserved) − to_owner   [includes returned reserve]

Liquidation (is_liquidation = true):
  X          = clip(margin + value − basis, 0, margin + reserved)
  penalty    = min(X, penalty_bps × margin / 10_000)
  to_owner   = X − penalty
  to_insurance = penalty
  pool_gain  = (margin + reserved) − X           [remaining reserve returned]
```

| Closing path | Who initiates | Condition | Fee |
| --- | --- | --- | --- |
| `close` | Position owner | Owner-signed; position not locked | `perf_bps` on profit |
| `liquidate` | Anyone | `X ≤ maint_bps × margin / 10_000` | `penalty_bps` on margin |
| `force_close` | Anyone | In τ_c window, OR equity < next epoch fee | `perf_bps` on profit |
| `execute_tp` | Anyone | `bid·qty ≥ tp_value` and `tp_value > 0` | `perf_bps` on profit |
| `execute_sl` | Anyone | `bid·qty ≤ sl_value` and `sl_value > 0` | `perf_bps` on profit |

### TP/SL management

```
leverage::set_tp_sl(book, position_id, tp_value, sl_value, ctx)
  → asserts owner == ctx.sender()
  → updates ticket in-place
  Event: TpSlUpdated { book_id, position_id, tp_value, sl_value }

leverage::add_margin(book, position_id, payment)
  → permissionless — anyone may top up a position
  → increments ticket.margin and ticket.funds
  → raises equity cap, lowers effective knockout threshold
```

### Limit orders

```
User calls:
  leverage::place_limit_binary(
    limit_book, oracle_id, expiry, strike, is_up, qty, maint_bps,
    limit_basis,   // open when live ask ≤ this value
    order_ttl,     // ms timestamp — order expires after this
    tp_value, sl_value,
    escrow,        // Coin<Quote> — margin held in limit_book
    clock, ctx,
  ) → order_id: u64

  Stores LimitOrder in limit_book.orders[order_id]
  Event: LimitOrderPlaced { limit_book_id, order_id, owner, is_range, qty, escrow, limit_basis, order_ttl }

─────────────────────────────────────────────────────────────────────────

Anyone calls (permissionless fill):
  leverage::execute_limit(pool, leverage_book, limit_book, predict, oracle, order_id, clock, ctx)

  Checks:
    clock.ms ≤ order.order_ttl           (not expired)
    live ask ≤ order.limit_basis         (condition met)
  Calls open_ticket on behalf of the original owner
  Event: LimitOrderExecuted { limit_book_id, order_id, owner, position_id, basis }

─────────────────────────────────────────────────────────────────────────

leverage::cancel_limit(limit_book, order_id, ctx) → Coin<Quote>
  → owner-only; refunds escrow
  Event: LimitOrderCancelled

leverage::expire_limit(limit_book, order_id, clock, ctx) → Coin<Quote>
  → permissionless after order_ttl; refunds escrow to owner
  Event: LimitOrderCancelled
```

---

## 6. Product: Window Bets

### What it is

A rolling-epoch band market. Each epoch defines N price bands (e.g. 8 bands covering the ATM ± range). Users bet on which band contains the settlement price. The LP pool earns spread + skew on every bet; DeepBook Predict covers the actual winning payouts (the LP pool carries zero directional risk).

### Pricing model

```
User pays:  total_basis = svi_ask + spread + skew

svi_ask   = raw_cost from predict::get_range_trade_amounts for the band's range
            → this is routed to Predict as a range hedge mint

spread    = raw_ask × spread_bps / 10_000
            where raw_ask = raw_cost × PRICE_SCALE / qty  (per-contract price, scaled)

skew      = base_ask × skew_bps / 10_000
            where skew_bps = skew_alpha_bps × excess / expected_n
            excess = band_qty × band_count − total_qty   (0 if band is not overweight)

→ spread + skew = total_basis − svi_ask → WindowBook.pool  (LP revenue)
→ svi_ask → PredictManager → Predict range mint            (hedge, covers payout)
```

The band with the most bets gets priced higher via the skew term, discouraging one-sided markets.

### WindowBook object layout

```move
public struct WindowBook<phantom Quote> has key {
    id: UID,
    band_count: u64,          // N bands per epoch
    spread_bps: u64,          // base spread
    skew_alpha_bps: u64,      // skew sensitivity per unit of overweight
    epochs: Table<u64, Epoch>,
    next_epoch_id: u64,
    pool: Balance<Quote>,     // LP capital + spread/skew revenue
    total_lp_shares: u64,
}

Epoch {
    oracle_id, expiry,
    strikes: vector<u64>,           // N+1 strike boundaries
    qty_sold: vector<u64>,          // per-band qty sold so far
    basis_collected: vector<u64>,   // per-band total user payments
    total_qty: u64,
    winning_band: Option<u64>,
    settled: bool,
    bets: Table<u64, Bet>,
}
```

### Full lifecycle

```
── Setup ────────────────────────────────────────────────────────────────

windows::create_and_share<Quote>(band_count, spread_bps, skew_alpha_bps, ctx) → book_id

── Epoch roll (Keeper) ─────────────────────────────────────────────────

windows::roll_epoch(book, oracle_id, expiry, strikes, clock, ctx) → epoch_id
  • strikes is a vector of N+1 boundary prices (monotonically increasing, scaled 1e9)
  • Initialises qty_sold[0..N] = 0, basis_collected[0..N] = 0
  Event: EpochRolled { book_id, epoch_id, oracle_id, expiry, strikes }

── Bet placement (User → Keeper) ───────────────────────────────────────

User calls:
  vault::request_window_bet(vault, epoch_id, band_idx, qty, payment, ctx) → intent_id
    • payment is escrowed in vault.escrow
    • Intent { KIND_WINDOW_BET, user, epoch_id, band_idx, qty, escrowed }
    Event: WindowBetRequested { vault_id, intent_id, user, epoch_id, band_idx, qty, escrowed }

Keeper calls:
  vault::execute_window_bet(vault, manager, predict, oracle, book, intent_id, clock, ctx)

  Computes:
    (oracle_id, expiry, lower, higher) = windows::epoch_band_range(book, epoch_id, band_idx)
    (svi_ask, total_basis) = windows::compute_bet_price(book, predict, oracle, epoch_id, band_idx, qty, clock)

  Checks:
    total_basis ≤ escrowed  (slippage check; reverts with ESlippageExceeded if market moved)

  Routes funds:
    vault.escrow.split(svi_ask) → manager.deposit → predict::mint_range(key, qty)
    vault.escrow.split(total_basis − svi_ask) → WindowBook.pool  (LP revenue)
    vault.escrow.split(escrowed − total_basis) → returned to user (slippage refund)

  Issues:
    BetTicket { book_id, epoch_id, band_idx, qty, basis } → transferred to user

  State changes in WindowBook:
    epoch.qty_sold[band_idx]       += qty
    epoch.basis_collected[band_idx]+= total_basis
    epoch.total_qty                += qty

  Events: WindowBetExecuted { vault_id, intent_id, user, epoch_id, band_idx, qty, svi_ask, total_basis }
          BetPlaced { book_id, epoch_id, bet_id, band_idx, qty, basis }

── Settlement (Keeper + anyone) ────────────────────────────────────────

Anyone calls:
  windows::settle_epoch(book, oracle, epoch_id)
    • oracle must be settled (oracle::is_settled)
    • finds winning band: first band where strikes[i] ≤ settlement_price < strikes[i+1]
      (if price outside all bands → winning_band = None, all bets lose)
    Event: EpochSettled { book_id, epoch_id, settlement_price, winning_band }

Keeper calls:
  vault::execute_epoch_payout(vault, manager, predict, oracle, book, epoch_id, clock, ctx)
    • If winning_band.is_some() and qty_sold[winning_band] > 0:
        predict::redeem_range for total_qty on winning band
        payout = manager balance delta
        payout moved into vault.settlements[epoch_id]
    • Else: vault.settlements[epoch_id] = zero balance (marks epoch as done)
    Event: EpochPayoutExecuted { vault_id, epoch_id, payout, winning_band }

User claims (permissionless):
  vault::claim_window_bet(vault, book, ticket, ctx)
    • burns BetTicket
    • if ticket.band_idx == winning_band:
        payout = settlement[epoch_id].split(min(available, qty))
        transferred to ctx.sender() (ticket is transferable — claimer may differ from bettor)
    • else: payout = 0
    Event: WindowBetClaimed { vault_id, epoch_id, band_idx, qty, payout, owner }
```

---

## 7. Product: Combos

### What it is

A combo groups N binary/range predict legs and/or M leverage legs into a single multi-leg position. `PositionToken`s from predict legs are held inside the `ComboEntry` (stored as a dynamic field on the vault's UID) instead of being transferred to the user. Leverage legs are locked in `LeverageBook` until the combo settles.

### Settlement modes

| Mode | Value | Behaviour |
| --- | --- | --- |
| `PORTFOLIO` | 0 | Legs settle independently; accumulated payout claimable after all settle |
| `PARLAY` | 1 | All legs must win; first loss immediately zeroes accumulated payout and closes the combo |

Leverage legs cannot participate in PARLAY (equity is paid out immediately at settlement, making revocation impossible if another leg subsequently loses).

### Combo kinds (UI / informational only)

`SPREAD(0)`, `CONDOR(1)`, `LADDER(2)`, `DIAGONAL(3)`, `CROSS_ASSET(4)`, `TEMPORAL_CONDOR(5)`, `CUSTOM(6)`

### ComboEntry layout

```move
ComboEntry {
    vault_id, owner,
    mode: u8,              // PORTFOLIO or PARLAY
    kind: u8,              // informational
    legs: vector<ComboLeg>,
    settled_count: u8,
    wins: u8,
    accumulated: u64,      // running sum of leg payouts (predict legs only)
    status: u8,            // ACTIVE / WON / LOST / PENDING
    last_expiry: u64,      // max expiry across all legs
}

ComboLeg {
    kind: u8,              // LEG_BINARY / LEG_RANGE / LEG_LEVERAGE
    oracle_id, expiry,
    strike, is_up,         // binary only
    lower, higher,         // range only
    qty,
    intent_id,             // vault intent id (binary/range); 0 for leverage
    position_id,           // LeverageBook position id (leverage only); 0 for predict
    token: Option<PositionToken>,  // filled after execute_combo_mint
    settled, won, payout,
}
```

### Predict-only combo flow

```
User calls:
  vault::request_combo<Quote>(vault, legs: vector<ComboLegInput>, mode, kind, payment, ctx)
    • legs is a vector of ComboLegInput (built via binary_leg_input / range_leg_input helpers)
    • Each leg's escrow is split from payment and joined into vault.escrow
    • One intent (KIND_PREDICT_BINARY / _RANGE) is created per leg
    • ComboEntry created as dynamic field on vault.id (via combo::create_entry)
    Event: ComboCreated { vault_id, combo_id, owner, mode, kind, leg_count, last_expiry }

──── Per predict leg (Keeper) ────────────────────────────────────────────

Keeper calls (once per predict leg):
  vault::execute_combo_mint(vault, manager, predict, oracle, combo_id, leg_index, clock, ctx)
    • Reads intent_id from combo entry's leg at leg_index
    • Calls execute_mint_internal (same path as normal execute_mint)
    • PositionToken stored in combo entry (not transferred to user)
    • LP exposure updated
    Event: ComboMintExecuted { vault_id, combo_id, leg_index, intent_id }
    Event: ExposureChanged

──── Settlement: per leg, after expiry (Keeper) ─────────────────────────

Keeper calls (once per leg, after oracle settles):
  vault::settle_combo_leg(vault, manager, predict, oracle, combo_id, leg_index, clock, ctx)
    • Takes PositionToken from combo entry
    • Calls predict::redeem / redeem_range
    • payout = manager balance delta
    • Calls combo::record_settlement(vault.id, vault_id, combo_id, leg_index, won, payout, accumulate=true)
        → leg.settled = true; leg.payout = payout
        → if won: entry.accumulated += payout
        → PARLAY: first loss → entry.accumulated = 0, status = LOST
        → if all settled: entry.status = WON or LOST
    • If all_done and accumulated > 0:
        manager.withdraw(accumulated) → vault.settlements[combo_id + (1<<32)]
    Event: ComboLegSettled { vault_id, combo_id, leg_index, won, payout }
    Event: ComboSettled { vault_id, combo_id, status, total_payout }  [when all_done]
    Event: ExposureChanged

User claims (permissionless, after all legs settled):
  vault::claim_combo(vault, combo_id, ctx)
    • combo::take_for_claim verifies caller is entry.owner and all legs settled
    • pulls balance from vault.settlements[combo_id + (1<<32)]
    • transfers to caller
    • combo::destroy_entry burns remaining tokens / handles leverage leg cleanup
    Event: ComboClaimed { vault_id, combo_id, owner, payout }
```

### Mixed combo flow (predict + leverage legs)

```
User calls:
  vault::request_combo_with_leverage<Quote>(
    vault, book,          // &mut LeverageBook<Quote>
    predict_legs,         // vector<ComboLegInput>
    leverage_legs,        // vector<LeverageLegInput>
    mode, kind, payment, ctx,
  ) → combo_id: u64

  Predict legs: same as request_combo above (intents created, escrow taken)
  Leverage legs:
    • Each must already be an OPEN position owned by ctx.sender()
    • leverage::lock_for_combo(book, position_id, owner)
        → pos.locked = true
        → owner cannot independently call close() while locked
    • combo_leg = ComboLeg { kind: LEG_LEVERAGE, position_id, … }

  Event: ComboCreated { vault_id, combo_id, owner, mode, kind, leg_count, last_expiry }

──── Predict legs: execute_combo_mint (same as above) ────────────────────

──── Leverage legs: settle_combo_leverage_leg (Keeper) ──────────────────

Keeper calls:
  vault::settle_combo_leverage_leg(vault, pool, book, predict, oracle, combo_id, leg_index, clock, ctx)
    • Calls leverage::settle_for_combo(pool, book, predict, oracle, position_id, clock, ctx)
        → same settlement math as regular close (perf fee, no penalty)
        → equity (to_owner) transferred directly to position owner
        → returns to_owner for record_settlement
    • combo::record_settlement(…, won = to_owner > 0, payout = to_owner, accumulate = false)
        [accumulate=false because equity was already transferred — not accumulated in the combo]

User claims:
  vault::claim_combo(vault, combo_id, ctx)
    • Only predict legs contribute to the claimable accumulated balance
    • Leverage equity was already sent to owner at settle_combo_leverage_leg time
```

### PTB-friendly builder API

For cases where the vector of `ComboLegInput` is too large to construct in a single PTB, a step-by-step builder API exists:

```
vault::begin_combo(vault, mode, kind, ctx)          → combo_id  (STATUS_PENDING)
vault::add_binary_leg(vault, manager, predict, oracle, combo_id, …, payment, clock, ctx)
vault::add_range_leg(vault, manager, predict, oracle, combo_id, …, payment, clock, ctx)
vault::add_leverage_leg(vault, book, combo_id, position_id, oracle_id, expiry, qty, ctx)
vault::finalize_combo(vault, combo_id, ctx)         → validates ≥2 legs, emits ComboCreated
```

---

## 8. LP Accounting & Yield

### MarginPool (leverage)

```
pool_value  = pool.liquidity.value() + pool.reserved_out
            = total LP value (idle + reserved for open tickets)

LP share value = shares × pool_value / total_shares

Mint:  shares = amount × total_shares / pool_value   (or 1:1 if pool empty)
Burn:  amount = shares × pool_value / total_shares
       asserts pool.liquidity ≥ amount  (reserved capital can't be pulled)

Revenue flows IN to pool:
  open_fee     → pool.insurance     (per every leverage open)
  perf_fee     → pool.liquidity     (on profitable closes)
  penalty      → pool.insurance     (on liquidations)
  reserve_gain → pool.liquidity     (when closed position payout < reserved)

Revenue flows OUT of pool:
  to_owner     ← funded from ticket.funds (margin + reserved, sealed at open)
  pool never pays out from pool.liquidity directly — it was locked into the ticket
```

**Insurance fund**: `pool.insurance` is a separate balance within the pool. It accumulates open fees and liquidation penalties. Future: can be drawn on to cover bad debt shortfalls before pool liquidity is touched.

### WindowBook LP

```
pool_value  = book.pool.value()
            = LP principal + all accrued spread/skew revenue
            (no reservation — Predict covers all payouts)

LP share value = shares × pool_value / total_lp_shares

Mint:  shares = amount × total_lp_shares / pool_value   (or 1:1 if pool empty)
Burn:  amount = shares × pool_value / total_lp_shares
       always withdrawable — no reserved capital

Revenue flows IN:
  spread × svi_ask / qty  → pool   (per bet)
  skew premium            → pool   (per overweight band)
```

---

## 9. Trust Model & Permission Table

| Function | Caller constraint | Fails if |
| --- | --- | --- |
| `vault::execute_mint` | `ctx.sender() == vault.keeper` | `ENotKeeper` |
| `vault::execute_redeem` | `ctx.sender() == vault.keeper` | `ENotKeeper` |
| `vault::execute_leverage_open` | `ctx.sender() == vault.keeper` | `ENotKeeper` |
| `vault::execute_window_bet` | `ctx.sender() == vault.keeper` | `ENotKeeper` |
| `vault::execute_epoch_payout` | `ctx.sender() == vault.keeper` | `ENotKeeper` |
| `vault::execute_combo_mint` | `ctx.sender() == vault.keeper` | `ENotKeeper` |
| `vault::settle_combo_leg` | `ctx.sender() == vault.keeper` | `ENotKeeper` |
| `vault::settle_combo_leverage_leg` | `ctx.sender() == vault.keeper` | `ENotKeeper` |
| `vault::cancel_mint_intent` | `ctx.sender() == intent.user` | `ENotIntentOwner` |
| `vault::cancel_position_monitoring` | `ctx.sender() == position.user` | `ENotIntentOwner` |
| `vault::request_*` | Anyone | — |
| `vault::claim_combo` | Anyone (payout → entry.owner) | `ENotOwner` if caller ≠ owner |
| `vault::claim_window_bet` | Anyone (payout → ticket holder) | — |
| `leverage::close` | Position owner | `ENotOwner`, `ELockedInCombo` |
| `leverage::set_tp_sl` | Position owner | `ENotOwner` |
| `leverage::add_margin` | Anyone | — |
| `leverage::liquidate` | Anyone | `ENotLiquidatable` if healthy |
| `leverage::force_close` | Anyone | `EForceWindowNotReached` if not eligible |
| `leverage::execute_tp` | Anyone | `EConditionNotMet` if not triggered |
| `leverage::execute_sl` | Anyone | `EConditionNotMet` if not triggered |
| `leverage::place_limit_*` | Anyone | — |
| `leverage::execute_limit` | Anyone | `ELimitNotCrossed`, `EOrderExpired` |
| `leverage::cancel_limit` | Order owner | `ENotOwner` |
| `leverage::expire_limit` | Anyone | `EOrderExpired` if TTL not elapsed |
| `windows::settle_epoch` | Anyone | `ENotSettled` if oracle not settled |
| `vault::execute_position_exit` | Anyone | `EConditionNotMet` if TP/SL not triggered |

All keeper calls include strict on-chain checks. The keeper cannot steal funds — it can only route them according to the invariants embedded in each function.

---

## 10. Event Reference

### vault.move events

| Event | When emitted | Key fields |
| --- | --- | --- |
| `VaultCreated` | `vault::create` | vault_id, manager_id, keeper |
| `MintRequested` | `request_mint_binary/range` | vault_id, intent_id, user, oracle_id, expiry, is_range, qty, escrowed, max_cost |
| `MintCancelled` | `cancel_mint_intent` | vault_id, intent_id, user, refunded |
| `MintExecuted` | `execute_mint` | vault_id, intent_id, user, qty, cost, refunded |
| `RedeemRequested` | `request_redeem` | vault_id, redeem_id, user, qty |
| `RedeemExecuted` | `execute_redeem` | vault_id, redeem_id, user, qty, payout, is_settled |
| `ExposureChanged` | every mint/redeem | vault_id, key (BCS bytes), yes_qty, no_qty |
| `PositionMonitored` | `execute_mint` (when TP/SL set) | vault_id, position_id, user, oracle_id, expiry, qty, tp_value, sl_value |
| `PositionExited` | `execute_position_exit` | vault_id, position_id, user, qty, payout, hit_tp |
| `LeverageOpenRequested` | `request_leverage_binary/range` | vault_id, intent_id, user, oracle_id, expiry, is_range, qty, escrowed |
| `LeverageOpenExecuted` | `execute_leverage_open` | vault_id, intent_id, user, position_id, basis |
| `WindowBetRequested` | `request_window_bet` | vault_id, intent_id, user, epoch_id, band_idx, qty, escrowed |
| `WindowBetExecuted` | `execute_window_bet` | vault_id, intent_id, user, epoch_id, band_idx, qty, svi_ask, total_basis |
| `EpochPayoutExecuted` | `execute_epoch_payout` | vault_id, epoch_id, payout, winning_band |
| `WindowBetClaimed` | `claim_window_bet` | vault_id, epoch_id, band_idx, qty, payout, owner |
| `ComboClaimed` | `claim_combo` | vault_id, combo_id, owner, payout |

### leverage.move events

| Event | When emitted | Key fields |
| --- | --- | --- |
| `PoolCreated` | `create_pool` | pool_id, perf_bps, penalty_bps, open_fee_bps |
| `TicketOpened` | `open_ticket` | book_id, position_id, owner, qty, margin, basis, reserved, maint_bps, expiry, force_window_ms |
| `TicketClosed` | `settle` (all paths) | book_id, position_id, owner, value, equity, to_owner, to_insurance, returned_to_pool, liquidated |
| `TpSlUpdated` | `set_tp_sl` | book_id, position_id, tp_value, sl_value |
| `LimitBookCreated` | `create_limit_book` | limit_book_id |
| `LimitOrderPlaced` | `place_limit_*` | limit_book_id, order_id, owner, is_range, qty, escrow, limit_basis, order_ttl |
| `LimitOrderExecuted` | `execute_limit` | limit_book_id, order_id, owner, position_id, basis |
| `LimitOrderCancelled` | `cancel_limit`, `expire_limit` | limit_book_id, order_id, owner, refunded |

### windows.move events

| Event | When emitted | Key fields |
| --- | --- | --- |
| `EpochRolled` | `roll_epoch` | book_id, epoch_id, oracle_id, expiry, strikes |
| `BetPlaced` | `record_bet` | book_id, epoch_id, bet_id, band_idx, qty, basis |
| `EpochSettled` | `settle_epoch` | book_id, epoch_id, settlement_price, winning_band |
| `PayoutClaimed` | (windows-level, via test helpers) | book_id, epoch_id, band_idx, qty, payout, owner |

### combo.move events

| Event | When emitted | Key fields |
| --- | --- | --- |
| `ComboCreated` | `create_entry` / `finalize_entry` | vault_id, combo_id, owner, mode, kind, leg_count, last_expiry |
| `ComboMintExecuted` | `store_token` | vault_id, combo_id, leg_index, intent_id |
| `ComboLegSettled` | `record_settlement` | vault_id, combo_id, leg_index, won, payout |
| `ComboSettled` | `record_settlement` (when all_done) | vault_id, combo_id, status, total_payout |

---

## 11. Money Flow Diagrams

### Binary / Range mint

```
User
 │  payment (Coin<Quote>)
 ▼
vault.escrow  ──[ask portion]──► manager.deposit()
                                        │
                                        ▼
                                  predict::mint()
                                        │
                                        ▼
                                  PositionToken ──► user (or vault.positions if TP/SL)
              ──[refund portion]──► user (if overpaid)
```

### Binary / Range redeem

```
PositionToken
     │ (user provides)
     ▼
vault.redeems[redeem_id]
     │  (keeper executes)
     ▼
predict::redeem()
     │
     ▼
payout (via manager) ──► user
PositionToken burned
```

### Leverage open

```
User margin (Coin<Quote>)
     │
     ▼
vault.escrow
     │
     ├──[basis]──────────────────► manager.deposit → predict::mint  (protocol hedge)
     │
     └──[margin - basis]──────────────────────────────────────────────────────────┐
                                                                                  │
                                                                        leverage::open_ticket()
                                                                                  │
                                                    ┌─────────────────────────────┤
                                                    │ open_fee → pool.insurance   │
                                                    │ m = margin - open_fee       │
                                                    │ reserved = qty - basis      │
                                                    │   ← pool.reserve(reserved)  │
                                                    │ ticket.funds = m + reserved │
                                                    └─────────────────────────────┘
```

### Leverage close (voluntary)

```
ticket.funds = margin + reserved
     │
     ├──[to_owner = X - perf_fee]──────────────────────────────────► owner
     │    where X = clip(margin + bid·qty - basis, 0, margin + reserved)
     │    perf_fee = perf_bps × max(X - margin, 0) / 10_000
     │
     ├──[to_insurance = 0]
     │
     └──[returned = funds - to_owner]──────────────────────────────► pool.liquidity
          (via pool.release: decrements pool.reserved_out)
```

### Leverage liquidation

```
ticket.funds = margin + reserved
     │
     ├──[to_owner = X - penalty]─────────────────────────────────────► owner
     │    where penalty = min(X, penalty_bps × margin / 10_000)
     │
     ├──[to_insurance = penalty]─────────────────────────────────────► pool.insurance
     │
     └──[returned = funds - X]───────────────────────────────────────► pool.liquidity
```

### Window bet

```
User payment (Coin<Quote>, escrowed)
     │
     ├──[svi_ask]────────────────► manager.deposit → predict::mint_range  (band hedge)
     │
     ├──[spread + skew]──────────► WindowBook.pool  (LP revenue)
     │
     └──[refund = escrowed - total_basis]──────────────────────────────► user
                                                  BetTicket ──────────► user

     [At settlement]

predict::redeem_range (winning band)
     │
     ▼
payout ──────────────────────────────────────────► vault.settlements[epoch_id]
                                                            │
                                          User: claim_window_bet
                                                            │
                                     qty / total_winning_qty × payout ──► user
```

### Combo payout (predict-only, PORTFOLIO)

```
[Each leg at settlement]
predict::redeem(leg token)
     │
     ▼
payout (if won) ──► manager balance ──► accumulated in combo entry

[When all legs settled and accumulated > 0]
manager.withdraw(accumulated) ──► vault.settlements[combo_id + (1<<32)]

[User: claim_combo]
vault.settlements[slot] ──► user
```

---

## 12. Testnet Verification

All five cerida flows have been exercised end-to-end on Sui testnet against the deployed vault:

```
ceridaPkg  = 0xd2f87c454c3af8d17d7c5de7c80ea3690d6f4a85cbda6b9450d4c119bcd21725
vaultId    = 0xaaec7c2127409edf281e7d8dd3a3c49d0754ae983c0c042991d23727fd3c5615
poolId     = 0x4296729733e7e731afa6bd1cf853a40a55e59446138fcd0ab31091bdc37d34cb
bookId     = 0x422c7e55437af046c9ee30521f1fe9014705bd66f4b188725201d61f276d10b7
```

### Scenario: 10.3x leverage open (2026-06-22)

**Tx:** [`FgPGPaH6cp8r7yEuC3TrsuoEq2m3Gfh7nepWczaNfhqe`](https://suiexplorer.com/txblock/FgPGPaH6cp8r7yEuC3TrsuoEq2m3Gfh7nepWczaNfhqe?network=testnet)

| Parameter                  | Value                                      |
| -------------------------- | ------------------------------------------ |
| Underlying                 | BTC @ $63,239 (testnet oracle)             |
| Strike                     | $63,239 ATM                                |
| Direction                  | UP binary                                  |
| qty                        | 1,000 contracts                            |
| Binary price at open       | 48.8%                                      |
| basis (pool funds options) | 488 dUSDC                                  |
| reserved (max user gain)   | 512 dUSDC                                  |
| margin (user posts)        | $49.75 dUSDC (after 0.25% open fee on $50) |
| **Leverage**               | **10.3x** (reserved ÷ margin)              |
| Liquidation threshold      | $24.40 margin (5% of $488 basis)           |

**Payoff table:**

| Scenario                       | Payout  | P&L      |
| ------------------------------ | ------- | -------- |
| WIN — BTC > $63,239 at expiry  | $561.75 | +$512.00 |
| LOSE — BTC ≤ $63,239 at expiry | $0      | −$49.75  |

**How the math works (Turbo Ticket model):**

- User posts `margin` ($50). The `MarginPool` buys `qty` binary YES contracts; cost = `basis` ($488).
- If ITM: contracts pay $1 each → $1,000 total. Repay $488 to pool. User receives margin + reserved = $49.75 + $512 = **$561.75**.
- If OTM: contracts pay $0. Pool is owed $488; user's $49.75 margin covers $49.75 of that. Pool absorbs remaining ~$438 shortfall from LP capital (and insurance fund).
- `reserved / margin = 512 / 49.75 ≈ 10.3x` — the leverage multiple.
- No bad debt is possible for the _user_: payoff is bounded to `[0, margin + reserved]`.

**Total dUSDC spent in this test:** $100 (LP top-up) + $50 (margin) = **$150**

## 13. Module Summary

| Module | Lines | Responsibility |
| --- | --- | --- |
| `vault.move` | ~1350 | Single entry point: intent queue, request/execute for all products, exposure tracking, TP/SL custody, window bet routing, combo orchestration |
| `leverage.move` | ~1060 | MarginPool, LeverageBook, LimitBook; ticket math (equity, knockout, force-close window); fee splits; limit order lifecycle |
| `windows.move` | ~600 | WindowBook; epoch lifecycle (roll/settle); band pricing (spread + skew formula); LP share accounting |
| `combo.move` | ~410 | ComboEntry CRUD via dynamic fields on vault UID; leg lifecycle (store_token, take_token, record_settlement); PORTFOLIO/PARLAY logic; claim/destroy |
| `intent.move` | ~228 | Typed intent struct with kind tag; constructors and getters for each kind; no state |
| `position_token.move` | ~100 | Thin wrapper around Predict's PositionToken for cerida custody; split/burn |
| `manager.move` | ~50 | Thin wrapper around PredictManager for keeper-gated deposit; balance query |
