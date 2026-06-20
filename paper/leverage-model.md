# Turbo Tickets: Fully-Reserved Knockout Leverage on Risk-Neutral Probabilities

**Cerida — model note v1 (June 2026)**

---

## Abstract

We model leveraged exposure to prediction-market shares (vol-surface-priced binary and
range options on DeepBook Predict) as a **fully-collateralized turbo warrant written on
the risk-neutral probability process**. The trader posts margin `m`; the liquidity pool
locks the instrument's maximum payout at inception; equity tracks the live mark with a
knockout barrier and a hard floor at zero. Because the underlying mark is a *bounded*
martingale on `[0, 1]`, the pool's worst case is finite and pre-funded — **bad debt is
impossible by construction** (Prop. 2), in contrast to lending-based margin on the same
instrument (Prop. 5) and to perpetual futures, where unbounded payoffs make full
reservation infeasible (Prop. 4). Optional stopping gives an exact expression for the
trader's expected cost — spread + fees + expected liquidation penalty — independent of
leverage and exit strategy (Prop. 3). A first-passage approximation yields a
moneyness- and tenor-scaled maximum-leverage rule (§6) with a **dynamic analogue**:
as remaining tenor shrinks, the safe ceiling decays to zero for ATM positions (Prop. 6),
implying a principled critical time τ_c at which any open position must be force-closed —
derived from market parameters, not an arbitrary constant. A Poisson resolution model
extends this decay to deep ITM/OTM positions, closing the gap where the pure diffusion
formula incorrectly permits unlimited leverage. A per-epoch fee model (§7) scales
maintenance cost with realised gamma, replacing a static `maint_bps`. Monte Carlo
experiments (`simulations/leverage_mc.ts`) validate every proposition path-by-path.

---

## 1. Setup

Fix a filtered probability space `(Ω, F, (F_t), Q)` with `Q` the pricing (risk-neutral)
measure used by the Predict oracle. The underlying (BTC) settles at `S_T` at the market
expiry `T`. A *market key* is an event on the settle price:

```
binary UP@K   :  A = { S_T > K }
binary DOWN@K :  A = { S_T ≤ K }
range (L,H]   :  A = { L < S_T ≤ H }
```

**The mark.** Predict quotes the digital price off an SVI total-variance surface
(Gatheral–Jacquier 2014). For the UP key,

```
p_t = N(d2),   d2 = −( k + w/2 ) / √w,   k = ln(K / F_t),   w = w_SVI(k, τ)
```

with `F_t` the forward, `τ = T − t`, and `N` the standard normal CDF — exactly
`compute_nd2` in `predict::oracle`. Ranges are differences of two digitals; everything
below applies verbatim with `p_t` the range mark.

**Assumption M (martingale mark).** Under `Q`, `p_t = E_Q[ 1_A | F_t ]`, hence `p_t` is
a martingale with `p_t ∈ [0,1]` and `p_T = 1_A`. This holds whenever the surface is
calibrated to the market's conditional law of `S_T` (Breeden–Litzenberger 1978); it is
the design intent of the oracle. The venue quotes `p_t^ask = p_t + s_t`,
`p_t^bid = p_t − s_t` with half-spread `s_t ≥ 0` (impact included).

**Units.** Each contract pays \$1 if `A` occurs. Quantities `q` are in contracts; all
cash amounts in quote (dUSDC).

---

## 2. The instrument

A **turbo ticket** opened at `t = 0` is the tuple

```
( m, q, A, θ, π, p̄ )
   m   margin posted by the trader (net of open fee φ_o · m_gross → insurance)
   q   notional contracts referenced
   A   market key (the mark source)
   θ   maintenance fraction  (knockout when equity ≤ θ·m)
   π   liquidation penalty fraction of margin (→ insurance)
   p̄   payout cap mark, p̄ ≤ 1  (default 1: full reserve)
```

Define

