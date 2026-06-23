import { proto } from '@whiskeysockets/baileys'
import pino from 'pino'
import { supabase } from './supabase'

const logger = pino({ name: 'message-handler' })

function extractText(msg: proto.IWebMessageInfo): string {
  const m = msg.message
  if (!m) return '[no content]'

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    '[media message]'
  )
}

// Normalise phone: strip WhatsApp suffix, leading +, spaces, dashes
// Then match the last 10 digits against stored lead phones (handles +234 vs 0...)
function normalisePhone(jid: string): string {
  return jid.replace(/@.+$/, '').replace(/\D/g, '')
}

export async function handleIncomingMessage(
  agentId: string,
  msg: proto.IWebMessageInfo
): Promise<void> {
  try {
    const jid = msg.key.remoteJid
    if (!jid || jid.endsWith('@g.us')) return // skip group messages

    const rawPhone = normalisePhone(jid)
    const last10 = rawPhone.slice(-10)
    const text = extractText(msg)
    const messageId = msg.key.id || ''

    // Find matching lead by phone (last 10 digits match handles +234 vs 0 prefix)
    const { data: leads } = await supabase
      .from('leads')
      .select('id, phone')
      .eq('agent_id', agentId)

    const matchedLead = leads?.find((l) => {
      const normalised = l.phone.replace(/\D/g, '')
      return normalised.endsWith(last10)
    })

    if (!matchedLead) {
      logger.info({ agentId, rawPhone }, 'Incoming WA message — no matching lead, skipping')
      return
    }

    // Check for duplicate message_id
    const { data: existing } = await supabase
      .from('communications')
      .select('id')
      .eq('whatsapp_message_id', messageId)
      .maybeSingle()

    if (existing) return // already processed

    // Insert communication record
    await supabase.from('communications').insert({
      agent_id: agentId,
      lead_id: matchedLead.id,
      channel: 'whatsapp',
      direction: 'inbound',
      content: text,
      whatsapp_message_id: messageId,
      wa_status: 'delivered',
    })

    // Update lead's last_contacted_at
    await supabase
      .from('leads')
      .update({ last_contacted_at: new Date().toISOString() })
      .eq('id', matchedLead.id)

    logger.info({ agentId, leadId: matchedLead.id }, 'Incoming WA message saved')
  } catch (err) {
    logger.error({ err, agentId }, 'Failed to handle incoming message')
  }
}
