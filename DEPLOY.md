# Deploying the Arkynex WhatsApp Service to Railway

## 1. Create a Railway project

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Point it at this `baileys-service/` directory (or push it as its own repo)
3. Railway auto-detects the `Dockerfile`

## 2. Set environment variables on Railway

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://ymlnxbsqnfgjhhjsuzql.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service role key (Settings → API) |
| `API_SECRET` | A long random string — copy it, you'll need it in Next.js too |
| `NODE_ENV` | `production` |

Railway sets `PORT` automatically — do not override it.

## 3. Set environment variables in your Next.js app

Add to `.env.local` (and Vercel env vars):

```env
WHATSAPP_SERVICE_URL=https://your-railway-app.railway.app
WHATSAPP_SERVICE_SECRET=the_same_API_SECRET_from_above
```

## 4. Enable Supabase Realtime on wa_sessions

In Supabase Dashboard → Database → Replication:
- Enable Realtime for the `wa_sessions` table (or run the SQL below)

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.wa_sessions;
```

## 5. Use in your Next.js settings page

```tsx
import { WhatsAppConnect } from '@/components/WhatsAppConnect'

// Inside your settings page server component:
const { data: { user } } = await supabase.auth.getUser()

// Pass agentId to the client component
<WhatsAppConnect agentId={user.id} />
```

## 6. Use WhatsApp send in communications

```tsx
import { WhatsAppSendButton } from '@/components/WhatsAppSendButton'

<WhatsAppSendButton
  leadId={lead.id}
  phone={lead.phone}
  onSent={(messageId) => console.log('Sent:', messageId)}
/>
```

## Flow recap

1. Agent clicks "Connect WhatsApp" → POST `/api/whatsapp/connect`
2. Baileys service generates QR → saves data URL to `wa_sessions.qr_code`
3. Supabase Realtime pushes the update → `WhatsAppConnect` renders QR image
4. Agent scans with phone → Baileys fires `connection.update: open`
5. Session saved to `wa_sessions.creds/keys`, status → `connected`
6. Realtime update → UI switches to "connected" state
7. Incoming messages → saved to `communications` automatically
8. Agent clicks send → POST `/api/whatsapp/send` → Baileys delivers message → logged to `communications`
