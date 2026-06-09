// Shared config + helpers for the local Predict/Cerida simulation.
//
// The localnet runs in Docker (docker-compose.yml). These scripts run on the
// HOST against it, using the funded genesis keypair the container dumps to
// ../deployments/.sui-keystore.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { requestSuiFromFaucetV1, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Transaction } from "@mysten/sui/transactions";

const __dirname = dirname(fileURLToPath(import.meta.url));

// === Endpoints ===
export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:9000";
export const FAUCET_URL = process.env.FAUCET_URL ?? "http://127.0.0.1:9123";

// === Paths ===
export const SUI_BIN = process.env.SUI_BIN ?? "/Users/mac/Work/cerida/bin/sui";
export const REPO = resolve(__dirname, "../../.."); // /Users/mac/Work/cerida
const CLONES = "/Users/mac/clones/deepbookv3-testnet-4-16";

export const PKG = {
  predict: `${CLONES}/packages/predict`,
  deepbook: `${CLONES}/packages/deepbook`,
  token: `${CLONES}/packages/token`,
  dusdc: `${CLONES}/packages/dusdc`,
  cerida: `${REPO}/contracts`,
};

export const tomlOf = (pkgDir: string): string =>
  pkgDir.endsWith("/contracts") ? `${pkgDir}/move.toml` : `${pkgDir}/Move.toml`;

export const DEPLOYMENTS = resolve(__dirname, "../../deployments");
export const KEYSTORE = `${DEPLOYMENTS}/.sui-keystore`;
export const MANIFEST = `${DEPLOYMENTS}/local.json`;

// === Scaling (matches Predict) ===
export const PRICE_SCALE = 1_000_000_000n; // 9 decimals: strikes, prices, probs
export const DUSDC_SCALE = 1_000_000n; // 6 decimals: dUSDC + quantities
export const CLOCK = "0x6";

export function client(): SuiClient {
  return new SuiClient({ url: RPC_URL });
}

/// The localnet's genesis-funded keypair, dumped by the container to
/// ../deployments/.sui-keystore. We sign all SDK publishes/PTBs with this — it
/// already has gas, so no faucet is needed (faucet is best-effort top-up only).
/// Sui keystore = JSON array of base64 `flag || 32-byte secret`.
export function deployer(): Ed25519Keypair {
  if (!existsSync(KEYSTORE)) {
    throw new Error(
      `No keystore at ${KEYSTORE}. Is the localnet container up? (docker compose up -d)`,
    );
  }
  const keys: string[] = JSON.parse(readFileSync(KEYSTORE, "utf8"));
  const raw = Buffer.from(keys[0], "base64");
  if (raw[0] !== 0x00) {
    throw new Error(`expected an ed25519 genesis key (flag 0x00), got 0x${raw[0].toString(16)}`);
  }
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(raw.subarray(1, 33)));
}

export async function fund(address: string): Promise<void> {
  // localnet faucet may speak V2 or only V1 depending on the sui version.
  try {
    await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  } catch {
    await requestSuiFromFaucetV1({ host: FAUCET_URL, recipient: address });
  }
}

// === Deployment manifest (ids accumulated across deploy → setup) ===
export type Manifest = Record<string, string>;

export function loadManifest(): Manifest {
  return existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
}

