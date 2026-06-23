import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import pino from 'pino'
import { useSupabaseAuthState } from './authState'
import { handleIncomingMessage } from './messageHandler'
import { supabase } from './supabase'

const logger = pino({ name: 'connection-manager' })

// In-memory socket registry — one socket per agentId
const sockets = new Map<string, WASocket>()

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function setProfileStatus(agentId: string, status: string) {
  await supabase.from('profiles').update({ wa_status: status }).eq('id', agentId)
}

async function setSessionStatus(agentId: string, status: string, extra: Record<string, unknown> = {}) {
  await supabase
    .from('wa_sessions')
    .upsert(
      { agent_id: agentId, status, updated_at: new Date().toISOString(), ...extra },
      { onConflict: 'agent_id' }
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect
// ─────────────────────────────────────────────────────────────────────────────

export async function connectAgent(agentId: string): Promise<void> {
  if (sockets.has(agentId)) {
    logger.info({ agentId }, 'Socket already open')
    return
  }

  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useSupabaseAuthState(agentId)

  await setProfileStatus(agentId, 'connecting')
  await setSessionStatus(agentId, 'connecting', { qr_code: null })

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }) as ReturnType<typeof pino>,
    connectTimeoutMs: 30_000,
    retryRequestDelayMs: 2000,
  })

  sockets.set(agentId, sock)

  // Persist credentials whenever they change
  sock.ev.on('creds.update', saveCreds)

  // ── Connection lifecycle ──
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // QR code ready — convert to data URL and push via Supabase so frontend picks it up
    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 })
        await setSessionStatus(agentId, 'qr_ready', { qr_code: qrDataUrl })
        await setProfileStatus(agentId, 'qr_ready')
        logger.info({ agentId }, 'QR code generated')
      } catch (err) {
        logger.error({ err, agentId }, 'QR generation failed')
      }
    }

    if (connection === 'open') {
      const phoneJid = sock.user?.id ?? null
      await setSessionStatus(agentId, 'connected', {
        phone_jid: phoneJid,
        connected_at: new Date().toISOString(),
        qr_code: null, // clear QR once connected
      })
      await setProfileStatus(agentId, 'connected')
      logger.info({ agentId, phoneJid }, 'WhatsApp connected')
    }

    if (connection === 'close') {
      sockets.delete(agentId)

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      if (loggedOut) {
        // Wipe session on logout so agent must scan QR again
        await supabase
          .from('wa_sessions')
          .update({ creds: null, keys: null, status: 'disconnected', phone_jid: null, qr_code: null })
          .eq('agent_id', agentId)
        await setProfileStatus(agentId, 'disconnected')
        logger.info({ agentId }, 'Logged out — session cleared')
      } else {
        // Transient disconnect — reconnect automatically
        logger.warn({ agentId, statusCode }, 'Disconnected — reconnecting...')
        await setProfileStatus(agentId, 'connecting')
        setTimeout(() => connectAgent(agentId), 3000)
      }
    }
  })

  // ── Incoming messages ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (!msg.key.fromMe) {
        await handleIncomingMessage(agentId, msg)
      }
    }
  })

  // ── Outgoing message status updates (sent → delivered → read) ──
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      const msgId = update.key.id
      if (!msgId) continue

      const status = update.update.status
      let waStatus: string | null = null
      if (status === 2) waStatus = 'sent'
      else if (status === 3) waStatus = 'delivered'
      else if (status === 4) waStatus = 'read'
      else if (status === -1) waStatus = 'failed'

      if (waStatus) {
        await supabase
          .from('communications')
          .update({ wa_status: waStatus })
          .eq('whatsapp_message_id', msgId)
          .eq('agent_id', agentId)
      }
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Disconnect
// ─────────────────────────────────────────────────────────────────────────────

export async function disconnectAgent(agentId: string): Promise<void> {
  const sock = sockets.get(agentId)
  if (sock) {
    try {
      await sock.logout()
    } catch {
      sock.end(undefined)
    }
    sockets.delete(agentId)
  }
  await supabase
    .from('wa_sessions')
    .update({ creds: null, keys: null, status: 'disconnected', phone_jid: null, qr_code: null })
    .eq('agent_id', agentId)
  await setProfileStatus(agentId, 'disconnected')
  logger.info({ agentId }, 'Disconnected by agent')
}

// ─────────────────────────────────────────────────────────────────────────────
// Send message
// ─────────────────────────────────────────────────────────────────────────────

export async function sendMessage(
  agentId: string,
  phone: string,
  text: string
): Promise<string> {
  const sock = sockets.get(agentId)
  if (!sock) throw new Error('Agent not connected to WhatsApp')

  // Build JID — strip non-digits, ensure Nigerian country code prefix if needed
  const digits = phone.replace(/\D/g, '')
  const jid = digits + '@s.whatsapp.net'

  const result = await sock.sendMessage(jid, { text })
  const messageId = result?.key.id ?? ''

  logger.info({ agentId, jid, messageId }, 'Message sent')
  return messageId
}

// ─────────────────────────────────────────────────────────────────────────────
// Status check
// ─────────────────────────────────────────────────────────────────────────────

export function isConnected(agentId: string): boolean {
  return sockets.has(agentId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore sessions on service startup
// ─────────────────────────────────────────────────────────────────────────────

export async function restoreActiveSessions(): Promise<void> {
  const { data: sessions } = await supabase
    .from('wa_sessions')
    .select('agent_id, creds')
    .eq('status', 'connected')

  if (!sessions?.length) {
    logger.info('No active sessions to restore')
    return
  }

  logger.info({ count: sessions.length }, 'Restoring active sessions')
  for (const session of sessions) {
    if (session.creds) {
      // connectAgent will attempt to reconnect without QR using stored creds
      connectAgent(session.agent_id).catch((err) =>
        logger.error({ err, agentId: session.agent_id }, 'Failed to restore session')
      )
    }
  }
}