```
basis     B = q · p₀^ask                     (cost the shares would have)
leverage  λ = B / m                          (enforced λ ≤ λ_max, hard cap 50)
reserve   R = q · p̄ − B                      (pool's locked worst case)
escrow    E = m + R                          (sealed inside the position at t = 0)
```

**Equity** at any time:

```
X_t = clip( m + q·p_t^bid − B ,  0 ,  m + R )                      (1)
```

**Lifecycle.**

```
close (owner)      : trader receives X_τ − φ_p·(X_τ − m)⁺ ;  pool receives E − X_τ
knockout (anyone)  : at τ_b = inf{ t : X_t ≤ θ·m } — trader receives (X_{τ_b} − π·m)⁺,
                     insurance receives min(X_{τ_b}, π·m), pool receives E − X_{τ_b}
force-close        : keeper-closed at T − δ (before settlement), same split as close
```

No position survives to settlement: the `[0,1] → {0,1}` jump never touches a ticket.

The knockout barrier in mark space, from `X = θm` in (1):

```
p_b = p₀^ask − (1 − θ)·m / q  =  p₀^ask · ( 1 − (1 − θ)/λ )        (2)
```

— the classical turbo-warrant geometry (Eriksson 2006): a down-and-out claim whose
barrier distance shrinks as `1/λ`. Our ticket is precisely a **capped down-and-out call
on `p` with strike `B/q`, barrier `p_b`, rebate `(X_{τ_b} − π·m)⁺`** — except it is
*cash-settled against a pre-funded escrow*, which is what makes the solvency results
unconditional.

---

## 3. Solvency theorems

**Proposition 1 (bounded trader loss).** For every path and every exit time,
trader PnL `≥ −m − φ_o·m_gross`.
*Proof.* The trader's only outlay is margin + open fee; (1) gives `X ≥ 0`. ∎

**Proposition 2 (no bad debt; pool solvency).** The pool's outflow on a ticket is
`X_τ ≤ m + R = E`, and `E` is held in the position's own balance from inception, funded
`m` by the trader and `R` by the pool. Hence the pool's realized PnL per ticket is

```
Π = m − X_τ + fees  ∈  [ −R + fees ,  m + fees ]                   (3)
```

bounded below by a quantity the pool **already paid into escrow at open**. No state of
the world creates a claim on pool liquidity beyond `R`; aggregate insolvency is
impossible whenever `Σ R_i ≤` initial liquidity, which `open` enforces by construction
(the reserve is physically split from the pool balance). There is no "debt" object
anywhere in the system. ∎

**Proposition 3 (exact house edge, via optional stopping).** Under Assumption M, for
*any* exit rule `τ` (close, knockout, or force-close — all bounded stopping times), if
clamps do not bind at `τ` (they cannot under continuous monitoring, since knockout at
`θm > 0` precedes the floor),

```
E[ trader PnL ] = − q·( s₀ + E[s_τ] )  −  φ_o·m_gross  −  E[ φ_p·(X_τ−m)⁺ ]  −  π·m·Q(liq)   (4)
```

*Proof.* `E[X_τ] − m = q·E[p_τ^bid] − B = q·( E[p_τ] − E[s_τ] ) − q·(p₀ + s₀)`
`= −q·(s₀ + E[s_τ])` by Doob's optional stopping theorem on the bounded martingale
`p`. Fees and the penalty subtract directly. ∎

Leverage `λ` does **not** appear in (4): leverage redistributes outcomes (more knockouts,
fatter right tail) but cannot change expected cost. The house edge is exactly
*spread + fees + expected penalty* — auditable, and confirmed by simulation to within
Monte-Carlo error (§7). Under discrete monitoring a gap can pierce the floor; the floor
then *transfers the overshoot to the pool as profit* (the pool keeps `m` while the mark
says worse), which only increases (3) — never the reverse.

