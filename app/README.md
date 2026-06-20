# Cerida App

React Router frontend for the Cerida trading interface.

## Development

```bash
bun run dev
```

## Enoki Sign In

The onboarding modal registers Enoki as a Sui wallet-standard provider when these variables are present:

```bash
VITE_ENOKI_API_KEY=
VITE_GOOGLE_CLIENT_ID=
VITE_ENOKI_NETWORK=testnet
```

`VITE_ENOKI_NETWORK` may be `testnet`, `devnet`, or `mainnet`. If it is omitted, the app defaults to `testnet`.
