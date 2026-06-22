// PTB builder for combo / multi-leg positions.
//
// Two phases mirror the single-leg vault flow:
//   Phase 1 (user signs): buildRequestPTB  — request_mint_binary / request_mint_range per leg
//   Phase 2 (keeper):     buildExecutePTB  — execute_mint per intent_id
//
// Both return the transaction ready to sign+execute. The caller is responsible
// for setting gas budget and signing.
//
// Cross-asset / cross-expiry combos work naturally: each leg references its own
// oracle_id + expiry. The PTB is atomic — all legs are requested in one tx.

import { Transaction, type TransactionObjectInput } from '@mysten/sui/transactions'
import type { SuiClient } from '@mysten/sui/client'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import type { BinaryLegSpec, LegSpec, RangeLegSpec } from './combo-types.js'
import { CLOCK } from './config.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RequestResult {
  tx:       Transaction
  // intent_id_results[i] is the transaction result holding the u64 intent_id
  // for legs[i]. Resolve after execution by reading events.
  intentResultIndices: number[]
}

export interface ExecuteOptions {
  cerida:     string   // cerida package id
  vault:      string   // CeridaVault<Quote> object id
  manager:    string   // PredictManager object id
  predict:    string   // Predict shared object id
  oracle:     string   // OracleSVI id (for this batch; all legs must share it
                       // OR caller batches per oracle — see buildExecuteBatch)
  intent_ids: bigint[]
  quote_type: string   // e.g. '0xabc::dusdc::DUSDC'
}

// ── Phase 1: user request ─────────────────────────────────────────────────────

/**
 * Build a PTB that submits one mint intent per leg, splitting the coin escrow
 * atomically. The caller must provide a single Coin<Quote> covering
 * sum(legs[i].escrow). Returns the Transaction and per-leg result indices so
 * the caller can map events back to legs after execution.
 *
 * @param cerida    cerida package id
 * @param vault     CeridaVault<Quote> object id
 * @param quote_type  move type string e.g. '0xabc::dusdc::DUSDC'
 * @param legs      ordered array of LegSpec
 * @param coinInput the gas/payment coin object (or tx.gas for gas-coin usage)
 */
export function buildRequestPTB(
  cerida:     string,
  vault:      string,
  quote_type: string,
  legs:       LegSpec[],
  coinInput:  TransactionObjectInput,
): RequestResult {
  const tx = new Transaction()
  const intentResultIndices: number[] = []
  let resultIdx = 0

  const coinObj = tx.object(coinInput)

  for (const leg of legs) {
    // Split the escrow amount for this leg from the payment coin
    const [escrowSplit] = tx.splitCoins(coinObj, [tx.pure.u64(leg.escrow)])

    if (leg.kind === 'binary') {
      const b = leg as BinaryLegSpec
      tx.moveCall({
        target:    `${cerida}::vault::request_mint_binary`,
        typeArguments: [quote_type],
        arguments: [
          tx.object(vault),
          tx.pure.id(b.oracle_id),
          tx.pure.u64(b.expiry),
          tx.pure.u64(b.strike),
          tx.pure.bool(b.is_up),
          tx.pure.u64(b.qty),
          tx.pure.u64(b.max_cost),
          escrowSplit,
        ],
      })
    } else {
      const r = leg as RangeLegSpec
      tx.moveCall({
        target:    `${cerida}::vault::request_mint_range`,
        typeArguments: [quote_type],
        arguments: [
          tx.object(vault),
          tx.pure.id(r.oracle_id),
          tx.pure.u64(r.expiry),
          tx.pure.u64(r.lower_strike),
          tx.pure.u64(r.higher_strike),
          tx.pure.u64(r.qty),
          tx.pure.u64(r.max_cost),
          escrowSplit,
        ],
      })
    }

    intentResultIndices.push(resultIdx)
    resultIdx++
  }

  tx.setGasBudget(500_000_000n)
  return { tx, intentResultIndices }
}

// ── Phase 2: keeper execute ───────────────────────────────────────────────────

/**
 * Build a PTB that executes a batch of pending mint intents. All intents in a
 * single call must share the same oracle (Predict's execute_mint takes a single
 * OracleSVI). Call buildExecuteBatch for combos spanning multiple oracles.
 */
export function buildExecutePTB(opts: ExecuteOptions): Transaction {
  const { cerida, vault, manager, predict, oracle, intent_ids, quote_type } = opts
  const tx = new Transaction()

  for (const id of intent_ids) {
    tx.moveCall({
      target:    `${cerida}::vault::execute_mint`,
      typeArguments: [quote_type],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(id),
        tx.object(CLOCK),
      ],
    })
  }

  tx.setGasBudget(BigInt(intent_ids.length) * 300_000_000n)
  return tx
}

/**
 * For combos spanning multiple oracles (cross-asset), group intents by
 * oracle_id and return one Transaction per oracle group. The keeper executes
 * them in expiry order.
 */