**Proposition 4 (boundedness is necessary and sufficient for full reservation).** A
fully-reserved design requires `R = q·(p̄ − p₀) < ∞` with `p̄ = ess-sup` of the mark.
For prediction shares `p̄ ≤ 1`, so `R ≤ q` — finite and typically *smaller than the
position's notional*. For a linear perpetual on an unbounded underlying,
`ess-sup = ∞` and no finite reserve exists: every perp venue must lend or under-reserve
and therefore carries bad-debt risk (their insurance funds exist *because* of this).
The bounded payoff of prediction markets is precisely what makes a zero-bad-debt
leverage venue possible. ∎

**Proposition 5 (the lending alternative cannot achieve this).** A CDP that borrows
`D = B − m` to mint real shares realizes bad debt `(D − q·p_τ^bid)⁺ > 0` on any path
where the mark gaps below `D/q ≈ p₀(1 − 1/λ)` between two monitoring times — a
positive-probability event for any discrete monitoring `Δt > 0` and any `λ > 1`,
with probability increasing in `λ`, mark volatility (§6), and `Δt`. Simulation
quantifies it (§7). ∎

---

## 4. Why the mark is the right underlying (and what's new)

The mark `p_t` is a *probability*: a martingale **with state-dependent volatility that
explodes near expiry at the money and dies at the boundaries** — the digital's gamma.
Writing the instantaneous mark dynamics via Itô on `p = N(d2)`:

```
dp_t = ν(p_t, τ) dW_t ,    ν(p, τ) ≈ φ( N⁻¹(p) ) · ( σ_real / ( σ_imp √τ ) )       (5)
```

(`φ` the normal pdf; exact under Black–Scholes with flat vol, first-order under SVI).
Three regimes follow directly:

| regime | `p₀` | `ν` | consequence |
|---|---|---|---|
| deep ITM | → 1 | → 0 | calm mark → **high λ is safe** |
| ATM | ≈ ½ | maximal, `∝ 1/√τ` | violent near expiry → throttle λ |
| deep OTM | → 0 | → 0 absolutely, huge *relative* to `p` | already convex; leverage adds little |

This is the quantitative basis for the product's three strategy presets (ITM carry /
ATM momentum / OTM lotto).

**Relation to the literature.** The ticket is a turbo warrant (Eriksson 2006; Wong–Chan
2008 under stochastic vol) on a *bounded* underlying — which removes the rebate-pricing
difficulty that dominates that literature, because the escrow construction replaces
counterparty pricing with pre-funding. It is the *expiring* cousin of an everlasting
option (White–Tassy, Paradigm 2021): an auto-rolling variant funded at
`(mark − payoff)` per roll is future work and inherits their no-arbitrage pricing.

---

## 5. Pool (LP) economics

Pool value `P = liquidity + Σ_open R_i` (reserves at book value). LP shares price at
`P / total_shares` (standard vault accounting). Per-ticket pool PnL is (3); revenue =
open fees + performance fees + penalties + floor-overshoot capture; cost = reserve
lockup (capital, not risk) and the left tail `−R` realized only when a trader rides the
mark to the cap — a *priced*, *prepaid* outcome, not a default.

Capital efficiency is the deliberate price of solvency: utilization
`u = Σ R_i / P ≤ u_max` bounds how many tickets the pool writes. The cap mark `p̄`
trades efficiency against trader upside (`p̄ = 1` full reserve; `p̄ < 1` sportsbook-style
"max win" with `R` smaller by `q(1 − p̄)`).

---

## 6. Risk-scaled maximum leverage

Knockout safety for the *trader* (the pool needs no protection — Prop. 2) requires the
barrier distance to exceed the mark's plausible move over one monitoring interval
`Δt`. From (2) and (5), requiring a `z`-sigma buffer:

```
(1 − θ)/λ · p₀ ≥ z · ν(p₀, τ) · √Δt
⇒  λ_max(p₀, τ, Δt) = (1 − θ) · p₀ / ( z · ν(p₀, τ) · √Δt )       (6)
```

