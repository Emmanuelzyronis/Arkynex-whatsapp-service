import {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys'
import { supabase } from './supabase'

// Recursively replace Buffer/Uint8Array instances with a plain, JSON-safe
// marker object BEFORE JSON.stringify ever touches them. This can't be done
// via JSON.stringify's replacer argument (the approach this used to use):
// Node's Buffer has its own toJSON(), and JSON.stringify always calls that
// *before* handing the value to a replacer — silently turning every real
// Buffer into { type: 'Buffer', data: [...] } first. The replacer then only
// ever sees that already-converted plain object, never an actual Buffer, so
// the custom marker below was never actually being applied to real key
// material. That mismatched shape is what was genuinely sitting in
// Supabase, and deserialize() didn't recognise it — so Baileys' own crypto
// calls were receiving a plain object where they needed a Buffer.
function markBuffers(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __t: 'buf', d: Array.from(value as Uint8Array) }
  }
  if (Array.isArray(value)) {
    return value.map(markBuffers)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = markBuffers(v)
    }
    return out
  }
  return value
}

// Serialize Buffers/Uint8Arrays to plain JSON so they survive Supabase JSONB round-trips
function serialize(obj: unknown): unknown {
  // markBuffers() runs first so no raw Buffer ever reaches JSON.stringify —
  // see the comment above for why that ordering matters. The stringify/parse
  // pass after it just normalises anything else non-JSON-safe (undefined,
  // etc.), same as before.
  return JSON.parse(JSON.stringify(markBuffers(obj)))
}

// Restore Buffers from their serialized form
function deserialize<T>(obj: unknown): T {
  return JSON.parse(JSON.stringify(obj), (_key, value) => {
    if (value && typeof value === 'object') {
      if (value.__t === 'buf' && Array.isArray(value.d)) {
        return Buffer.from(value.d)
      }
      // Rows written before this fix have Node's default Buffer shape
      // (see markBuffers' comment) rather than the marker above — recognise
      // that too so existing sessions don't need to be reset.
      if (value.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data)
      }
    }
    return value
  }) as T
}

export async function useSupabaseAuthState(agentId: string): Promise<{
  state: AuthenticationState
  saveCreds: () => Promise<void>
}> {
  // Load existing session from Supabase
  const { data: session, error: loadError } = await supabase
    .from('wa_sessions')
    .select('creds, keys')
    .eq('agent_id', agentId)
    .maybeSingle()

  if (loadError) {
    console.error(
      `[authState] Failed to load session for ${agentId} — check SUPABASE_SERVICE_ROLE_KEY:`,
      loadError
    )
  }

  let creds: AuthenticationCreds = session?.creds
    ? deserialize<AuthenticationCreds>(session.creds)
    : initAuthCreds()

  let keys: Record<string, Record<string, unknown>> = session?.keys
    ? deserialize<Record<string, Record<string, unknown>>>(session.keys)
    : {}

  const persistState = async () => {
    const { error } = await supabase
      .from('wa_sessions')
      .upsert(
        {
          agent_id: agentId,
          creds: serialize(creds),
          keys: serialize(keys),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'agent_id' }
      )
    if (error) {
      // Surface this in Railway logs — if it appears, SUPABASE_SERVICE_ROLE_KEY is likely wrong
      console.error(
        `[authState] persistState FAILED for ${agentId} — check SUPABASE_SERVICE_ROLE_KEY:`,
        error
      )
    }
  }

  return {
    state: {
      creds,
      keys: {
        get<T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[]
        ): { [id: string]: SignalDataTypeMap[T] } {
          const result: { [id: string]: SignalDataTypeMap[T] } = {}
          for (const id of ids) {
            let value = keys[type]?.[id]
            if (value !== undefined) {
              if (type === 'app-state-sync-key') {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>
                )
              }
              result[id] = value as SignalDataTypeMap[T]
            }
          }
          return result
        },
        async set(data: {
          [T in keyof SignalDataTypeMap]?: {
            [id: string]: SignalDataTypeMap[T] | null | undefined
          }
        }) {
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            const categoryData = data[category]
            if (!categoryData) continue
            keys[category] = keys[category] || {}
            for (const [id, value] of Object.entries(categoryData)) {
              if (value == null) {
                delete keys[category][id]
              } else {
                keys[category][id] = value
              }
            }
          }
          await persistState()
        },
      },
    },
    saveCreds: persistState,
  }
}
