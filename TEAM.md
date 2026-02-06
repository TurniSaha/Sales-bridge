# Sales Integration Team

## Overview
This is a multi-agent team that manages the HeyReach → Mailshake sales outreach pipeline. The team automates LinkedIn outreach (HeyReach) followed by email sequences (Mailshake) with a configurable delay.

## Pipeline Flow
```
HeyReach (LinkedIn)          Bridge Server              Mailshake (Email)
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
│ Dan MacDonald    │    │ OVHcloud VPS         │    │ Scott McLeod sender │
│ sends LinkedIn   │───>│ receives webhook     │───>│ adds prospect to    │
│ message          │    │ waits 3 days         │    │ email campaign      │
│                  │    │ calls Mailshake API  │    │                     │
└─────────────────┘    └──────────────────────┘    └─────────────────────┘
```

## Agents

| Agent | Type | Role | File |
|-------|------|------|------|
| **heyreach-scout** | Browser automation | Operates HeyReach UI — campaigns, webhooks, settings | [agents/heyreach-scout.md](agents/heyreach-scout.md) |
| **mailshake-scout** | Browser automation | Operates Mailshake UI — campaigns, API keys, sequences | [agents/mailshake-scout.md](agents/mailshake-scout.md) |
| **script-writer** | Node.js developer | Writes and maintains the bridge application code | [agents/script-writer.md](agents/script-writer.md) |
| **planner** | Architect | Researches APIs, reviews code, designs integration plans | [agents/planner.md](agents/planner.md) |
| **coolify-agent** | DevOps | Manages Coolify and Docker deployments on OVHcloud | [agents/coolify-agent.md](agents/coolify-agent.md) |
| **server-admin** | Infrastructure | Backup for server-level issues (firewall, DNS, packages) | [agents/server-admin.md](agents/server-admin.md) |

## Quick Start: Spin Up the Team

### 1. Create the team
```
Use Teammate tool: spawnTeam with team_name="sales-integration"
```

### 2. Launch agents as needed
Each agent MD file contains a "Spin-Up Prompt" section. Use the Task tool with:
- `subagent_type: "general-purpose"`
- `team_name: "sales-integration"`
- `name: "<agent-name>"`
- Copy the spin-up prompt from the agent's MD file

### 3. Prerequisites
- User must be **logged into HeyReach** (app.heyreach.io) and **Mailshake** (app.mailshake.com) in the browser for scout agents
- **Chrome DevTools MCP** server must be running for browser automation
- **SSH key** must be set up for VPS access (already configured for ubuntu@149.56.102.112)

## Infrastructure

| Resource | URL / Access |
|----------|-------------|
| **Bridge Server** | http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io |
| **Health Check** | GET /health |
| **Status** | GET /status |
| **Coolify Dashboard** | http://149.56.102.112:8000 |
| **VPS SSH** | `ssh ubuntu@149.56.102.112` |
| **GitHub Repo** | https://github.com/TurniSaha/Sales-bridge |
| **HeyReach** | https://app.heyreach.io |
| **Mailshake** | https://app.mailshake.com |

## Common Operations

### Change the active HeyReach campaign
Spin up `heyreach-scout` and tell it to update the "Mailshake Bridge" webhook to the new campaign name.

### Change the delay
Edit `DELAY_HOURS` in Coolify environment variables, then redeploy. Or edit `server.js` line 15, push to GitHub, and redeploy.

### Change the Mailshake campaign
Update `MAILSHAKE_CAMPAIGN_ID` in Coolify environment variables and redeploy.

### Check pipeline status
```bash
curl http://jkkk04cc4gs4k8okw8kcssss.149.56.102.112.sslip.io/status
# Returns: {"pending":N,"sent":N,"failed":N}
```

### View logs
Go to Coolify Dashboard → sales bridge app → Logs tab. Or:
```bash
ssh ubuntu@149.56.102.112 "sudo docker logs <container-id> --tail 100"
```

## Account Details

| Platform | Account | Owner |
|----------|---------|-------|
| **HeyReach** | BIS Safety Software | turni.saha@bistraining.ca |
| **Mailshake** | Turni Saha's Team (ID: 123305) | turni.saha@bistraining.ca |
| **OVHcloud** | VPS vps-f21ca92f.vps.ovh.ca | turni.saha |
| **GitHub** | TurniSaha/Sales-bridge | TurniSaha |

## History

### Build Timeline
1. Scouted both platforms (HeyReach + Mailshake)
2. Planner designed full architecture with API research
3. Script-writer built the bridge app (Node.js + Express + SQLite)
4. Planner reviewed code — found 8 issues + 6 missing features
5. Script-writer applied all fixes
6. Coolify agent installed Coolify on OVHcloud VPS
7. Deployed via Coolify from GitHub repo
8. Fixed crash (missing /app/data directory for SQLite)
9. HeyReach scout configured webhook (Message Sent → bridge)
10. Updated through 3 campaign iterations (New Hires → NEW HIRES FINAL → NEW HIRES TOP 400)
11. Changed delay from 2 days to 3 days (72 hours)