export function buildExecuteBatch(
  cerida:     string,
  vault:      string,
  manager:    string,
  predict:    string,
  quote_type: string,
  legs:       LegSpec[],
  intentIds:  bigint[],   // parallel to legs
): Transaction[] {
  // Group by oracle_id
  const byOracle = new Map<string, { oracle_id: string; ids: bigint[] }>()
  for (let i = 0; i < legs.length; i++) {
    const oracle_id = legs[i].oracle_id
    if (!byOracle.has(oracle_id)) byOracle.set(oracle_id, { oracle_id, ids: [] })
    byOracle.get(oracle_id)!.ids.push(intentIds[i])
  }

  return [...byOracle.values()].map(({ oracle_id, ids }) =>
    buildExecutePTB({ cerida, vault, manager, predict, oracle: oracle_id, intent_ids: ids, quote_type })
  )
}

// ── Phase 3: keeper redeem ────────────────────────────────────────────────────

/**
 * Request redemption of a settled leg's PositionToken. One call per leg;
 * group tokens that expired in the same oracle batch for gas efficiency.
 */
export function buildRedeemRequestPTB(
  cerida:    string,
  vault:     string,
  quote_type: string,
  tokens:    { token_id: string; qty: bigint }[],
): Transaction {
  const tx = new Transaction()
  for (const { token_id, qty } of tokens) {
    tx.moveCall({
      target:    `${cerida}::vault::request_redeem`,
      typeArguments: [quote_type],
      arguments: [
        tx.object(vault),
        tx.object(token_id),
        tx.pure.u64(qty),
      ],
    })
  }
  tx.setGasBudget(BigInt(tokens.length) * 200_000_000n)
  return tx
}

/**
 * Execute pending redeem tickets. All tickets in a batch must share the same
 * oracle (same underlying / expiry). Group by oracle before calling.
 */
export function buildRedeemExecutePTB(
  cerida:     string,
  vault:      string,
  manager:    string,
  predict:    string,
  oracle:     string,
  quote_type: string,
  redeem_ids: bigint[],
): Transaction {
  const tx = new Transaction()
  for (const id of redeem_ids) {
    tx.moveCall({
      target:    `${cerida}::vault::execute_redeem`,
      typeArguments: [quote_type],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(id),
        tx.object(CLOCK),
      ],
    })
  }
  tx.setGasBudget(BigInt(redeem_ids.length) * 300_000_000n)
  return tx
}

// ── Combo-native PTB builders ─────────────────────────────────────────────────
//
// These call the vault::request_combo / execute_combo_mint / settle_combo_leg /
// claim_combo entry points added in the combo build. They differ from the
// generic per-leg builders above: the entire leg list is submitted in a single
// atomic move call, and the keeper settles individual legs rather than redeeming
// PositionTokens it received.

/**
 * Build a PTB that calls vault::request_combo — the single user transaction for
 * a combo. All leg escrow is batched into one Coin<Quote> payment; the Move
 * contract splits it internally per leg.
 *
 * `payment` should be a coin object covering sum(legs[i].escrow).
 * Returns combo_id from the ComboCreated event after execution.
 */
export function buildRequestComboPTB(
  cerida:     string,
  vault:      string,
  quote_type: string,
  legs:       LegSpec[],
  mode:       number,     // 0 = PORTFOLIO, 1 = PARLAY
  kind:       number,     // 0-6 combo kind constant
  coinInput:  TransactionObjectInput,
): Transaction {
  const tx = new Transaction()
  const coin = tx.object(coinInput)

  // Build each ComboLegInput via the Move constructor functions
  const legResults = legs.map(leg => {
    if (leg.kind === 'binary') {
      const b = leg as BinaryLegSpec
      return tx.moveCall({
        target:        `${cerida}::vault::binary_leg_input`,
        typeArguments: [],
        arguments: [
          tx.pure.id(b.oracle_id),
          tx.pure.u64(b.expiry),
          tx.pure.u64(b.strike),
          tx.pure.bool(b.is_up),
          tx.pure.u64(b.qty),
          tx.pure.u64(b.max_cost),
          tx.pure.u64(b.escrow),
        ],
      })
    } else {
      const r = leg as RangeLegSpec
      return tx.moveCall({
        target:        `${cerida}::vault::range_leg_input`,
        typeArguments: [],
        arguments: [
          tx.pure.id(r.oracle_id),
          tx.pure.u64(r.expiry),
          tx.pure.u64(r.lower_strike),
          tx.pure.u64(r.higher_strike),
          tx.pure.u64(r.qty),
          tx.pure.u64(r.max_cost),
          tx.pure.u64(r.escrow),
        ],
      })
    }
  })

  // Pack into a Move vector
  const legsVec = tx.makeMoveVec({
    type:     `${cerida}::vault::ComboLegInput`,
    elements: legResults,
  })

  tx.moveCall({
    target:        `${cerida}::vault::request_combo`,
    typeArguments: [quote_type],
    arguments: [
      tx.object(vault),
      legsVec,
      tx.pure.u8(mode),
      tx.pure.u8(kind),
      coin,
    ],
  })

  tx.setGasBudget(BigInt(legs.length) * 300_000_000n + 200_000_000n)
  return tx
}