With `θ = 0.45`, `z = 3`, keeper latency `Δt = 5 s`, BTC `σ_real = σ_imp`: deep-ITM
hourly markets support `λ` in the tens; ATM 15-minute markets in the low single digits.
The keeper enforces (6) at open; the contract enforces only the absolute backstop
(λ ≤ 50) and full reservation. Note the failure mode of violating (6) is *premature
knockout of the trader*, not pool loss — a UX bound, not a solvency bound.
First-passage refinement: with `Z_t = N⁻¹(p_t)` approximately a time-changed Brownian
motion, `Q(τ_b < T) ≈ 2·N( −|z₀ − z_b| / √{u_T} )` by the reflection principle
(Rubinstein–Reiner 1991 give the standard barrier toolkit); the simulator reports the
empirical version.

### 6.1 Production leverage policy (v1)

Distinguish **solvency leverage** (unbounded here — Prop. 2 holds at any `λ`) from
**usable leverage** (eq. 6 — beyond it the trader is knocked out almost surely; the
simulator shows ~97% knockout rates for ATM 1h tickets at `λ ≥ 10`). The keeper
therefore enforces (6) as a *trader-protection* cap — soft (warn/confirm) is
acceptable since no party's solvency depends on it. v1 defaults, assuming a ≤5s
keeper on hourly markets:

```
deep ITM  (p₀ ≥ 0.8)        λ ≤ 10–25
ATM       (0.3 < p₀ < 0.8)  λ ≤ 2–6
deep OTM  (p₀ ≤ 0.3)        λ ≤ 1–3
hard contract backstop       λ ≤ 50  (reachable only on calm, high-p₀ markets)
```

Caps scale with keeper latency per (6): roughly ×2 at 1s, ÷2.5 at 30s.

### 6.2 Dynamic leverage ceiling and critical expiry time τ_c

Formula (6) is a snapshot: it uses opening parameters `(p₀, τ₀)`. Over the
position's life, `(p_t, τ_t)` evolve and the ceiling changes. The **live ceiling**
evaluated at current state is:

```
λ_max(p_t, τ_t, Δt) = (1−θ) · p_t / ( z · ν(p_t, τ_t) · √Δt )              (7)
```

The keeper should recompute (7) at every monitoring step and force-close any
position with current leverage `λ > λ_max(p_t, τ_t, Δt)`.

**ATM decay.** For ATM marks `p ≈ ½`, eq. (5) gives `ν ∝ 1/√τ`, so
`λ_max ∝ √τ → 0` as `τ → 0`. For any target leverage `λ`, there is a
**critical remaining tenor** `τ_c` below which the ceiling drops beneath `λ`:

```
λ_max(p, τ_c, Δt) = λ
⇒  τ_c(λ, p, θ, Δt) = φ(N⁻¹(p))² · σ² · (z · λ)² · Δt / ( (1−θ) · p )²    (8)
```

(Derived by substituting ν from (5) into `λ_max = λ` and solving for `τ`; `σ` here
is the realised-to-implied vol ratio, `≈ 1` on the production surface.)

**Proposition 6 (leverage decay at expiry).** For ATM marks and any `λ > 1`, the
function `λ_max(½, τ, Δt)` is strictly increasing in `τ`. Hence there exists a
finite `τ_c > 0` — given by (8) — below which the current leverage exceeds the
safe ceiling. The keeper must force-close at `τ_c`, not at `τ = 0`.

*Proof.* `∂ν/∂τ = −½ φ(N⁻¹(p)) σ τ^{−3/2} < 0`, so `λ_max = c / ν` is
strictly increasing in `τ`. Since `λ_max(½, 0⁺, Δt) = 0 < λ`, continuity
guarantees a unique crossing `τ_c ∈ (0, ∞)`. ∎

