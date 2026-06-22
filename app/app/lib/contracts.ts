// On-chain addresses for the Cerida protocol.
// Prefer VITE_ env vars so different environments (local/testnet) can override.

const e = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};

export const CERIDA_PKG =
  e.VITE_CERIDA_PKG ??
  '0xd2f87c454c3af8d17d7c5de7c80ea3690d6f4a85cbda6b9450d4c119bcd21725';

export const VAULT_ID =
  e.VITE_VAULT_ID ??
  '0xaaec7c2127409edf281e7d8dd3a3c49d0754ae983c0c042991d23727fd3c5615';

export const QUOTE_COIN_TYPE =
  e.VITE_QUOTE_COIN_TYPE ??
  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';

// Predict protocol shared objects (testnet)
export const PREDICT_OBJ =
  e.VITE_PREDICT_OBJ ??
  '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';

export const MANAGER_ID =
  e.VITE_MANAGER_ID ??
  '0xcf98c1b77646df048734420daa79bbf889973e6f4f9a9d90d2cd737770445bcb';

// Deployed WindowBook for the grid product
export const WINDOW_BOOK_ID =
  e.VITE_WINDOW_BOOK_ID ??
  '0xce81ddd95598b85a18d66431f2e47d24d10eb2ba2e13eefbbd43cf6e1f5d7df3';

// Sui clock object (shared singleton, same on every network).
export const CLOCK = '0x6';

// Scaling constants matching the Move contracts.
export const PRICE_SCALE = 1_000_000_000n; // 1e9 — strike prices
export const DUSDC_SCALE = 1_000_000n;     // 1e6 — dUSDC amounts

export const toChainPrice = (p: number) => BigInt(Math.round(p * 1e9));
export const toChainDusdc = (usd: number) => BigInt(Math.round(usd * 1e6));
