# A Trigger Book over the Option Vault

**Cerida — design + model note v1 (June 2026)**

An order book for a continuous-strike options venue where **the vault is the only
market maker**. Orders carry *conditions*, not quotes; they execute permissionlessly
against the vault's deterministic option price the moment it crosses their level.
Liquidity is never fragmented — there is one pool, and resting capital can *deepen*
it rather than sit beside it. The design reuses Cerida's validated turbo-ticket
machinery (sealed escrow + on-chain-verified trigger + permissionless execution) and
inherits its solvency guarantee. This note fixes the fill semantics, states the
economics honestly (no hand-waving "free yield"), and lists the propositions the
companion Monte Carlo (`simulations/orderbook_mc.ts`) validates.

---

## 1. Why not a CLOB

The venue prices options on a continuous strike grid against a vault AMM (DeepBook
Predict): `quote(K, τ, size) = mark_SVI(K, τ) ± spread(inventory, utilization, σ)`,
with `mark = N(d2)` (§ leverage-model). Two structural facts kill the classical order
book:

1. **No book can span continuous strikes.** A CLOB needs resting depth *per
   instrument*; with a market at every \$100 tick × every expiry, there is no finite
   set of books to seed. The only tractable "book" is a conditional layer over one
   vault that quotes all strikes.
2. **Resting maker liquidity would fragment the vault.** Any second venue of resting
   quotes competes with PLP for the maker side and splits depth — the opposite of the
   goal.

So orders must be **takers-on-condition** against the sole maker (the vault), not
resting quotes. This is a *trigger book*, not a matching engine.

---

## 2. The instrument

An order is a sealed object (the turbo-ticket pattern, reused):

```
Order { owner, escrow: Balance, key: (oracle, expiry, strike|band),
        predicate: (side ∈ {Bid, Ask}, level L), action, ttl }

action ∈ { MintOption | RedeemOption(pos) | OpenTurbo{λ,θ} | CloseTurbo(id) }

execute(order, predict, oracle, clock)   // ANYONE; re-quotes on-chain, asserts cross
cancel(order)        // owner: refund escrow
expire(order)        // anyone after ttl: refund escrow
```

One predicate type covers every order in the venue:

| Order | predicate | action |
|---|---|---|
| limit buy option | `Ask ≤ L` | `MintOption` |
| take-profit | `Bid ≥ L` | `RedeemOption(pos)` |
| stop-loss | `Bid ≤ L` | `RedeemOption(pos)` |
| limit-entry leverage | `Ask ≤ L` | `OpenTurbo{λ,θ}` |
| liquidation / force-close | (protocol) | `CloseTurbo(id)` |

The protocol's existing `liquidate`/`force_close` are simply trigger orders the
protocol authors; users get to write their own. A stop *is* a knock-out barrier; a
limit *is* a one-touch — the book is the options-execution layer, and the orders are
themselves barrier claims on the mark.

---

## 3. Fill semantics — the load-bearing decision

**An executed order fills at the vault's live quote at execution time, not at the
trader's limit `L`.**

When a buy trigger `Ask ≤ L` fires, the executor mints at the *current* ask, which is
`≤ L` (that is the trigger condition). The trader receives **price improvement** equal
to `L − ask_fill ≥ 0`; the vault sells at its own fair curve price.

Why this and not "fill exactly at L":

- **Vault never sells off-curve** ⇒ the vault carries **no gap liability** from the
  book. A guaranteed-at-`L` fill would make the vault short the overshoot on every gap
  — reintroducing exactly the gap risk the whole architecture removes. Fill-at-quote
  keeps each fill's vault PnL equal to its ordinary spread (Prop. 1).
- It is the honest AMM-trigger semantics: "transact with the vault once its price
  reaches your level," not "force the vault to a stale price."

The trade-off the trader accepts: a fast spike *through* `L` that retraces before the
next monitoring tick may be missed (no fill), exactly as with a real resting bid that
the touch skipped. Sub-second monitoring on Sui makes this rare; the sim quantifies it.

---

## 4. Economics — stated honestly