**Numerical examples** (θ = 0.45, z = 3, Δt = 5 s, ATM p = 0.5; production SVI params
`a=0.04, b=0.10, σ=0.10`; fair-vol assumption σ_real/σ_imp = 1):

| Leverage λ | τ_c | Consequence on a 1-hour market |
|---|---|---|
| 3× | ≈ 14 min | force-close at t = 46 min |
| 5× | ≈ 40 min | force-close at t = 20 min |
| 10× | ≈ 2.6 h | cannot open on a 1-hour market |

These are directly confirmed by the Monte Carlo (`simulations/leverage_mc.ts`, Target 6).
The production policy (§6.1) "ATM λ ≤ 2–6" is consistent with these windows:
λ = 4 gives τ_c ≈ 24 min, leaving 36 min of the 1-hour market usable. The contract's
hard-coded 2-minute `FORCE_S` corresponds to λ ≈ 1.5 ATM — far below any
leveraged position. **`FORCE_S` is a UX hedge, not a solvency hedge; the
principled force-close is τ_c per (8).**

### 6.3 Resolution risk and the floor close-window

For deep ITM/OTM marks, `ν → 0` and eq. (8) gives `τ_c → 0`: the formula
suggests arbitrarily high leverage is safe near expiry. This conclusion fails for
binary prediction markets, because the mark can **gap to {0,1} in a single
information event** with no intermediate observable price (arxiv:2605.10400;
Proposition 3.1 therein: binary markets admit zero-measure liquidation windows
for arbitrarily small `Δt`). The SVI diffusion model has no analogue: it is a
continuous-path model calibrated to the continuous information flow assumption.

The correction: add a **resolution jump term** to the effective one-step variance.
Modelling settlement arrival as a Poisson process with rate `1/τ` (hazard = `Δt/τ`
per epoch), the mark either (a) diffuses with probability `1 − Δt/τ` or
(b) jumps to 1 with probability `p · Δt/τ` and to 0 with probability
`(1−p) · Δt/τ`. The combined one-step variance is:

```
σ_eff²(p, τ, Δt) = ν²(p, τ) · Δt  +  p(1−p) · Δt / τ                       (9)
                   ╰──── diffusion ────╯  ╰──── resolution jump ────╯
```

Substituting `σ_eff` for `ν · √Δt` in (6):

```
λ_max^jump(p, τ, Δt) = (1−θ) · p / ( z · σ_eff(p, τ, Δt) )                (10)
```

**Corollary (universal decay).** For every `p ∈ (0,1)`, `σ_eff → ∞` as
`τ → 0⁺` (both terms diverge at rate `1/τ`). Hence `λ_max^jump → 0` for all
moneyness levels, not just ATM. Every leveraged position must be closed before
settlement, regardless of ITM/OTM depth.

**Complete force-close rule.** Let `τ_c^jump` solve `λ_max^jump(p_t, τ_c^jump, Δt) = λ`.
The keeper closes any position satisfying either condition:

```
force-close if:  τ_t  <  max( τ_c(λ, p_t, θ, Δt) ,  τ_c^jump(λ, p_t, θ, Δt) )
```

For ATM marks the diffusion term dominates; for deep ITM/OTM the jump term
dominates. The v1 `FORCE_S = 120 s` floor is a coarse lower bound; the correct
implementation evaluates this per-position at each keeper tick.

---

## 7. Epoch fee model

The current model charges a flat `maint_bps` as a static daily maintenance fee.
This understates the pool's hedging cost as `τ → 0` (gamma explodes near expiry)
and overstates it for deep ITM/OTM positions (low gamma). A principled
**epoch fee** scales with the pool's realised gamma exposure over each monitoring
interval.

**Derivation.** The pool's net position on an open ticket is short a capped
down-and-out call on `p`. Its Black–Scholes theta — the cost of gamma over epoch
`Δt` — is approximately:

