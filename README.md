# Sales Bridge

A Node.js bridge that connects **HeyReach** (LinkedIn outreach) to **Mailshake** (email sequences). When a LinkedIn message is sent via HeyReach, this bridge automatically adds the prospect to a Mailshake email campaign after a configurable delay.

## Architecture

```
HeyReach Campaign (LinkedIn)
    |
    v
Dan sends LinkedIn message to prospect
    |
    v
HeyReach fires "Message Sent" webhook
    |
    v
Sales Bridge receives webhook (POST /webhook/heyreach)
    |
    v
Stores prospect in SQLite with 3-day delay
    |
    v
Cron job (every 5 min) checks for due prospects
    |
    v
Calls Mailshake API to add prospect to email campaign
    |
    v
Prospect receives email sequence in Mailshake
```

## Current Setup

| Component | Details |
|-----------|---------|
| **HeyReach Campaign** | "NEW HIRES TOP 400" — LinkedIn outreach via Dan MacDonald (Sales Navigator) |
| **HeyReach Webhook** | "Mailshake Bridge" — fires on "Message Sent" for the active campaign |
| **Bridge Server** | Deployed on OVHcloud VPS (149.56.102.112) via Coolify |
| **Bridge URL** | http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io |
| **Mailshake Campaign** | "New Hires - Email Follow-up" (ID: 1498804) — Scott McLeod sender |
| **Delay** | 3 days (72 hours) after LinkedIn message sent |

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check — returns `{"status":"ok","uptime":...}` |
| `/status` | GET | Shows counts: `{"pending":0,"sent":0,"failed":0}` |
| `/webhook/heyreach` | POST | Receives HeyReach webhook payloads |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAILSHAKE_API_KEY` | Mailshake API key (Basic Auth) | *required* |
| `MAILSHAKE_CAMPAIGN_ID` | Mailshake campaign ID to add recipients to | *required* |
| `PORT` | Server port | `3000` |
| `DB_PATH` | Path to SQLite database file | `./prospects.db` |
| `DELAY_HOURS` | Hours to wait before adding to Mailshake | `72` |

## Deployment

### Coolify (Current)
The app is deployed via Coolify on OVHcloud VPS:
- **Coolify Dashboard**: http://149.56.102.112:8000
- **VPS**: 149.56.102.112 (Ubuntu 25.04, 6 vCores, 12GB RAM)
- **Method**: Public GitHub repo → Dockerfile build
- Coolify handles Docker builds, reverse proxy (Traefik), and container management

### Manual Docker
```bash
docker build -t sales-bridge .
docker run -d \
  -e MAILSHAKE_API_KEY=your-key \
  -e MAILSHAKE_CAMPAIGN_ID=1498804 \
  -e DB_PATH=/app/data/prospects.db \
  -e DELAY_HOURS=72 \
  -p 3000:3000 \
  -v sales-bridge-data:/app/data \
  sales-bridge
```

### Local Development
```bash
cp .env.example .env
# Edit .env with your actual values
npm install
npm start
```

## Key Design Decisions

- **SQLite** for persistence — survives restarts, no external DB needed
- **Cron every 5 minutes** — checks for prospects whose delay has elapsed
- **Dedup on email** — UNIQUE constraint prevents double-adding
- **Retry logic** — up to 3 attempts before marking as failed
- **Raw payload storage** — every webhook payload is stored for debugging
- **Basic Auth** for Mailshake API (not query param)
- **Pino** for structured JSON logging
- **Graceful shutdown** — handles SIGTERM/SIGINT to close DB cleanly

## Mailshake Sending Accounts

| Persona | Domains |
|---------|---------|
| Jon Herrera | getbistrainining.com, trybistrainining.com, trybistraining.com, getbissafety.com |
| Scott McLeod | getbistrainining.com, trybistrainining.com, trybistraining.com, getbissafety.com |
| Christopher Lessard | getbistrainining.com, trybistrainining.com, trybistraining.com, getbissafety.com |

## Changing the HeyReach Campaign

If you create a new campaign in HeyReach:
1. Go to HeyReach → Settings → Integrations → Webhooks
2. Edit the "Mailshake Bridge" webhook
3. Change the campaign selection to your new campaign
4. Save

The bridge script doesn't care which campaign fires — it processes any webhook it receives.

## Monitoring

- **Health**: `curl http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io/health`
- **Status**: `curl http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io/status`
- **Logs**: Coolify Dashboard → Logs tab, or `ssh ubuntu@149.56.102.112` → `sudo docker logs <container>`
