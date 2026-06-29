import 'express-async-errors'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import pino from 'pino'
import connectRoutes from './routes/connect'
import sendRoutes from './routes/send'
import { restoreActiveSessions } from './connectionManager'
import { supabase } from './supabase'

const logger = pino({ name: 'arkynex-wa' })
const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)
const API_SECRET = process.env.API_SECRET

if (!API_SECRET) {
  throw new Error('API_SECRET environment variable is required')
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') return next()
  const secret = req.headers['x-api-secret']
  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

app.use('/connect', connectRoutes)
app.use('/send', sendRoutes)

// ─── Global error handler ────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(err)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  logger.info({ port: PORT }, 'Arkynex WhatsApp service started')

  // On every startup, clear any in-progress states left over from before this restart.
  // QR codes and pairing codes are in-memory — they can't survive a service restart.
  // Without this, the frontend shows an expired QR whenever the service restarts.
  const { error, count } = await supabase
    .from('wa_sessions')
    .update({
      status: 'disconnected',
      qr_code: null,
      pairing_code: null,
    })
    .in('status', ['qr_ready', 'connecting', 'pairing_code_ready'])
    .select()

  if (error) {
    logger.error({ error }, 'Startup: failed to clear stale sessions')
  } else {
    logger.info({ count }, 'Startup: cleared stale in-progress sessions → disconnected')
  }

  // Reconnect agents who were fully connected before the restart
  await restoreActiveSessions()
})
