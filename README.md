# Arkynex WhatsApp Service

Standalone Node.js service powering WhatsApp integration for Arkynex CRM.  
Uses **Baileys** (WhatsApp Web protocol) — agents connect by scanning a QR code.  
No Meta developer account or Business Verification required.

## Stack

- Node.js 18+ / TypeScript
- [Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web multi-device
- Express — HTTP API
- Supabase — session persistence + event storage
- Docker + Railway — deployment

## How it works

```
Agent clicks Connect
       │
       ▼
Next.js  POST /api/whatsapp/connect
       │
       ▼
This service creates a Baileys socket
       │
       ├─ Generates QR code → saves data URL to wa_sessions.qr_code
       │
       └─ Supabase Realtime pushes QR to browser → agent scans with phone
              │
              ▼
       WhatsApp connected — creds saved to wa_sessions.creds/keys
              │
       ┌──────┴──────┐
       │             │
  Incoming msgs   Outgoing msgs
  → communications  ← POST /send
    table (inbound)   → communications
                        table (outbound)
```

## Project structure

```
src/
 ├─ index.ts              Express app, startup, session restore
 ├─ supabase.ts           Service-role Supabase client
 ├─ authState.ts          Supabase-backed Baileys auth state (replaces file-based)
 ├─ connectionManager.ts  Per-agent socket lifecycle, QR, reconnect, status updates
 ├─ messageHandler.ts     Inbound message → lead lookup → communications insert
 └─ routes/
     ├─ connect.ts        POST /:agentId, POST /disconnect/:agentId, GET /status/:agentId
     └─ send.ts           POST / { agentId, leadId, phone, message }
```

## API endpoints

All requests require the `x-api-secret` header matching `API_SECRET` in env.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/connect/:agentId` | Start WhatsApp connection for agent. QR delivered via Supabase Realtime. |
| `POST` | `/connect/disconnect/:agentId` | Logout and wipe session. |
| `GET` | `/connect/status/:agentId` | Returns current status + QR if pending. |
| `POST` | `/send` | Send message. Body: `{ agentId, leadId?, phone, message }` |
| `GET` | `/health` | Health check (no auth required). |

## Environment variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (bypasses RLS — keep secret) |
| `API_SECRET` | Shared secret for request authentication. Must match `WHATSAPP_SERVICE_SECRET` in Next.js |
| `PORT` | HTTP port (Railway sets this automatically) |

Copy `.env.example` to `.env` for local dev.

## Local development

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev
```

The service starts on port 3001 by default.

## Deploying to Railway

See **`DEPLOY.md`** for the full step-by-step.

Quick version:
1. Push this directory to a GitHub repo
2. New Railway project → Deploy from GitHub
3. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_SECRET` in Railway environment
4. Railway builds via `Dockerfile` automatically

## Supabase schema (already applied)

This service reads/writes these tables:

- `wa_sessions` — per-agent Baileys credentials, Signal keys, QR code, status
- `profiles` — `wa_status` field updated on connect/disconnect
- `communications` — inbound and outbound WhatsApp messages
- `leads` — `last_contacted_at` updated on message

The `wa_sessions` table is on the `supabase_realtime` publication —  
QR code updates are pushed to the browser without polling.

## Message matching

Inbound messages are matched to leads by comparing the last 10 digits of the sender's phone  
against stored lead phone numbers. This handles the `+234` vs `0` prefix difference common in Nigeria.  
Unmatched numbers are silently skipped (no lead created automatically).
