require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const pino = require('pino');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAILSHAKE_API_KEY = process.env.MAILSHAKE_API_KEY;
const MAILSHAKE_CAMPAIGN_ID = process.env.MAILSHAKE_CAMPAIGN_ID;
const DELAY_HOURS = Number(process.env.DELAY_HOURS) || 48;
const MAILSHAKE_BASE_URL = 'https://api.mailshake.com/2017-04-01';
const MAX_ATTEMPTS = 3;

const log = pino({ level: 'info' });

// ---------------------------------------------------------------------------
// Mailshake auth header (Basic Auth)
// ---------------------------------------------------------------------------
const MAILSHAKE_AUTH = `Basic ${Buffer.from(MAILSHAKE_API_KEY + ':').toString('base64')}`;

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
const dbPath = process.env.DB_PATH || path.join(__dirname, 'prospects.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS prospects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    linkedin_url TEXT,
    heyreach_campaign_id TEXT,
    heyreach_campaign_name TEXT,
    raw_payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    send_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT,
    error TEXT
  )
`);

const insertProspect = db.prepare(`
  INSERT INTO prospects (first_name, last_name, email, linkedin_url,
                         heyreach_campaign_id, heyreach_campaign_name,
                         raw_payload, send_at)
  VALUES (@first_name, @last_name, @email, @linkedin_url,
          @heyreach_campaign_id, @heyreach_campaign_name,
          @raw_payload, @send_at)
`);

const getDueProspects = db.prepare(`
  SELECT * FROM prospects
  WHERE status = 'pending' AND send_at <= datetime('now')
`);

const incrementAttempts = db.prepare(`
  UPDATE prospects SET attempts = attempts + 1 WHERE id = ?
`);

const markSent = db.prepare(`
  UPDATE prospects SET status = 'sent', sent_at = datetime('now') WHERE id = ?
`);

const markFailed = db.prepare(`
  UPDATE prospects SET status = 'failed', error = ? WHERE id = ?
`);

const countByStatus = db.prepare(`
  SELECT status, COUNT(*) as count FROM prospects GROUP BY status
`);

// ---------------------------------------------------------------------------
// Helper: sleep
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/status', (_req, res) => {
  const rows = countByStatus.all();
  const counts = { pending: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  res.json(counts);
});

app.post('/webhook/heyreach', (req, res) => {
  const body = req.body;
  log.info({ event: body.event, email: body.prospect?.email }, 'Webhook received');

  const prospect = body.prospect;
  if (!prospect || !prospect.email) {
    log.warn('Missing prospect email in webhook payload');
    return res.status(400).json({ error: 'Missing prospect email' });
  }

  const sendAt = new Date(Date.now() + DELAY_HOURS * 60 * 60 * 1000).toISOString();

  try {
    insertProspect.run({
      first_name: prospect.firstName || '',
      last_name: prospect.lastName || '',
      email: prospect.email,
      linkedin_url: prospect.linkedinUrl || null,
      heyreach_campaign_id: body.campaign?.id || null,
      heyreach_campaign_name: body.campaign?.name || null,
      raw_payload: JSON.stringify(body),
      send_at: sendAt,
    });
    log.info({ email: prospect.email, send_at: sendAt }, 'Prospect stored');
    return res.json({ accepted: true, send_at: sendAt });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      log.info({ email: prospect.email }, 'Duplicate prospect skipped');
      return res.json({ accepted: false, reason: 'duplicate' });
    }
    log.error({ error: err.message }, 'Failed to store prospect');
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// Mailshake integration
// ---------------------------------------------------------------------------
async function pollAddStatus(checkStatusID) {
  const url = `${MAILSHAKE_BASE_URL}/recipients/add-status`;
  for (let i = 0; i < 5; i++) {
    await sleep(30_000);
    log.info({ checkStatusID, poll: i + 1 }, 'Polling Mailshake add-status');
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: MAILSHAKE_AUTH,
      },
      body: JSON.stringify({ checkStatusID }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      log.warn({ checkStatusID, status: resp.status, data }, 'add-status poll error');
      continue;
    }
    log.info({ checkStatusID, data }, 'add-status poll result');
    if (data.results && data.results.isFinished) {
      return data;
    }
  }
  log.warn({ checkStatusID }, 'add-status polling exhausted after 5 attempts');
  return null;
}

async function addRecipientToMailshake(prospect) {
  const url = `${MAILSHAKE_BASE_URL}/recipients/add`;
  const payload = {
    campaignID: Number(MAILSHAKE_CAMPAIGN_ID),
    addAsNewList: false,
    addresses: [
      {
        emailAddress: prospect.email,
        fullName: `${prospect.first_name} ${prospect.last_name}`.trim(),
        fields: {
          first: prospect.first_name,
          last: prospect.last_name,
          linkedin: prospect.linkedin_url || '',
        },
      },
    ],
  };

  log.info({ email: prospect.email, campaignId: MAILSHAKE_CAMPAIGN_ID }, 'Calling Mailshake recipients/add');

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: MAILSHAKE_AUTH,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Mailshake API error ${resp.status}: ${JSON.stringify(data)}`);
  }

  log.info({ email: prospect.email, response: data }, 'Mailshake recipients/add success');

  if (data.results && data.results.checkStatusID) {
    await pollAddStatus(data.results.checkStatusID);
  }

  return data;
}

