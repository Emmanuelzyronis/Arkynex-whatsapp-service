import { Router, Request, Response } from 'express'
import { connectAgent, disconnectAgent, getPairingCode, isConnected } from '../connectionManager'
import { supabase } from '../supabase'

const router = Router()

// POST /connect/:agentId — initiate or resume WhatsApp connection (QR flow)
router.post('/:agentId', async (req: Request, res: Response) => {
  const { agentId } = req.params

  if (isConnected(agentId)) {
    return res.json({ status: 'already_connected' })
  }

  connectAgent(agentId).catch((err) => {
    console.error('connectAgent error', err)
  })

  res.json({ status: 'connecting' })
})

// POST /connect/pairing-code/:agentId — get a phone number pairing code
// Body: { phone: "08012345678" }
router.post('/pairing-code/:agentId', async (req: Request, res: Response) => {
  const { agentId } = req.params
  const { phone } = req.body

  if (!phone) {
    return res.status(400).json({ error: 'phone is required' })
  }

  try {
    const code = await getPairingCode(agentId, phone)
    res.json({ code })
  } catch (err) {
    console.error('getPairingCode error', err)
    res.status(500).json({
      error: 'pairing_failed',
      message: err instanceof Error ? err.message : 'Failed to generate pairing code',
    })
  }
})

// POST /connect/disconnect/:agentId — log out and clear session
router.post('/disconnect/:agentId', async (req: Request, res: Response) => {
  await disconnectAgent(req.params.agentId)
  res.json({ status: 'disconnected' })
})

// GET /connect/status/:agentId — current connection status
router.get('/status/:agentId', async (req: Request, res: Response) => {
  const { agentId } = req.params
  const { data: session } = await supabase
    .from('wa_sessions')
    .select('status, phone_jid, qr_code, pairing_code, connected_at')
    .eq('agent_id', agentId)
    .maybeSingle()

  res.json({
    in_memory: isConnected(agentId),
    db_status: session?.status ?? 'disconnected',
    phone_jid: session?.phone_jid ?? null,
    qr_code: session?.qr_code ?? null,
    pairing_code: session?.pairing_code ?? null,
    connected_at: session?.connected_at ?? null,
  })
})

export default router
