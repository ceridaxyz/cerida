# @cerida/price-indexer

Indexes **binary yes/no prices (cents, 0–99)** for Cerida's markets and serves
latest + history for the charts.

## What it does

The Predict feed publishes BTC **spot** and the **SVI** surface — not yes/no
directly. A binary market is `(oracle, strike)`: YES wins if spot settles ≥
strike at expiry. So the yes/no price is the digital probability

```
YES = N(d2),  d2 = (ln(F/K) − w/2) / √w,  w = SVI total variance at K
NO  = 1 − YES
```

This service polls each live BTC market, derives `yes/no` in cents at a fixed
per-oracle strike, and writes the series to TimescaleDB.

## Endpoints

| Route | Description |
|---|---|
| `GET /health` | liveness |
| `GET /markets` | latest yes/no per market |
| `GET /yesno/latest?oracle=0x..` | most recent tick |
| `GET /yesno/history?oracle=0x..&limit=500` | ascending series (for candles) |

## Run

```bash
bun install
cp .env.example .env          # point DATABASE_URL at Postgres/Timescale
bun run dev                   # or: bun run start
```

## Docker (suite at ../../docker)

Build/run standalone:

```bash
docker build -t cerida-price-indexer .
docker run --env-file .env -p 8787:8787 cerida-price-indexer
```

To wire into the suite, add a `timescaledb` service and this image to
`docker/docker-compose.yml`, then point the frontend's chart at
`http://localhost:8787/yesno/history`.

## Config (env)

`DATABASE_URL`, `PREDICT_BASE` (swap for a Sui RPC source to index the chain
directly), `POLL_MS`, `STRIKE_ROUND` (the $ grid for the tracked strike), `PORT`.
