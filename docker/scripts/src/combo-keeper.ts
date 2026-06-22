// Combo settlement keeper.
//
// Responsibilities:
//   1. After each vault::execute_mint event — update combo_legs: status → active
//   2. At oracle expiry — for each active leg in that oracle, request_redeem + execute_redeem
//   3. After all legs of a combo settle — aggregate result, mark combo won/lost
//   4. Conditional auto-roll: if leg N won AND combo has a conditional leg N+1, submit it
//
// The keeper is stateless — all state lives in the combo DB (combo_store.ts).
// Poll interval: check every 30s for newly expired oracles.

import type { SuiClient } from '@mysten/sui/client'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  buildRedeemRequestPTB,
  buildRedeemExecutePTB,
  parseRedeemPayouts,
} from './combo-ptb.js'
import type { ComboStore } from './combo-store.js'
import type { LegState } from './combo-types.js'

export interface KeeperConfig {
  cerida:     string
  vault:      string
  manager:    string
  predict:    string
  quote_type: string
  poll_ms:    number   // default 30_000
}

export class ComboKeeper {
  constructor(
    private readonly c:      SuiClient,
    private readonly kp:     Ed25519Keypair,
    private readonly store:  ComboStore,
    private readonly cfg:    KeeperConfig,
  ) {}

  async run(): Promise<void> {
    console.log('[keeper] started, poll interval', this.cfg.poll_ms, 'ms')
    while (true) {
      try {
        await this.tick()
      } catch (e) {
        console.error('[keeper] tick error:', e)
      }
      await sleep(this.cfg.poll_ms ?? 30_000)
    }
  }

  async tick(): Promise<void> {
    const now = BigInt(Date.now())

    // Find all active legs whose oracle has expired
    const expired = await this.store.getExpiredActiveLegs(now)
    if (expired.length === 0) return

    console.log(`[keeper] ${expired.length} expired legs to settle`)

    // Group by oracle_id for batch processing
    const byOracle = groupBy(expired, l => l.spec.oracle_id)

    for (const [oracle_id, legs] of byOracle) {
      await this.settleLegBatch(oracle_id, legs)
    }

    // After settling all legs, aggregate combo results
    const affectedComboIds = [...new Set(expired.map(l => l.combo_id!))]
    for (const comboId of affectedComboIds) {
      await this.aggregateCombo(comboId)
    }
  }

  private async settleLegBatch(
    oracle_id: string,
    legs:      (LegState & { combo_id: string; leg_index: number; redeem_id?: bigint })[],
  ): Promise<void> {
    const { cerida, vault, manager, predict, quote_type } = this.cfg

    // Step 1: request_redeem for all tokens in this oracle batch
    const tokens = legs
      .filter(l => l.position_token != null)
      .map(l => ({ token_id: l.position_token!, qty: l.spec.qty }))

    if (tokens.length === 0) {
      console.warn(`[keeper] oracle ${oracle_id}: no position tokens found, skipping`)
      return
    }

    const reqTx = buildRedeemRequestPTB(cerida, vault, quote_type, tokens)
    const reqResult = await this.c.signAndExecuteTransaction({
      transaction: reqTx,
      signer:      this.kp,
      options:     { showEvents: true, showEffects: true },
    })
    if (reqResult.effects?.status.status !== 'success') {
      console.error('[keeper] request_redeem failed:', reqResult.effects?.status)
      return
    }

    // Parse redeem_ids from RedeemRequested events (ordered same as input)
    const redeemIds = (reqResult.events ?? [])
      .filter((e: any) => e.type.endsWith('::vault::RedeemRequested'))
      .map((e: any) => BigInt(e.parsedJson?.redeem_id))

    // Step 2: execute_redeem
    const execTx = buildRedeemExecutePTB(cerida, vault, manager, predict, oracle_id, quote_type, redeemIds)
    const execResult = await this.c.signAndExecuteTransaction({
      transaction: execTx,
      signer:      this.kp,
      options:     { showEvents: true, showEffects: true },
    })
    if (execResult.effects?.status.status !== 'success') {
      console.error('[keeper] execute_redeem failed:', execResult.effects?.status)
      return
    }

    const payouts = parseRedeemPayouts(execResult)

    // Step 3: update leg statuses in store
    for (let i = 0; i < legs.length; i++) {
      const leg   = legs[i]
      const payout = payouts.get(redeemIds[i]) ?? 0n
      const won   = payout > 0n
      await this.store.updateLegSettled(leg.combo_id!, leg.leg_index, {
        status: won ? 'won' : 'lost',
        payout,
      })
      console.log(`[keeper] leg ${leg.leg_index} of combo ${leg.combo_id}: ${won ? 'WON' : 'LOST'} payout=${payout}`)
    }
  }

  private async aggregateCombo(comboId: string): Promise<void> {
    const combo = await this.store.getCombo(comboId)
    if (!combo) return

    const legs = combo.legs
    const allSettled = legs.every(l => l.status === 'won' || l.status === 'lost' || l.status === 'voided')
    if (!allSettled) return

    const allWon   = legs.every(l => l.status === 'won' || l.status === 'voided')
    const anyLost  = legs.some(l => l.status === 'lost')
    const anyWon   = legs.some(l => l.status === 'won')

    const status = allWon ? 'won' : anyLost && anyWon ? 'partial' : 'lost'
    const total_payout = legs.reduce((sum, l) => sum + (l.payout ?? 0n), 0n)

    await this.store.updateComboStatus(comboId, status, total_payout)
    console.log(`[keeper] combo ${comboId} → ${status} (payout: ${total_payout})`)

    // Conditional auto-roll: look for pending conditional legs
    // (cross-expiry: a leg whose activation depends on a prior leg winning)
    if (combo.spec.kind === 'cross' && status !== 'lost') {
      await this.maybeAutoRoll(combo)
    }
  }

  // Conditional auto-roll: if a combo leg has `conditional_on_leg` set and
  // that leg won, submit the next leg's request_mint now.
  // This is for cross-expiry strategies: "if BTC > 65k at 2pm, enter 4pm YES(70k)"
  private async maybeAutoRoll(_combo: any): Promise<void> {
    // TODO: implement conditional leg activation once ComboStore supports
    // the conditional_on_leg field and the UI exposes it.
    // Pattern: for each leg with status='pending' and conditional_on_leg=N,
    // check if leg N is 'won', then call buildRequestPTB for just that leg.
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const item of arr) {
    const k = key(item)
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(item)
  }
  return m
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
