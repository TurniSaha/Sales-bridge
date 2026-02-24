# Sales Bridge — Context Document

## What This App Does
HeyReach (LinkedIn automation) sends webhook events when a LinkedIn message is sent to a prospect. Sales Bridge queues those prospects and pushes them to Mailshake (email campaigns) after a configurable delay, creating a multi-channel outreach flow: LinkedIn first, then email follow-up.

## Architecture
- **Runtime**: Node.js + Express, deployed on OVHCloud VPS via Coolify
- **Database**: SQLite (better-sqlite3) at `/app/data/prospects.db`
- **Cron**: Every 5 minutes, checks for pending prospects past their `send_at` time and pushes to Mailshake
- **Mailshake API**: Uses Basic Auth, `recipients/add` endpoint

## Production Details
- **VPS IP**: `149.56.102.112` (Ubuntu, user: `ubuntu`)
- **App URL**: `http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io`
- **Webhook URL (configured in HeyReach)**: `http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io/webhook/heyreach`
- **Coolify**: Auto-deploys from `main` branch on push
- **Container**: Name pattern `jkkk04cc4gs4k8okw8kcssss-*` (changes on each deploy)
- **SSH access**: `ssh ubuntu@149.56.102.112`
- **Docker logs**: `sudo docker logs <container-name>`
- **Find container**: `sudo docker ps --format '{{.Names}}' | grep jkkk`

## Environment Variables (set in Coolify)
- `MAILSHAKE_API_KEY`: `0be69552-9882-4318-a43c-cff65de0070b`
- `MAILSHAKE_CAMPAIGN_ID`: `1499122` (campaign: "General_Default")
- `DELAY_HOURS`: `48` (time between LinkedIn touch and email send)
- `DB_PATH`: `/app/data/prospects.db`
- `PORT`: `3000`

## Key Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check, returns uptime |
| `/status` | GET | Counts of pending/sent/failed prospects |
| `/webhook/heyreach` | POST | Receives HeyReach webhook events |
| `/leads/load` | POST | Bulk-load lead list `{ leads: [...] }` |
| `/leads/count` | GET | Count of leads in lookup table |
| `/routing/load` | POST | Load routing data for multi-campaign |
| `/routing/stats` | GET | Routing stats by pain_profile |

## Database Tables

### `prospects` — Queue of contacts to send to Mailshake
| Column | Purpose |
|--------|---------|
| `email` | UNIQUE, prospect email |
| `first_name`, `last_name` | Prospect name |
| `status` | `pending` → `sent` or `failed` |
| `send_at` | When to push to Mailshake (UTC) |
| `attempts` | Retry count (max 3) |
| `campaign_id` | Mailshake campaign to add to |
| `company` | Company name for Mailshake merge fields |

### `leads` — Lookup table for resolving HeyReach contacts
| Column | Purpose |
|--------|---------|
| `email` | UNIQUE, from lead list CSV |
| `first_name`, `last_name` | For name-based matching |
| `linkedin_url` | For LinkedIn URL matching (indexed) |
| `company` | Company name |
| `pain_profile` | Campaign routing category |

### `routing` — Pain profile → campaign mapping
Used for multi-campaign routing. Currently not actively used (single campaign).

## Lead List
- **Source CSV**: `/Users/turni.saha/Desktop/AI Outbound Engine/NEW HIRES/Lead Lists/Top_400_MultiTouch.csv`
- **400 leads** loaded into the `leads` table on production (2026-02-23)
- Fields: First_Name, Last_Name, Company, Job_Title, LinkedIn_Profile_URL, Work_Email, Pain_Profile, etc.

## How the Webhook Handler Works (as of 2026-02-23)
1. Receives POST from HeyReach
2. Tries to extract email from multiple possible payload locations: `body.prospect.email`, `body.email`, `body.emailAddress`
3. **If no email found**: looks up the leads table by LinkedIn URL, then by full name, then by first name only
4. Resolves company from payload or leads table
5. Inserts into `prospects` table with `status='pending'` and `send_at` = now + DELAY_HOURS
6. Cron picks it up when `send_at` passes and pushes to Mailshake

## Known Issues & Investigation History (2026-02-23)

### Problem: HeyReach webhooks arrive but fail with "Missing prospect email"
- **Root cause**: HeyReach sends data under `body.lead.*` not `body.prospect.*`. Original server only checked `body.prospect.email`.
- **Fix applied (2026-02-23)**: Updated webhook handler to check `body.lead.email_address`, `body.lead.first_name`, `body.lead.profile_url`, `body.lead.company_name` first. Also falls back to leads table lookup by LinkedIn URL or name.
- **Confirmed HeyReach payload format** (captured from real webhook):
  ```
  body.lead.email_address    — prospect's email
  body.lead.custom_email     — alternate email field
  body.lead.first_name       — first name
  body.lead.last_name        — last name
  body.lead.full_name        — full name
  body.lead.profile_url      — LinkedIn URL (no trailing slash)
  body.lead.company_name     — company (may be null)
  body.lead.position         — job title (may be null)
  body.event_type            — e.g. "message_sent"
  body.campaign.name         — HeyReach campaign name
  body.campaign.id           — HeyReach campaign ID
  body.sender.full_name      — sender name
  ```

### Problem: Coolify proxy was down ("Proxy Exited")
- **Impact**: No traffic reached the app at all while proxy was down
- **Fix**: Manually clicked "Start Proxy" in Coolify dashboard
- **Note**: If webhooks stop working again, check Coolify → Server → proxy status first