export function saveManifest(m: Manifest): void {
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

export function need(m: Manifest, key: string): string {
  const v = m[key];
  if (!v) throw new Error(`manifest missing '${key}' — run the earlier step first`);
  return v;
}

export type Published = { packageId: string; modules: string[] };
export type Created = { objectId: string; objectType: string };
export type PublishResult = { packages: Published[]; created: Created[] };

/// Publish a Move package via the host `sui` CLI (1.73). With
/// `withUnpublishedDeps`, local deps (token, deepbook) publish in the same tx,
/// so multiple packages come back — pick the one you want with `findPackage`.
/// Ensure the host CLI has a `local` env pointing at the localnet RPC and
/// switch to it. Safe to call multiple times.
export function ensureLocalEnv(): void {
  // Register env (ignore error if it already exists)
  try {
    execFileSync(SUI_BIN, ["client", "new-env", "--alias", "local", "--rpc", RPC_URL], {
      encoding: "utf8",
    });
  } catch { /* already exists */ }
  execFileSync(SUI_BIN, ["client", "switch", "--env", "local"], { encoding: "utf8" });
}

/// The running localnet's chain-id (the active env must be `local`).
export function liveChainId(): string {
  return execFileSync(SUI_BIN, ["client", "chain-identifier"], { encoding: "utf8" }).trim();
}

/// `sui move build` fetches already-published dependencies from the ACTIVE
/// CLI env's RPC, so it must point at the localnet (that's where token/deepbook/
/// predict get published). With stripEnvironments() having removed the
/// [environments] pins, a classic `local`-env build resolves fine. Creates the
/// `local` env if missing and switches to it.
export function ensureBuildEnv(): void {
  try {
    execFileSync(SUI_BIN, ["client", "new-env", "--alias", "local", "--rpc", RPC_URL], {
      encoding: "utf8",
    });
  } catch {
    /* already exists */
  }
  execFileSync(SUI_BIN, ["client", "switch", "--env", "local"], { encoding: "utf8" });
}

// Move.tomls that pin a `local` environment chain-id. The 1.73 environments
// system rejects publishing unless one of these matches the live chain-id —
// and `--force-regenesis` produces a fresh (non-canonical) id each boot. So we
// rewrite the pin to whatever the localnet actually is. Idempotent.
const ENV_PINNED_TOMLS = [
  `${CLONES}/packages/token/Move.toml`,
  `${CLONES}/packages/deepbook/Move.toml`,
  `${CLONES}/packages/dusdc/Move.toml`,
  `${CLONES}/packages/predict/Move.toml`,
  `${REPO}/contracts/move.toml`,
];

/// Point every package's `local` environment pin at the live chain-id so
/// `sui client publish --env local` is accepted. Returns the chain-id.
export function alignEnvironments(): string {
  const id = liveChainId();
  for (const f of ENV_PINNED_TOMLS) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    const patched = src.replace(/local = "[0-9a-fA-F]+"/, `local = "${id}"`);
    if (patched !== src) writeFileSync(f, patched);
  }
  return id;
}

/// Point deepbook's `token` dependency at the local worktree instead of git, so
/// the whole token→deepbook→predict→cerida chain is local-path and can be
/// published in order with classic `published-at` pinning. Idempotent.
export function localizeDeepbookToken(): void {
  const toml = tomlOf(PKG.deepbook);
  if (!existsSync(toml)) return;
  const src = readFileSync(toml, "utf8");
  const patched = src.replace(/token = \{ git =[^}]*\}/m, 'token = { local = "../token" }');
  if (patched !== src) writeFileSync(toml, patched);
}

