import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import pino from 'pino'
import { useSupabaseAuthState } from './authState'
import { handleIncomingMessage } from './messageHandler'
import { supabase } from './supabase'

const logger = pino({ name: 'connection-manager' })

const sockets = new Map<string, WASocket>()

// In-flight pairing-code requests, keyed by agentId. getPairingCode() populates
// this and returns a Promise that's resolved/rejected from inside the
// connection.update handler below — see the comment in getPairingCode for why.
const pendingPairingRequests = new Map<
  string,
  { phone: string; resolve: (code: string) => void; reject: (err: Error) => void }
>()

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function setProfileStatus(agentId: string, status: string) {
  const { error } = await supabase
    .from('profiles')
    .update({ wa_status: status })
    .eq('id', agentId)
  if (error) logger.error({ error, agentId, status }, 'setProfileStatus: Supabase write failed')
}

async function setSessionStatus(
  agentId: string,
  status: string,
  extra: Record<string, unknown> = {}
): Promise<boolean> {
  const { error } = await supabase
    .from('wa_sessions')
    .upsert(
      { agent_id: agentId, status, updated_at: new Date().toISOString(), ...extra },
      { onConflict: 'agent_id' }
    )
  if (error) {
    logger.error(
      {
        agentId,
        status,
        extra: Object.keys(extra),
        pgCode: error.code,
        pgMessage: error.message,
        pgDetails: error.details,
        pgHint: error.hint,
      },
      'setSessionStatus: Supabase upsert failed'
    )
    return false
  }
  return true
}

// Normalise Nigerian phone numbers to international digits (no + or spaces)
// e.g. "08012345678" → "2348012345678", "+234 801 234 5678" → "2348012345678"
function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.startsWith('0')) return `234${digits.slice(1)}`
  if (digits.startsWith('234')) return digits
  return digits
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect (QR flow)
// ─────────────────────────────────────────────────────────────────────────────