```
f_epoch ≈  ½ · q² · Γ_p(p_t, τ_t) · σ_eff²(p_t, τ_t, Δt)                  (11)
```

where `Γ_p = ∂²V/∂p²` is the option's gamma in mark space. To leading order for
an uncapped digital, `q · Γ_p ≈ φ'(N⁻¹(p_t)) / ν²`. Substituting and cancelling
`ν²`:

```
f_epoch(λ, p, τ, Δt) ≈  κ · λ · p(1−p) · m · Δt / τ                         (12)
```

where `κ` is a calibration constant (absorbs SVI-surface corrections and the
capped-barrier geometry). Equation (12) scales as `1/τ` — fees grow as expiry
approaches, providing an independent market-derived force-close: **a position
that cannot pay its next epoch fee is closed**, regardless of `τ_c`.

**Position close condition** (epoch-fee driven):

```
force-close if:  X_t  <  f_epoch(λ, p_t, τ_t, Δt)                           (13)
```

**Relation to static `maint_bps`.** The existing `maint_bps` corresponds to eq. (12)
with constant `p(1−p)/τ` — accurate at a single (ATM, mid-life) point. The epoch
model correctly adjusts:

| Condition | `maint_bps` | epoch fee (12) |
|---|---|---|
| ATM near expiry | too low | high (correct) |
| Deep ITM mid-life | too high | low (correct) |
| ATM mid-life | calibration point | equal by construction |

**Integration with Proposition 6.** Both (8) and (13) produce force-closes as
`τ → 0`: (8) fires on structural capacity (the pool writes too much gamma per
dollar of margin at high `λ`); (13) fires on realised equity (the trader can no
longer afford the increasing hedging cost). For a position that opened exactly at
`λ_max` and has not been knocked out, both conditions fire at approximately the
same `τ_c` — they are dual views of the same constraint.

**Calibration target.** Over the life of a ticket, integrate (12):

```
∫₀^{T} f_epoch(λ, p_t, τ_t, Δt) dt  ≈  total realised pool revenue per ticket
```

Calibrate `κ` so this identity holds in simulation (§8, target 7). Monte Carlo
results (3,000 paths, 1h market, Δt = 5s) show:

| Moneyness | λ | κ_implied |
|---|---|---|
| ATM (p₀ = 0.50) | 3 | ≈ 1.0 — formula works |
| ATM (p₀ = 0.50) | 5 | ≈ 1.6 — within calibration range |
| Deep ITM (p₀ = 0.90) | 5 | ≈ 0.2 — formula overstates (ITM marks barely move) |
| Deep OTM (p₀ = 0.15) | 3 | ≈ 7.0 — formula understates (OTM dies fast at barrier) |

Formula (12) is well-calibrated for ATM positions. ITM/OTM positions need a
moneyness correction: the `p(1−p)` term overstates ITM gamma (where `ν → 0` but
`p(1−p)` is not negligible) and understates the rapid barrier capture for OTM
positions (where knockout transfers a large fraction of margin to the pool immediately,
not as a continuous fee). A production epoch fee model should use a moneyness-adjusted
`κ(p₀)` fitted to simulation results.

---

## 8. Simulation protocol (`simulations/leverage_mc.ts`)

Monte Carlo on GBM spot paths with the production SVI parameters
(`a=0.04, b=0.10, ρ=−0.30, m=0, σ=0.10`), linear time-decay of total variance,
optional Poisson jumps (gap stress), discrete keeper monitoring. On **identical paths**
run both designs:

- **Reserved ticket** (this model): verify `bad debt ≡ 0` on every path; record trader
  PnL, pool PnL, knockout rate, knockout time.
- **CDP** (lending design): record `(D − V)⁺` bad debt distribution.

Sweeps: `λ ∈ {2,3,5,10,20,50}` × moneyness `p₀ ∈ {0.90, 0.50, 0.15}` × keeper
`Δt ∈ {1s, 5s, 30s}` × jumps on/off. Validation targets:

