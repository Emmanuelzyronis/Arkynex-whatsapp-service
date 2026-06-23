import { Router, Request, Response } from 'express'
import { sendMessage, isConnected } from '../connectionManager'
import { supabase } from '../supabase'

const router = Router()

// POST /send
// Body: { agentId, leadId, phone, message }
router.post('/', async (req: Request, res: Response) => {
  const { agentId, leadId, phone, message } = req.body

  if (!agentId || !phone || !message) {
    return res.status(400).json({ error: 'agentId, phone, and message are required' })
  }

  if (!isConnected(agentId)) {
    return res.status(409).json({ error: 'Agent not connected to WhatsApp' })
  }

  const messageId = await sendMessage(agentId, phone, message)

  // Log the outbound communication in Supabase
  if (leadId) {
    const { error } = await supabase.from('communications').insert({
      agent_id: agentId,
      lead_id: leadId,
      channel: 'whatsapp',
      direction: 'outbound',
      content: message,
      whatsapp_message_id: messageId,
      wa_status: 'sent',
    })
    if (error) console.error('Failed to log outbound message', error)

    // Update last_contacted_at on the lead
    await supabase
      .from('leads')
      .update({ last_contacted_at: new Date().toISOString() })
      .eq('id', leadId)
  }

  res.json({ status: 'sent', messageId })
})

export default router