export async function connectAgent(agentId: string, pairingPhone?: string): Promise<void> {
  if (sockets.has(agentId)) {
    logger.info({ agentId }, 'Socket already open')
    return
  }

  const isPairingFlow = !!pairingPhone

  let version: [number, number, number]
  try {
    const result = await fetchLatestBaileysVersion()
    version = result.version
    logger.info({ version }, 'Baileys version fetched')
  } catch (err) {
    version = [2, 3000, 1023460110]
    logger.warn({ err, version }, 'fetchLatestBaileysVersion failed — using fallback version')
  }

  const { state, saveCreds } = await useSupabaseAuthState(agentId)

  await setProfileStatus(agentId, 'connecting')
  await setSessionStatus(agentId, 'connecting', { qr_code: null, pairing_code: null })

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }) as ReturnType<typeof pino>,
    connectTimeoutMs: 30_000,
    retryRequestDelayMs: 2000,
    // Baileys' default query timeout can fire before WhatsApp responds to
    // requestPairingCode(), which surfaces as a client-side "Connection
    // Closed" (428) even though nothing is actually wrong with the socket.
    // Disabling it is the documented fix for that specific failure mode.
    defaultQueryTimeoutMs: isPairingFlow ? undefined : 60_000,
  })

  sockets.set(agentId, sock)
  sock.ev.on('creds.update', saveCreds)

  // makeWASocket() returns before the underlying WebSocket to WhatsApp's
  // servers has finished opening. Calling requestPairingCode() (or anything
  // else that sends a stanza) before then throws "Connection Closed" (428) —
  // this was the race causing pairing to fail. `socketReady` resolves once
  // the socket emits its first connection.update, by which point the WS
  // handshake is underway and outgoing stanzas can be sent. A short fallback
  // timer guarantees connectAgent() never hangs forever if no update arrives.
  let resolveReady: () => void
  const socketReady = new Promise<void>((resolve) => { resolveReady = resolve })
  const readyFallback = setTimeout(() => resolveReady(), 35_000)
  const onFirstUpdate = () => {
    clearTimeout(readyFallback)
    sock.ev.off('connection.update', onFirstUpdate)
    resolveReady()
  }
  sock.ev.on('connection.update', onFirstUpdate)

  sock.ev.on('connection.update', async (update) => {
    // getPairingCode() tears down an existing socket before opening a fresh
    // one (see comment there). That old socket's own 'close' event can
    // still arrive after the new socket has already taken its place in
    // `sockets`. If we let it run, it would delete the new socket's map
    // entry and reject the new pending request out from under it. Guard
    // every event on this socket still being the current one for the agent.
    if (sockets.get(agentId) !== sock) return

    const { connection, lastDisconnect, qr } = update

    // Pairing-code flow: per Baileys' docs, requestPairingCode() must be
    // called as the socket reaches 'connecting' (or as soon as a qr stanza
    // is available) — https://baileys.wiki/docs/socket/connecting/. Doing it
    // any later, from outside this handler, leaves a window where the
    // standard QR handshake has already taken over, which is what caused
    // the "Connection Closed" (428) errors and — worse — a logged-out (401)
    // close arriving a second or two after a code had already been issued.
    // We request it here, exactly once per socket (the pending entry is
    // removed as soon as we act on it).
    const pending = pendingPairingRequests.get(agentId)
    if (pending && (connection === 'connecting' || qr)) {
      pendingPairingRequests.delete(agentId)
      try {
        const code = await sock.requestPairingCode(pending.phone)
        const formatted = code.replace(/(.{4})(.{4})/, '$1-$2')
        // WhatsApp has already issued the code at this point — but don't
        // report success to the frontend unless it's actually persisted.
        // Previously this write's failure was only logged (see
        // setSessionStatus), so a code could reach the UI that was never in
        // the DB — the next Realtime/poll update would then show whatever
        // the DB actually had, making the code look like it "vanished" with
        // no explanation. Surfacing the failure here instead means the
        // agent sees a real error and can retry, rather than a code that
        // silently stops working.
        const persisted = await setSessionStatus(agentId, 'pairing_code_ready', { pairing_code: formatted, qr_code: null })
        await setProfileStatus(agentId, 'connecting')
        if (!persisted) {
          throw new Error('Got a pairing code from WhatsApp, but couldn\u2019t save it — please try again.')
        }
        logger.info({ agentId, code: formatted }, 'Pairing code generated and saved')
        pending.resolve(formatted)
      } catch (err) {
        logger.error({ err, agentId }, 'requestPairingCode failed')
        pending.reject(
          err instanceof Error
            ? err
            : new Error('WhatsApp wasn\u2019t ready to issue a code yet — please tap "Get Code" again in a few seconds.')
        )
      }
    }

    // Skip the QR write entirely on a pairing-code socket — we requested a
    // code, not a QR, and writing qr_ready here would race the write above.
    if (qr && !isPairingFlow) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 })
        await setSessionStatus(agentId, 'qr_ready', { qr_code: qrDataUrl, pairing_code: null })
        await setProfileStatus(agentId, 'qr_ready')
        logger.info({ agentId }, 'QR code generated and saved to Supabase')
      } catch (err) {
        logger.error({ err, agentId }, 'QR generation or Supabase write failed')
      }
    }

    if (connection === 'open') {
      const phoneJid = sock.user?.id ?? null
      await setSessionStatus(agentId, 'connected', {
        phone_jid: phoneJid,
        connected_at: new Date().toISOString(),
        qr_code: null,
        pairing_code: null,
      })
      await setProfileStatus(agentId, 'connected')
      logger.info({ agentId, phoneJid }, 'WhatsApp connected')
    }

    if (connection === 'close') {
      sockets.delete(agentId)
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      const stillPending = pendingPairingRequests.get(agentId)
      if (stillPending) {
        pendingPairingRequests.delete(agentId)
        stillPending.reject(new Error('Connection closed before a pairing code could be issued — please tap "Get Code" again.'))
      }

      if (loggedOut) {
        const { error } = await supabase
          .from('wa_sessions')
          .update({ creds: null, keys: null, status: 'disconnected', phone_jid: null, qr_code: null, pairing_code: null })
          .eq('agent_id', agentId)
        if (error) logger.error({ error, agentId }, 'Failed to clear session on logout')
        await setProfileStatus(agentId, 'disconnected')
        logger.info(
          {
            agentId,
            statusCode,
            disconnectReason: (lastDisconnect?.error as Boom)?.message,
            disconnectData: (lastDisconnect?.error as Boom)?.output?.payload,
          },
          'Logged out — session cleared'
        )
      } else {
        logger.warn({ agentId, statusCode }, 'Disconnected — reconnecting...')
        await setProfileStatus(agentId, 'connecting')
        setTimeout(() => connectAgent(agentId), 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (!msg.key.fromMe) await handleIncomingMessage(agentId, msg)
    }
  })

  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      const msgId = update.key.id
      if (!msgId) continue
      const status = update.update.status
      let waStatus: string | null = null
      if (status === proto.WebMessageInfo.Status.SERVER_ACK) waStatus = 'sent'
      else if (status === proto.WebMessageInfo.Status.DELIVERY_ACK) waStatus = 'delivered'
      else if (status === proto.WebMessageInfo.Status.READ) waStatus = 'read'
      else if (status === proto.WebMessageInfo.Status.PLAYED) waStatus = 'read'
      else if (status === proto.WebMessageInfo.Status.ERROR) waStatus = 'failed'
      if (waStatus) {
        const { error } = await supabase
          .from('communications')
          .update({ wa_status: waStatus })
          .eq('whatsapp_message_id', msgId)
          .eq('agent_id', agentId)
        if (error) logger.error({ error, msgId, waStatus }, 'Failed to update message status')
      }
    }
  })

  // Don't resolve until the socket has had its first chance to open —
  // see the comment above where `socketReady` is created.
  await socketReady
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing code flow (phone number alternative to QR)
// ─────────────────────────────────────────────────────────────────────────────