/**
 * Keeper: execute the mint for one or more legs of a combo that share the same
 * oracle. Each leg in `leg_indices` must still be pending (no token yet).
 */
export function buildExecuteComboMintPTB(
  cerida:      string,
  vault:       string,
  manager:     string,
  predict:     string,
  oracle:      string,
  quote_type:  string,
  combo_id:    bigint,
  leg_indices: number[],
): Transaction {
  const tx = new Transaction()

  for (const leg_index of leg_indices) {
    tx.moveCall({
      target:        `${cerida}::vault::execute_combo_mint`,
      typeArguments: [quote_type],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(combo_id),
        tx.pure.u64(leg_index),
        tx.object(CLOCK),
      ],
    })
  }

  tx.setGasBudget(BigInt(leg_indices.length) * 400_000_000n)
  return tx
}

/**
 * Keeper: settle one or more combo legs that share an oracle. Redeems the
 * stored PositionToken and records the result in the combo entry.
 */
export function buildSettleComboLegPTB(
  cerida:      string,
  vault:       string,
  manager:     string,
  predict:     string,
  oracle:      string,
  quote_type:  string,
  combo_id:    bigint,
  leg_indices: number[],
): Transaction {
  const tx = new Transaction()

  for (const leg_index of leg_indices) {
    tx.moveCall({
      target:        `${cerida}::vault::settle_combo_leg`,
      typeArguments: [quote_type],
      arguments: [
        tx.object(vault),
        tx.object(manager),
        tx.object(predict),
        tx.object(oracle),
        tx.pure.u64(combo_id),
        tx.pure.u64(leg_index),
        tx.object(CLOCK),
      ],
    })
  }

  tx.setGasBudget(BigInt(leg_indices.length) * 400_000_000n)
  return tx
}

/**
 * User: claim the accumulated payout from a fully settled combo.
 */
export function buildClaimComboPTB(
  cerida:     string,
  vault:      string,
  quote_type: string,
  combo_id:   bigint,
): Transaction {
  const tx = new Transaction()

  tx.moveCall({
    target:        `${cerida}::vault::claim_combo`,
    typeArguments: [quote_type],
    arguments: [
      tx.object(vault),
      tx.pure.u64(combo_id),
    ],
  })

  tx.setGasBudget(200_000_000n)
  return tx
}

// ── Combo event parsers ───────────────────────────────────────────────────────

/** Extract combo_id from a ComboCreated event emitted by request_combo. */
export function parseComboId(result: Awaited<ReturnType<SuiClient['signAndExecuteTransaction']>>): bigint | null {
  const e = (result.events ?? []).find((e: any) => e.type.endsWith('::combo::ComboCreated'))
  return e ? BigInt((e.parsedJson as any).combo_id) : null
}

/** Parse all ComboLegSettled events from a settle_combo_leg PTB. */
export function parseComboLegSettlements(
  result: Awaited<ReturnType<SuiClient['signAndExecuteTransaction']>>,
): { combo_id: bigint; leg_index: number; won: boolean; payout: bigint }[] {
  return (result.events ?? [])
    .filter((e: any) => e.type.endsWith('::combo::ComboLegSettled'))
    .map((e: any) => ({
      combo_id:  BigInt(e.parsedJson.combo_id),
      leg_index: Number(e.parsedJson.leg_index),
      won:       Boolean(e.parsedJson.won),
      payout:    BigInt(e.parsedJson.payout),
    }))
}

// ── Event parsing helpers ─────────────────────────────────────────────────────

type TxResult = Awaited<ReturnType<SuiClient['signAndExecuteTransaction']>>

/** Extract the ordered list of intent_ids emitted by a request PTB. */
export function parseIntentIds(result: TxResult): bigint[] {
  return (result.events ?? [])
    .filter((e: any) => e.type.endsWith('::vault::MintRequested'))
    .map((e: any) => BigInt(e.parsedJson?.intent_id ?? -1))
}

/** Extract intent_id → cost mapping from a batch execute PTB. */
export function parseExecutedCosts(result: TxResult): Map<bigint, bigint> {
  const m = new Map<bigint, bigint>()
  for (const e of result.events ?? []) {
    if (e.type.endsWith('::vault::MintExecuted')) {
      const p = e.parsedJson as any
      m.set(BigInt(p.intent_id), BigInt(p.cost))
    }
  }
  return m
}

/** Extract redeem_id → payout mapping from a batch execute_redeem PTB. */
export function parseRedeemPayouts(result: TxResult): Map<bigint, bigint> {
  const m = new Map<bigint, bigint>()
  for (const e of result.events ?? []) {
    if (e.type.endsWith('::vault::RedeemExecuted')) {
      const p = e.parsedJson as any
      m.set(BigInt(p.redeem_id), BigInt(p.payout))
    }
  }
  return m
}