async function processDueProspects() {
  const prospects = getDueProspects.all();
  if (prospects.length === 0) return;

  log.info({ count: prospects.length }, 'Processing due prospects');

  for (const prospect of prospects) {
    incrementAttempts.run(prospect.id);
    const currentAttempt = prospect.attempts + 1;

    try {
      await addRecipientToMailshake(prospect);
      markSent.run(prospect.id);
      log.info({ id: prospect.id, email: prospect.email }, 'Prospect sent to Mailshake');
    } catch (err) {
      if (currentAttempt >= MAX_ATTEMPTS) {
        markFailed.run(err.message, prospect.id);
        log.error({ id: prospect.id, email: prospect.email, attempt: currentAttempt, error: err.message },
          'Prospect failed permanently after max attempts');
      } else {
        log.warn({ id: prospect.id, email: prospect.email, attempt: currentAttempt, error: err.message },
          'Prospect attempt failed, will retry');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Startup validation: verify Mailshake API key and campaign
// ---------------------------------------------------------------------------
async function validateMailshakeConfig() {
  const url = `${MAILSHAKE_BASE_URL}/campaigns/list`;
  log.info('Validating Mailshake API key and campaign ID...');

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: MAILSHAKE_AUTH,
      },
      body: JSON.stringify({}),
    });

    if (!resp.ok) {
      log.error({ status: resp.status }, 'Mailshake API key validation FAILED -- check MAILSHAKE_API_KEY');
      return;
    }

    const data = await resp.json();
    const campaigns = data.results || [];
    const match = campaigns.find((c) => c.id === Number(MAILSHAKE_CAMPAIGN_ID));

    if (match) {
      log.info({ campaignId: MAILSHAKE_CAMPAIGN_ID, campaignTitle: match.title }, 'Mailshake campaign verified');
    } else {
      log.warn({ campaignId: MAILSHAKE_CAMPAIGN_ID, availableCampaigns: campaigns.map((c) => ({ id: c.id, title: c.title })) },
        'Mailshake campaign ID not found in account -- check MAILSHAKE_CAMPAIGN_ID');
    }
  } catch (err) {
    log.error({ error: err.message }, 'Mailshake startup validation failed -- network error');
  }
}

// ---------------------------------------------------------------------------
// Cron: run every 5 minutes
// ---------------------------------------------------------------------------
cron.schedule('*/5 * * * *', () => {
  log.info('Cron job triggered: checking for due prospects');
  processDueProspects().catch((err) => {
    log.error({ error: err.message }, 'Cron job failed');
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down gracefully');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT received, shutting down gracefully');
  db.close();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  log.info({ port: PORT, delayHours: DELAY_HOURS, dbPath }, 'Sales bridge started');
  await validateMailshakeConfig();
});