export async function getPairingCode(agentId: string, phone: string): Promise<string> {
  const normalised = normalisePhone(phone)
  logger.info({ agentId, normalised }, 'Requesting pairing code')

  // A pairing-code request needs a *freshly opened* socket where
  // requestPairingCode() is the first stanza sent — see the comment in the
  // connection.update handler above. Tear down anything already open for
  // this agent (a leftover QR attempt, or a previous failed pairing
  // attempt) rather than reusing it. Reusing a socket that already had one
  // failed/uncertain requestPairingCode() call is what used to cause a
  // second call on the same connection — which lines up with WhatsApp
  // forcing a logged-out close roughly a second after a code was issued.
  const existing = sockets.get(agentId)
  if (existing) {
    try { existing.end(undefined) } catch { /* socket already dead — fine */ }
    sockets.delete(agentId)
  }
  pendingPairingRequests.delete(agentId)

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingPairingRequests.delete(agentId)) {
        reject(new Error('WhatsApp wasn\u2019t ready to issue a code yet \u2014 please tap "Get Code" again in a few seconds.'))
      }
    }, 20_000)

    pendingPairingRequests.set(agentId, {
      phone: normalised,
      resolve: (code) => { clearTimeout(timeout); resolve(code) },
      reject: (err) => { clearTimeout(timeout); reject(err) },
    })

    // The actual requestPairingCode() call happens inside the
    // connection.update handler once this socket reaches 'connecting'.
    connectAgent(agentId, normalised).catch((err) => {
      if (pendingPairingRequests.delete(agentId)) {
        clearTimeout(timeout)
        reject(err instanceof Error ? err : new Error('Failed to initialise WhatsApp connection'))
      }
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Disconnect
// ─────────────────────────────────────────────────────────────────────────────

export async function disconnectAgent(agentId: string): Promise<void> {
  const sock = sockets.get(agentId)
  if (sock) {
    try { await sock.logout() } catch { sock.end(undefined) }
    sockets.delete(agentId)
  }
  const { error } = await supabase
    .from('wa_sessions')
    .update({ creds: null, keys: null, status: 'disconnected', phone_jid: null, qr_code: null, pairing_code: null })
    .eq('agent_id', agentId)
  if (error) logger.error({ error, agentId }, 'Failed to clear session on disconnect')
  await setProfileStatus(agentId, 'disconnected')
  logger.info({ agentId }, 'Disconnected by agent')
}

// ─────────────────────────────────────────────────────────────────────────────
// Send
// ─────────────────────────────────────────────────────────────────────────────

export async function sendMessage(agentId: string, phone: string, text: string): Promise<string> {
  const sock = sockets.get(agentId)
  if (!sock) throw new Error('Agent not connected to WhatsApp')
  const digits = phone.replace(/\D/g, '')
  const jid = digits + '@s.whatsapp.net'
  const result = await sock.sendMessage(jid, { text })
  const messageId = result?.key.id ?? ''
  logger.info({ agentId, jid, messageId }, 'Message sent')
  return messageId
}

export function isConnected(agentId: string): boolean {
  return sockets.has(agentId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore on startup
// ─────────────────────────────────────────────────────────────────────────────

export async function restoreActiveSessions(): Promise<void> {
  const { data: sessions, error } = await supabase
    .from('wa_sessions')
    .select('agent_id, creds')
    .eq('status', 'connected')

  if (error) {
    logger.error({ error }, 'restoreActiveSessions: Supabase query failed — check env vars')
    return
  }

  if (!sessions?.length) { logger.info('No active sessions to restore'); return }

  logger.info({ count: sessions.length }, 'Restoring active sessions')
  for (const session of sessions) {
    if (session.creds) {
      connectAgent(session.agent_id).catch((err) =>
        logger.error({ err, agentId: session.agent_id }, 'Failed to restore session')
      )
    }
  }
}
