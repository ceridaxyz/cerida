// Combo API — thin HTTP layer over the PTB builder + store.
//
// POST /combos         — validate spec, submit request PTB, store combo
// GET  /combos?owner=  — list user's combos
// GET  /combos/:id     — single combo detail
//
// Run standalone: `bun combo-api.ts` (Bun built-in HTTP server)
// Or mount the handlers into your existing express/hono server.

import type { SuiClient } from '@mysten/sui/client'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { buildRequestPTB, parseIntentIds } from './combo-ptb.js'
import { MemoryComboStore, type ComboStore } from './combo-store.js'
import type { ComboSpec } from './combo-types.js'
import { client, deployer, loadManifest, need } from './config.js'

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const store: ComboStore = new MemoryComboStore()
const c: SuiClient = client()
const kp: Ed25519Keypair = deployer()

function getAddresses() {
  const m = loadManifest()
  return {
    cerida:     need(m, 'cerida'),
    vault:      need(m, 'vault'),
    manager:    need(m, 'manager'),
    predict:    need(m, 'predict'),
    quote_type: need(m, 'quote_type'),
  }
}

// ── Request handler ───────────────────────────────────────────────────────────

interface ComboRequest {
  owner:      string   // user's Sui address (for record-keeping; PTB is signed by keeper on testnet)
  spec:       ComboSpec
  coin_id:    string   // Coin<Quote> object the user wants to spend
}

export async function handleCreateCombo(req: ComboRequest) {
  const { cerida, vault, quote_type } = getAddresses()
  const { owner, spec, coin_id } = req

  if (!spec.legs || spec.legs.length === 0) {
    throw new Error('combo must have at least one leg')
  }
  if (spec.legs.length > 8) {
    throw new Error('maximum 8 legs per combo')
  }

  // Create combo record (pending)
  const combo = await store.createCombo(owner, spec)

  // Build + submit the request PTB
  const { tx } = buildRequestPTB(cerida, vault, quote_type, spec.legs, coin_id)
  const result = await c.signAndExecuteTransaction({
    transaction: tx,
    signer:      kp,
    options:     { showEvents: true, showEffects: true },
  })

  if (result.effects?.status.status !== 'success') {
    throw new Error(`request PTB failed: ${JSON.stringify(result.effects?.status)}`)
  }

  // Map intent_ids back to legs (events are ordered same as PTB calls)
  const intentIds = parseIntentIds(result)
  for (let i = 0; i < intentIds.length; i++) {
    await store.updateLegIntentId(combo.id, i, intentIds[i])
  }

  return { combo_id: combo.id, intent_ids: intentIds.map(String), tx_digest: result.digest }
}

export async function handleGetCombo(id: string) {
  const combo = await store.getCombo(id)
  if (!combo) throw new Error(`combo ${id} not found`)
  return combo
}

export async function handleListCombos(owner: string) {
  return store.listCombos(owner)
}

// ── Bun HTTP server (optional standalone mode) ────────────────────────────────

if (typeof Bun !== 'undefined' && import.meta.main) {
  const PORT = parseInt(process.env.PORT ?? '3001')

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)

      try {
        if (req.method === 'POST' && url.pathname === '/combos') {
          const body = await req.json() as ComboRequest
          const result = await handleCreateCombo(body)
          return json(201, result)
        }

        if (req.method === 'GET' && url.pathname === '/combos') {
          const owner = url.searchParams.get('owner') ?? ''
          const combos = await handleListCombos(owner)
          return json(200, { combos })
        }

        const m = url.pathname.match(/^\/combos\/([^/]+)$/)
        if (req.method === 'GET' && m) {
          const combo = await handleGetCombo(m[1])
          return json(200, combo)
        }

        return json(404, { error: 'not found' })
      } catch (e: any) {
        return json(400, { error: e.message })
      }
    },
  })

  console.log(`[combo-api] listening on :${PORT}`)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, (_k, v) => typeof v === 'bigint' ? v.toString() : v), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