### Problem: Database wiped on every deploy
- **Root cause**: No persistent volume was configured — SQLite file lived inside the container
- **Fix**: Added persistent volume in Coolify: `sales-bridge-data` → `/app/data`
- **Verified**: Volume mount confirmed via `docker inspect`

### Manually pushed contacts (2026-02-23)
These 11 contacts were pushed directly to Mailshake API (campaign 1499122) because the webhook pipeline wasn't working:

1. Michael Rhodes — mike@abelconstruct.com — ABEL Construction Company
2. Parwiz Paiman — parwiz.paiman@hourigan.group — Hourigan
3. Joanie Scaff — joanie@3binspection.com — 3B Inspection
4. Scott A. Young — syoung@keeleyconstruction.com — Keeley Construction Group
5. Sean Putz — sean.putz@buildgc.com — Build Group
6. Dustin Morfe — dustinm@ppmechanical.com — Pan-Pacific Mechanical
7. Nicole Lawler — nicole.lawler@marr.com.au — Marr Contracting
8. Christian Giambrone — cgiambrone@barnhillcontracting.com — Barnhill
9. John Ven Huizen — johnh@christiansonco.com — Christianson Air Conditioning & Plumbing
10. Bryan McCreary — bmccreary@united-civil.com — United Civil
11. Eric Karcher — eric@patrioterectors.com — Patriot Erectors

## If Webhooks Still Don't Work — Debugging Playbook

### Step 1: Check proxy is running
Coolify dashboard → Server → look for green status. If "Proxy Exited", click "Start Proxy".

### Step 2: Check app is reachable
```bash
curl http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io/health
```

### Step 3: Check recent logs for webhook attempts
```bash
ssh ubuntu@149.56.102.112
sudo docker ps --format '{{.Names}}' | grep jkkk
sudo docker logs --since 30m <container-name> | grep -i webhook
```

### Step 4: Look at raw payload
Logs now include `rawBody` on every webhook hit. Search for it:
```bash
sudo docker logs <container-name> | grep rawBody
```
This shows exactly what HeyReach sends. Use that to fix the field mappings in the webhook handler.

### Step 5: Check leads table is populated
```bash
curl http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io/leads/count
```
If 0, reload from CSV using the `/leads/load` endpoint. The Python script to convert CSV to JSON is:
```python
import csv, json
leads = []
with open('Top_400_MultiTouch.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        leads.append({
            'first_name': row.get('First_Name', ''),
            'last_name': row.get('Last_Name', ''),
            'email': row.get('Work_Email', ''),
            'company': row.get('Company', ''),
            'linkedin_url': row.get('LinkedIn_Profile_URL', ''),
            'pain_profile': row.get('Pain_Profile', ''),
        })
with open('/tmp/leads_payload.json', 'w') as f:
    json.dump({'leads': leads}, f)
```
Then: `curl -X POST <app-url>/leads/load -H "Content-Type: application/json" -d @/tmp/leads_payload.json`

### Step 6: Test the webhook manually
```bash
curl -X POST <app-url>/webhook/heyreach \
  -H "Content-Type: application/json" \
  -d '{"event":"message_sent","prospect":{"email":"test@example.com","firstName":"Test","lastName":"User"}}'
```

### Step 7: If leads table lookup isn't matching
Check if LinkedIn URLs in HeyReach match what's in the CSV. Common mismatches:
- Trailing slash differences (`/in/john/` vs `/in/john`)
- HTTP vs HTTPS
- Mobile URLs vs desktop URLs

### Step 8: Nuclear option — push to Mailshake directly
```bash
MAILSHAKE_AUTH=$(echo -n "0be69552-9882-4318-a43c-cff65de0070b:" | base64)
curl -X POST "https://api.mailshake.com/2017-04-01/recipients/add" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic ${MAILSHAKE_AUTH}" \
  -d '{"campaignID":1499122,"addAsNewList":false,"addresses":[{"emailAddress":"person@example.com","fullName":"First Last","fields":{"first":"First","last":"Last","company":"Company","linkedin":"https://linkedin.com/in/..."}}]}'
```

## Pipeline Verification (2026-02-24)
- **Pipeline confirmed working**: Real HeyReach webhooks are being received and processed correctly after the payload fix
- **Status as of 2026-02-24**: 2 pending (Armando, Anjelica), 3 sent, 0 failed
- **Webhook payloads**: Emails extracted correctly from `body.lead.email_address`

### Prospects currently pending (scheduled for 48hr delay):
- **Armando GSP** — `armando@solaris-energy.com` — sends 2026-02-26 ~14:43 UTC
- **Anjelica STS-C** — `anjelicam@ppmechanical.com` — sends 2026-02-26 ~15:35 UTC

### Duplicate prevention fix (2026-02-24)
Scott Young (`syoung@keeleyconstruction.com`) and Joanie Scaff (`joanie@3binspection.com`) were manually pushed to Mailshake on 2026-02-23, but the webhook also picked them up and created `pending` entries. Manually set their status to `sent` in SQLite to prevent duplicate adds to Mailshake.

## What Still Needs to Happen
1. **Consider adding HTTPS** — currently HTTP only, some webhook providers prefer HTTPS
2. **Monitor** — check `/status` periodically to confirm pending → sent flow is working
3. **Duplicate detection** — consider adding logic to check Mailshake before adding, to prevent duplicates automatically
