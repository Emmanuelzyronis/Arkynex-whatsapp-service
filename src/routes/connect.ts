import { Router, Request, Response } from 'express'
import {
  connectAgent,
  disconnectAgent,
  isConnected,
} from '../connectionManager'
import { supabase } from '../supabase'

const router = Router()

// POST /connect/:agentId — initiate or resume WhatsApp connection
router.post('/:agentId', async (req: Request, res: Response) => {
  const { agentId } = req.params

  if (isConnected(agentId)) {
    return res.json({ status: 'already_connected' })
  }

  // Fire-and-forget — QR is delivered via Supabase Realtime
  connectAgent(agentId).catch((err) => {
    console.error('connectAgent error', err)
  })

  res.json({ status: 'connecting' })
})

// POST /disconnect/:agentId — log out and clear session
router.post('/disconnect/:agentId', async (req: Request, res: Response) => {
  await disconnectAgent(req.params.agentId)
  res.json({ status: 'disconnected' })
})

// GET /status/:agentId — return current connection status + QR if pending
router.get('/status/:agentId', async (req: Request, res: Response) => {
  const { agentId } = req.params

  const { data: session } = await supabase
    .from('wa_sessions')
    .select('status, phone_jid, qr_code, connected_at')
    .eq('agent_id', agentId)
    .maybeSingle()

  res.json({
    in_memory: isConnected(agentId),
    db_status: session?.status ?? 'disconnected',
    phone_jid: session?.phone_jid ?? null,
    qr_code: session?.qr_code ?? null,
    connected_at: session?.connected_at ?? null,
  })
})

export default router
