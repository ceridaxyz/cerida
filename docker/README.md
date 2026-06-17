# Cerida — Local Predict Environment

Publish **DeepBook Predict** + **Cerida** to a throwaway local Sui network and
simulate the full mint/redeem flow end-to-end — no testnet, no faucet forms, no
keys to manage. Docker runs only the chain; everything else runs on the host with
the `sui 1.73` binary + the TS SDK.

## Layout

```
docker/
  docker-compose.yml      Sui localnet only (RPC :9000, faucet :9123)
  deployments/            published ids land here (local.json) + node keystore
  scripts/                host-run TS: deploy → setup → flow
    src/config.ts         client, deployer key, faucet, publish, manifest helpers
    src/deploy.ts         publish predict (+deps), dusdc, cerida          [next]
    src/setup.ts          create_predict, mint dUSDC, create + feed oracle [next]
    src/flow.ts           cerida: create vault → mint → redeem + asserts  [next]
```

## Prerequisites

- Docker Desktop running (≥ 8 GB).
- `sui 1.73.1` at `/Users/mac/Work/cerida/bin/sui` (already installed).
- `bun` (runs the TS scripts directly — no build step).

## 1. Start the localnet

```bash
cd /Users/mac/Work/cerida/docker
docker compose up -d
docker compose logs -f          # wait until "Sui started"
```

This boots a `--force-regenesis` localnet. Localnet always genesises to chain-id
**`b485d3e3`**, which is exactly the `[environments] local = "b485d3e3"` entry
already pinned in Predict's `Move.toml` — so the package's published addresses
resolve automatically via `Move.lock` once we publish. (Cerida's `Move.toml`
needs the same `[environments] local = "b485d3e3"` line; `deploy.ts` checks this.)

## 2. Point the host CLI at it (one time)

```bash
SUI=/Users/mac/Work/cerida/bin/sui
$SUI client new-env --alias local --rpc http://127.0.0.1:9000
$SUI client switch --env local
$SUI client new-address ed25519 cerida-deployer   # or import one
$SUI client switch --address cerida-deployer
$SUI client faucet --url http://127.0.0.1:9123     # fund it
```

The deploy/setup/flow scripts publish via this CLI env (so the `local`
environment + `Move.lock` handle cross-package dependency addresses), and sign
PTBs with the same active key.

## 3. Install deps (from the repo root — bun workspaces)

```bash
cd /Users/mac/Work/cerida
bun install
```

## 4. Run the simulation (from the repo root)

The `cerida-local` workspace is wired into the root scripts:

```bash
bun local:deploy   # publish predict(+token+deepbook), dusdc, cerida → deployments/local.json
bun local:setup    # create_predict<DUSDC>, mint dUSDC, oracle cap+oracle, activate, push SVI+price
bun local:flow     # vault::create → request_mint → execute_mint → request_redeem → execute_redeem
# or: bun local:all
```

(Equivalent to `bun run --filter cerida-local <deploy|setup|flow|all>`, or
`cd docker/scripts && bun deploy` if you prefer running in the workspace dir.)

`flow` asserts: a `PositionToken` is issued to the user, the slippage surplus is
refunded, and the redeem payout is paid. Both **continuous-strike binary** and
**range** are exercised.

## What each step calls (the mapped Predict/Cerida API)

```
deploy   publish predict  → Registry, AdminCap, TreasuryCap<PLP>, predict pkg
         publish dusdc    → Currency<DUSDC>, TreasuryCap<DUSDC>, dusdc pkg
         publish cerida   → cerida pkg

setup    registry::create_predict<DUSDC>(registry, adminCap, currency, plpCap, clock) → Predict
         0x2::coin::mint<DUSDC>(dusdcCap, amount) → fund keeper + user
         registry::create_oracle_cap(adminCap) → OracleSVICap
         registry::create_oracle(registry, predict, adminCap, cap, "BTC", expiry,
                                 minStrike=1000e9, tick=100e9, ) → oracle_id
         oracle::activate(oracle, cap, clock)
         oracle::update_prices(oracle, cap, new_price_data(spot, fwd), clock)
         oracle::update_svi(oracle, cap, new_svi_params(a,b,rho,m,sigma), clock)
            (rho,m built via predict::i64::from_u64 / from_parts)

flow     cerida::vault::create<DUSDC>() → vault + manager (keeper = deployer)
         cerida::vault::request_mint_binary<DUSDC>(vault, oracleId, expiry, strike,
                                                   up, qty, coin) → intent_id
         cerida::vault::execute_mint<DUSDC>(vault, manager, predict, oracle, id, clock)
         cerida::vault::request_redeem<DUSDC>(vault, token) → redeem_id
         cerida::vault::execute_redeem<DUSDC>(vault, manager, predict, oracle, id, clock)
```

## Constraints baked in (from source recon)

- Predict mints **only in an enabled quote asset** (dUSDC here) — `assert_quote_asset`.
- Every manager op is **owner-gated**; Cerida's vault keeper owns the manager and
  mediates `execute_*`. Users escrow + hold transferable `PositionToken` claims.
- Oracle must be **quotable** (fresh SVI + spot, pre-expiry) or `mint` aborts —
  `setup` pushes those once; re-run it if the oracle drifts past expiry.
- Strike grid: `tick % 10_000 == 0`, `min_strike % tick == 0`. Strikes are 9-dec.

## Reset

```bash
docker compose down -v        # wipe chain; next `up` is a fresh genesis
rm -f deployments/local.json  # clear stale ids
```

## GCP tooling container

Use Google's official Cloud CLI Docker image when you want GCP-shaped tooling
without installing `gcloud` on the host.

```bash
cd /Users/mac/Work/cerida/docker
cp gcp.env.example .env.gcp
docker compose --env-file .env.gcp -f docker-compose.gcp.yml run --rm gcloud version
docker compose --env-file .env.gcp -f docker-compose.gcp.yml run --rm gcloud auth login --no-launch-browser
docker compose --env-file .env.gcp -f docker-compose.gcp.yml run --rm gcloud config set project "$GCP_PROJECT_ID"
```

When we are ready to test against a managed Cloud SQL instance, the same overlay
has the official Cloud SQL Auth Proxy image:

```bash
docker compose --env-file .env.gcp -f docker-compose.gcp.yml --profile gcp-db up cloud-sql-proxy
```

That exposes the remote database locally at `127.0.0.1:5433`.
