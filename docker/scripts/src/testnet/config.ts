import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === Testnet endpoints ===
export const TESTNET_RPC    = 'https://fullnode.testnet.sui.io';
export const PREDICT_SERVER = 'https://predict-server.testnet.mystenlabs.com';

// === Predict testnet deployment ===
export const PREDICT_PKG  = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
export const PREDICT_OBJ  = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
export const DUSDC_TYPE   = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';
export const CLOCK        = '0x6';

// === Scaling ===
export const PRICE_SCALE = 1_000_000_000n; // 9 decimals: strikes, prices
export const DUSDC_SCALE = 1_000_000n;     // 6 decimals: dUSDC amounts

// === Keypair ===
const MNEMONIC = process.env.MNEMONIC
  ?? 'apart train glory hire crunch clay inform dance orchard logic motor bonus';
export const kp   = Ed25519Keypair.deriveKeypair(MNEMONIC);
export const ADDR = kp.toSuiAddress();

// === Client ===
export const c = new SuiClient({ url: TESTNET_RPC });

// === Manifest ===
const MANIFEST_PATH = resolve(__dirname, '../../../deployments/testnet.json');

export type Manifest = {
  ceridaPkg?:    string;
  vaultId?:      string;
  managerId?:    string;  // PredictManager inside vault
  poolId?:       string;  // MarginPool<DUSDC>
  bookId?:       string;  // LeverageBook<DUSDC>
  // Window bet fields
  windowBookId?: string;  // WindowBook<DUSDC>
  windowEpochId?: number; // current epoch
  windowBetTicketId?: string; // BetTicket object for claiming
  windowEpochExpiry?: number; // expiry ms (for settle script)
  windowOracleId?: string;
  oracleId?:     string;
  expiry?:       number;
  strike?:       string;
  rangeLower?:   string;
  rangeUpper?:   string;
  quantity?:     string;
};

export function loadManifest(): Manifest {
  if (existsSync(MANIFEST_PATH)) {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  }
  return {};
}

export function saveManifest(m: Manifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}