/// Remove the `[environments]` block and delete Move.lock from each package so
/// the build resolves classically (no env gate) and each package can be
/// published separately as a root. Idempotent. Mutates the worktree (a
/// dedicated integration clone — restore with `git checkout`).
export function stripEnvironments(): void {
  const dirs = [PKG.token, PKG.deepbook, PKG.dusdc, PKG.predict, PKG.cerida];
  for (const dir of dirs) {
    const toml = tomlOf(dir);
    if (existsSync(toml)) {
      const src = readFileSync(toml, "utf8");
      // Drop the [environments] block (runs to the next [section] or EOF).
      const stripped = src.replace(/\n*\[environments\][\s\S]*?(?=\n\[|\s*$)/, "\n");
      if (stripped !== src) writeFileSync(toml, stripped);
    }
    const lock = `${dir}/Move.lock`;
    if (existsSync(lock)) rmSync(lock);
  }
}

/// Publish via the SDK (`Transaction.publish` of dumped bytecode), NOT
/// `sui client publish`. The CLI publish enforces the 1.73 environments gate
/// (needs the `local` env resolved in Move.lock); the bytecode submit does not.
/// With `withUnpublishedDeps`, local deps (token, deepbook) are bundled in.
export async function publish(
  c: SuiClient,
  kp: Ed25519Keypair,
  pkgPath: string,
  opts: { withUnpublishedDeps?: boolean } = {},
): Promise<PublishResult> {
  // This Sui CLI globally requires `--build-env testnet|mainnet` to pick a
  // published-at table; it's independent of the active env (which only sets the
  // RPC for on-chain fetches). We delete Move.lock + write published-at into
  // Move.toml, so the table is empty and resolution falls back to our pins —
  // the active `local` env then fetches those deps from the localnet.
  const cmd = [
    "move",
    "build",
    "--build-env",
    "testnet",
    "--dump-bytecode-as-base64",
    "--path",
    pkgPath,
  ];
  if (opts.withUnpublishedDeps) cmd.push("--with-unpublished-dependencies");
  let buildOut: string;
  try {
    buildOut = execFileSync(SUI_BIN, cmd, { encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e: any) {
    // Surface the real message (stdout), not the deprecation-warning flood (stderr).
    throw new Error(`build failed for ${pkgPath}:\n${(e.stdout ?? e.message ?? "").trim()}`);
  }
  const { modules, dependencies } = JSON.parse(buildOut);

  const tx = new Transaction();
  const cap = tx.publish({ modules, dependencies });
  tx.transferObjects([cap], kp.toSuiAddress());
  tx.setGasBudget(5_000_000_000);

  const r = await c.signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    options: { showObjectChanges: true, showEffects: true },
  });
  if (r.effects?.status.status !== "success") {
    throw new Error(`publish ${pkgPath} failed: ${JSON.stringify(r.effects?.status)}`);
  }
  const changes = r.objectChanges ?? [];
  const packages: Published[] = changes
    .filter((x: any) => x.type === "published")
    .map((x: any) => ({ packageId: x.packageId, modules: x.modules ?? [] }));
  const created: Created[] = changes
    .filter((x: any) => x.type === "created")
    .map((x: any) => ({ objectId: x.objectId, objectType: x.objectType }));
  if (packages.length === 0) throw new Error(`publish of ${pkgPath} produced no package id`);
  return { packages, created };
}

/// Clear any `published-at` and reset the named address to 0x0 in a package's
/// Move.toml. Stale pins from a previous (now-dead) localnet make the build try
/// to fetch a non-existent dependency object — reset before every deploy run.
export function resetPin(tomlPath: string, namedAddr: string): void {
  if (!existsSync(tomlPath)) return;
  let src = readFileSync(tomlPath, "utf8");
  src = src.replace(/^published-at = .*\n/m, "");
  src = src.replace(new RegExp(`^(\\s*${namedAddr} = ).*$`, "m"), `$1"0x0"`);
  writeFileSync(tomlPath, src);
}

/// Rewrite a package's Published.toml `[published.testnet]` to point at the
/// locally-deployed instance. Modern Sui resolves published deps from
/// Published.toml (it takes precedence over Move.toml `published-at`), so any
/// dep that ships one — deepbook — must be repointed at the local address with
/// the localnet chain-id, or dependents fetch its canonical testnet address and
/// fail with "Object not found". Idempotent (overwrites the block each run).
export function pinPubfile(pkgDir: string, id: string, chainId: string): void {
  const pub = join(pkgDir, "Published.toml");
  const block =
    `[published.testnet]\n` +
    `chain-id = "${chainId}"\n` +
    `published-at = "${id}"\n` +
    `original-id = "${id}"\n` +
    `version = 1\n`;
  if (!existsSync(pub)) {
    writeFileSync(pub, block);
    return;
  }
  let src = readFileSync(pub, "utf8");
  if (/\[published\.testnet\]/.test(src)) {
    src = src.replace(/\[published\.testnet\][\s\S]*?(?=\n\[|\s*$)/, block.trimEnd());
  } else {
    src = src.trimEnd() + "\n\n" + block;
  }
  writeFileSync(pub, src);
}

/// Pin a dependency's on-chain address into its Move.toml so a dependent
/// package resolves to the deployed instance (classic address management, used
/// for the cerida → predict link since the SDK publish doesn't write Move.lock).
export function pinPublished(tomlPath: string, namedAddr: string, id: string): void {
  if (!existsSync(tomlPath)) return;
  let src = readFileSync(tomlPath, "utf8");
  if (/^published-at = /m.test(src)) {
    src = src.replace(/^published-at = .*$/m, `published-at = "${id}"`);
  } else {
    src = src.replace(/^\[package\][^\n]*$/m, (h: string) => `${h}\npublished-at = "${id}"`);
  }
  const addrRe = new RegExp(`^(\\s*${namedAddr} = ).*$`, "m");
  if (addrRe.test(src)) src = src.replace(addrRe, `$1"${id}"`);
  writeFileSync(tomlPath, src);
}

/// The published package that contains a given module (e.g. 'registry' = predict).
export function findPackage(packages: Published[], moduleName: string): string {
  const hit = packages.find((p) => p.modules.includes(moduleName));
  if (!hit) throw new Error(`no published package with module '${moduleName}'`);
  return hit.packageId;
}

/// For a standalone publish (deps already published), exactly one package is
/// produced — return it.
export function onlyPackage(packages: Published[]): string {
  if (packages.length !== 1) {
    throw new Error(`expected 1 published package, got ${packages.length}`);
  }
  return packages[0].packageId;
}

/// First created object whose type contains `needle`.
export function findCreated(created: Created[], needle: string): string {
  const hit = created.find((c) => c.objectType.includes(needle));
  if (!hit) throw new Error(`no created object of type ~'${needle}'`);
  return hit.objectId;
}