Resting in this book is **not** a free option the trader writes to incoming flow (the
Copeland–Galai 1983 CLOB result does **not** apply — there is no counterparty flow
hitting the rester; the rester hits the vault). So there is **no separate "premium" the
vault pays the rester** in the base design. Two capital modes:

**SEALED (default).** Escrow sits idle until the trigger fires; the order is a stored
conditional market order. Convenience and automation (limit/stop/TP without watching),
nothing more. The trader pays the ordinary spread on fill. **Zero new solvency risk,
zero new capital cost to anyone.** This is the v1.

**STAKED (opt-in, the "pays you to wait" mode, and the anti-fragmentation core).**
While resting, the escrow is supplied to PLP — *it becomes vault liquidity*. The
resting trader earns the vault's maker yield (spread income) on capital that would
otherwise be idle, then the capital is pulled and converted when the trigger fires.
The "yield" is real and fundable because it is simply the vault's *existing* spread
revenue, now shared with the capital that provides it. Quantitatively, a trader whose
order rests for fraction `υ` of the horizon earns ≈ `υ · APR_PLP` on the escrow that
SEALED would leave idle (Prop. 3). Caveat priced in the sim: pulling staked capital at
the trigger instant happens at PLP NAV, which carries withdrawal-limiter friction and
small idiosyncratic drift — bounded, and the fill itself is still at fair quote, so no
adverse-selection loss is layered on top.

The capital picture, with nothing fragmented:

```
                       ┌──────────── ONE POOL (PLP) ───────────┐
   maker  ──supply──▶  │  the only market maker; quotes every  │
                       │  strike off the SVI surface           │
   STAKED orders ───▶  │  resting escrow is supplied here too  │  ← orders DEEPEN
                       │  → they earn maker yield while waiting │     the vault
                       └───────┬───────────────────────────────┘
   takers / triggered orders ──┘  fill at the live fair quote on cross
```

---

## 5. Propositions (validated in `simulations/orderbook_mc.ts`)

- **P1 (no added solvency risk).** Every triggered fill occurs at the vault's live fair
  quote, so the vault's per-fill PnL equals its ordinary spread; the trigger book
  cannot make the vault insolvent and adds no bad-debt path. (Exact, by the fill rule.)
- **P2 (fill rate = first passage).** For a buy at `L = p₀ − d` on the bounded mark
  martingale, fill probability before `min(ttl, expiry)` follows the reflection
  principle; falls in `d`, rises in tenor. Sim reports the empirical curve.
- **P3 (STAKED yield ≈ `υ · APR`).** Mean resting fraction `υ` (capital utilization)
  times the PLP APR is the yield STAKED captures and SEALED forgoes — strictly
  positive, larger for far/long-shot orders that rest longer.
- **P4 (vault gains from hosting).** A filled order is latent demand converted to a
  vault trade: `+spread·q` the vault would not otherwise capture; hosting the book
  strictly increases vault revenue, and STAKED resting strictly increases vault depth.
- **P5 (price improvement ≥ 0).** Trader fill ≤ limit on every fill; the gap-through
  case improves the trader's price (vault still at fair) — never the trader's loss.

## 6. Simulation protocol

GBM spot with production SVI params (`a=.04,b=.10,ρ=−.30,m=0,σ=.10`), linear
total-variance decay, optional Poisson jumps, discrete monitoring `Δt`. Population of
buy-limit orders at distances `d ∈ {.05,.10,.20}` below the entry mark, monitored to
expiry. Per config report: fill rate, mean time-to-fill, resting fraction `υ`, mean
price improvement, fraction of fills strictly below `L` (gap improvement), and the
invariant check that **no fill ever occurs above `L` or off the fair curve** (P1/P5).
Sweep `d × tenor × Δt × jumps`.

## References

- T. Copeland, D. Galai (1983). *Information Effects on the Bid–Ask Spread.* J. Finance
  38(5). (Why CLOB limit orders are free options — and why that does **not** apply here.)
- M. Rubinstein, E. Reiner (1991). *Breaking Down the Barriers.* Risk 4(8). (First-passage / one-touch.)
- Cerida (2026). `paper/leverage-model.md` (the mark, the sealed-escrow + verified-trigger
  + permissionless-execution machinery this book reuses) and `predict::oracle` (the SVI quote).
