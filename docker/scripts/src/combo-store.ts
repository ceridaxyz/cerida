// In-memory combo store for local simulation / testing.
// Production: swap this for Postgres queries (same interface).
//
// The interface is intentionally narrow — the keeper and API both use it,
// so adding a Postgres backend is a drop-in: implement ComboStore and inject.

import { randomUUID } from 'node:crypto'
import type {
  ComboSpec,
  ComboState,
  ComboStatus,
  LegState,
  LegStatus,
} from './combo-types.js'

export interface ComboStore {
  // Write
  createCombo(owner: string, spec: ComboSpec): Promise<ComboState>
  updateLegIntentId(id: string, legIndex: number, intentId: bigint, cost?: bigint): Promise<void>
  updateLegToken(id: string, legIndex: number, tokenId: string): Promise<void>
  updateLegSettled(id: string, legIndex: number, result: { status: LegStatus; payout: bigint }): Promise<void>
  updateComboStatus(id: string, status: ComboStatus, payout: bigint): Promise<void>

  // Read
  getCombo(id: string): Promise<ComboState | undefined>
  listCombos(owner: string): Promise<ComboState[]>
  getExpiredActiveLegs(nowMs: bigint): Promise<(LegState & { combo_id: string; leg_index: number })[]>
}

// ── In-memory implementation ──────────────────────────────────────────────────

export class MemoryComboStore implements ComboStore {
  private combos = new Map<string, ComboState>()

  async createCombo(owner: string, spec: ComboSpec): Promise<ComboState> {
    const id = randomUUID()
    const now = Date.now()
    const last_expiry = spec.legs.reduce((m, l) => l.expiry > m ? l.expiry : m, 0n)

    const state: ComboState = {
      id,
      spec,
      owner,
      legs: spec.legs.map(leg => ({
        spec,
        status: 'pending' as LegStatus,
      })),
      status:     'pending',
      total_cost: 0n,
      max_payout: 0n,
      created_at: now,
      last_expiry,
    }
    // Re-assign legs with correct spec per leg
    state.legs = spec.legs.map((leg, i) => ({
      spec: leg,
      status: 'pending' as LegStatus,
    }))

    this.combos.set(id, state)
    return state
  }

  async updateLegIntentId(id: string, legIndex: number, intentId: bigint): Promise<void> {
    const combo = this.combos.get(id)
    if (!combo) throw new Error(`combo ${id} not found`)
    combo.legs[legIndex].intent_id = intentId
    combo.status = 'active'
  }

  async updateLegToken(id: string, legIndex: number, tokenId: string): Promise<void> {
    const combo = this.combos.get(id)
    if (!combo) throw new Error(`combo ${id} not found`)
    combo.legs[legIndex].position_token = tokenId
    combo.legs[legIndex].status = 'active'
  }

  async updateLegSettled(
    id: string,
    legIndex: number,
    result: { status: LegStatus; payout: bigint },
  ): Promise<void> {
    const combo = this.combos.get(id)
    if (!combo) throw new Error(`combo ${id} not found`)
    combo.legs[legIndex].status = result.status
    combo.legs[legIndex].payout = result.payout
    combo.total_cost += combo.legs[legIndex].cost ?? 0n
    combo.max_payout += result.payout
  }

  async updateComboStatus(id: string, status: ComboStatus, payout: bigint): Promise<void> {
    const combo = this.combos.get(id)
    if (!combo) throw new Error(`combo ${id} not found`)
    combo.status = status
    combo.max_payout = payout
  }

  async getCombo(id: string): Promise<ComboState | undefined> {
    return this.combos.get(id)
  }

  async listCombos(owner: string): Promise<ComboState[]> {
    return [...this.combos.values()].filter(c => c.owner === owner)
  }

  async getExpiredActiveLegs(
    nowMs: bigint,
  ): Promise<(LegState & { combo_id: string; leg_index: number })[]> {
    const out: (LegState & { combo_id: string; leg_index: number })[] = []
    for (const combo of this.combos.values()) {
      combo.legs.forEach((leg, i) => {
        if (leg.status === 'active' && leg.spec.expiry <= nowMs) {
          out.push({ ...leg, combo_id: combo.id, leg_index: i })
        }
      })
    }
    return out
  }
}