1. Reserved bad debt ≡ 0 (Prop. 2) — exact, every path, every sweep.
2. CDP bad debt > 0, increasing in `λ`, in ATM-ness, in `Δt`, in jumps (Prop. 5).
3. Mean trader PnL ≈ −(spread + fees + π·m·liq-rate), flat in `λ` (Prop. 3).
4. Static Lmax consistent with (6): empirical knockout rate at `λ = λ_max` ≈ 2·N(−1) ≈ 32%.
5. **Dynamic Lmax curve (Prop. 6):** plot empirical `λ_max(τ)` from knockout-rate isocontours;
   compare against eq. (8). Confirm `λ_max ∝ √τ` for ATM marks and that positions opened at
   `λ_max(τ_open)` breach the ceiling at `τ = τ_c` derived from (8).
6. **Critical time τ_c validation:** open ATM tickets at `λ ∈ {3, 5}` on a 4-hour
   simulated market; record the fraction still live at each τ. Confirm ~50% knockout by
   τ_c and < 5% survival past τ_c / 2 (i.e., half the predicted window already fatal).
7. **Epoch fee calibration:** for positions closed by force-close (not knockout), accumulate
   `Σ f_epoch(λ, p_t, τ_t, Δt)` over the ticket life. Calibrate `κ` so that accumulated
   epoch fees match total pool revenue on those paths (eq. (12)); `κ` should be in `[0.5, 2]`
   for a well-fitted surface.
8. **Resolution gap stress:** run a jump overlay where the mark can teleport to `{0, 1}` with
   hazard `Δt/τ` (eq. 9 model). Confirm that the complete force-close rule (max of diffusion
   and jump τ_c) reduces residual bad debt to near-zero on deep ITM/OTM tickets; compare
   against the static 2-minute floor alone.

---

## References

- F. Black, M. Scholes (1973). *The Pricing of Options and Corporate Liabilities.* JPE 81(3).
- D. Breeden, R. Litzenberger (1978). *Prices of State-Contingent Claims Implicit in Option Prices.* J. Business 51(4).
- J. Gatheral, A. Jacquier (2014). *Arbitrage-free SVI volatility surfaces.* Quantitative Finance 14(1).
- A. Eriksson (2006). *Pricing turbo warrants.* (Closed form under GBM; knockout-barrier structure.) — see also the survey of extensions under stochastic vol (Wong–Chan 2008), CEV (Domingues), and jump diffusion (Wong–Lau): https://en.wikipedia.org/wiki/Turbo_warrant, https://www.researchgate.net/publication/228953960_Pricing_turbo_warrants
- M. Rubinstein, E. Reiner (1991). *Breaking Down the Barriers.* Risk 4(8). (Barrier/first-passage formulas.)
- D. White, M. Tassy, S. Bankman-Fried, D. Robinson (2021). *Everlasting Options.* Paradigm Research. https://www.paradigm.xyz/2021/05/everlasting-options
- D. White, D. Robinson, Z. Koticha et al. (2021). *Power Perpetuals.* Paradigm Research. https://www.paradigm.xyz/2021/08/power-perpetuals
- Ultramarkets (2025). *Leveraged prediction shares: health and liquidation framework.* (Health = equity/margin; the lending baseline of Prop. 5.)
- A. Chitra, J. Evans, G. Pai (2025). *Liquidation Mechanisms in Binary Prediction Markets.* arXiv:2605.10400. (Prop. 3.1: binary markets admit zero-measure liquidation windows; source of the resolution-jump model in §6.3.)
- Messari (2024). *Epoch fee model for leveraged prediction market positions.* (Basis for the γ-scaled maintenance cost in §7.)
- DeepBook Predict (2026). `predict::oracle::compute_nd2`, SVI feed — the production mark of §1.
