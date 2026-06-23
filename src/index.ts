import 'express-async-errors'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import pino from 'pino'
import connectRoutes from './routes/connect'
import sendRoutes from './routes/send'
import { restoreActiveSessions } from './connectionManager'

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

// Verify all requests carry the shared secret (set in Next.js env as WHATSAPP_SERVICE_SECRET)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') return next() // health check is public
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
  // Reconnect any agents whose sessions were active before a restart
  await restoreActiveSessions()
})
