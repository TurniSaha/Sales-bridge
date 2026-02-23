require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAILSHAKE_API_KEY = process.env.MAILSHAKE_API_KEY;
const MAILSHAKE_CAMPAIGN_ID = process.env.MAILSHAKE_CAMPAIGN_ID;
const DELAY_HOURS = process.env.DELAY_HOURS !== undefined ? Number(process.env.DELAY_HOURS) : 72;
const MAILSHAKE_BASE_URL = 'https://api.mailshake.com/2017-04-01';
const MAX_ATTEMPTS = 3;

const log = pino({ level: 'info' });

// ---------------------------------------------------------------------------
// Campaign routing config (pain_profile -> campaign_id)
// ---------------------------------------------------------------------------
let campaignRouting = null;
if (process.env.CAMPAIGN_ROUTING) {
  try {
    campaignRouting = JSON.parse(process.env.CAMPAIGN_ROUTING);
    log.info({ profiles: Object.keys(campaignRouting) }, 'Campaign routing loaded from env');
  } catch (err) {
    log.error({ error: err.message }, 'Failed to parse CAMPAIGN_ROUTING env var');
  }
} else {
  const routingFilePath = path.join(__dirname, 'campaign_routing.json');
  if (fs.existsSync(routingFilePath)) {
    try {
      campaignRouting = JSON.parse(fs.readFileSync(routingFilePath, 'utf8'));
      log.info({ profiles: Object.keys(campaignRouting) }, 'Campaign routing loaded from file');
    } catch (err) {
      log.error({ error: err.message }, 'Failed to parse campaign_routing.json');
    }
  }
}

// ---------------------------------------------------------------------------
// Mailshake auth header (Basic Auth)
// ---------------------------------------------------------------------------
const MAILSHAKE_AUTH = `Basic ${Buffer.from(MAILSHAKE_API_KEY + ':').toString('base64')}`;

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
const dbPath = process.env.DB_PATH || path.join(__dirname, 'prospects.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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

// Migrate: add campaign_id column if it doesn't exist yet
try {
  db.exec(`ALTER TABLE prospects ADD COLUMN campaign_id INTEGER`);
  log.info('Added campaign_id column to prospects table');
} catch (err) {
  // Column already exists -- safe to ignore
}

// Migrate: add company column if it doesn't exist yet
try {
  db.exec(`ALTER TABLE prospects ADD COLUMN company TEXT`);
  log.info('Added company column to prospects table');
} catch (err) {
  // Column already exists -- safe to ignore
}

// ---------------------------------------------------------------------------
// Leads table (lookup by name/linkedin to resolve email + company)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    company TEXT,
    linkedin_url TEXT,
    pain_profile TEXT
  )
`);

// Migrate: add unique index on linkedin_url if not present
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_linkedin ON leads(linkedin_url) WHERE linkedin_url IS NOT NULL AND linkedin_url != ''`);
} catch (err) { /* safe to ignore */ }

const lookupLeadByLinkedin = db.prepare(`
  SELECT * FROM leads WHERE linkedin_url = ? LIMIT 1
`);

const lookupLeadByName = db.prepare(`
  SELECT * FROM leads WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) LIMIT 1
`);

const lookupLeadByFirstName = db.prepare(`
  SELECT * FROM leads WHERE LOWER(first_name) = LOWER(?) LIMIT 1
`);

const upsertLead = db.prepare(`
  INSERT INTO leads (first_name, last_name, email, company, linkedin_url, pain_profile)
  VALUES (@first_name, @last_name, @email, @company, @linkedin_url, @pain_profile)
  ON CONFLICT(email) DO UPDATE SET
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    company = excluded.company,
    linkedin_url = excluded.linkedin_url,
    pain_profile = excluded.pain_profile
`);

// ---------------------------------------------------------------------------
// Routing table (email -> pain_profile for campaign selection)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS routing (
    email TEXT PRIMARY KEY,
    pain_profile TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    company TEXT
  )
`);

const lookupRouting = db.prepare(`
  SELECT pain_profile, company FROM routing WHERE email = ?
`);

const upsertRouting = db.prepare(`
  INSERT INTO routing (email, pain_profile, first_name, last_name, company)
  VALUES (@email, @pain_profile, @first_name, @last_name, @company)
  ON CONFLICT(email) DO UPDATE SET
    pain_profile = excluded.pain_profile,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    company = excluded.company
`);

const routingStats = db.prepare(`
  SELECT pain_profile, COUNT(*) as count FROM routing GROUP BY pain_profile
`);

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------
const insertProspect = db.prepare(`
  INSERT INTO prospects (first_name, last_name, email, linkedin_url,
                         heyreach_campaign_id, heyreach_campaign_name,
                         raw_payload, send_at, campaign_id, company)
  VALUES (@first_name, @last_name, @email, @linkedin_url,
          @heyreach_campaign_id, @heyreach_campaign_name,
          @raw_payload, @send_at, @campaign_id, @company)
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
// Helper: resolve campaign_id for an email
// ---------------------------------------------------------------------------
function resolveRouting(email) {
  const row = lookupRouting.get(email);
  if (!row) return { campaignId: null, company: null };
  const campaignId = campaignRouting ? (campaignRouting[row.pain_profile] || null) : null;
  if (campaignId) {
    log.info({ email, pain_profile: row.pain_profile, campaignId }, 'Resolved campaign from routing');
  }
  return { campaignId, company: row.company || null };
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
  log.info({ rawBody: JSON.stringify(body) }, 'Webhook received');

  // Normalize: extract prospect data from multiple possible payload formats
  // HeyReach actual format uses body.lead.* (confirmed 2026-02-23)
  let firstName = body.lead?.first_name || body.prospect?.firstName || body.firstName || body.first_name || '';
  let lastName = body.lead?.last_name || body.prospect?.lastName || body.lastName || body.last_name || '';
  let email = body.lead?.email_address || body.lead?.custom_email || body.lead?.enriched_email || body.prospect?.email || body.email || body.emailAddress || '';
  let linkedinUrl = body.lead?.profile_url || body.prospect?.linkedinUrl || body.linkedinUrl || body.linkedin_url || '';
  let companyName = body.lead?.company_name || body.prospect?.companyName || body.prospect?.company || body.companyName || body.company || '';

  // If no email, try to resolve from leads table
  if (!email) {
    let lead = null;

    // Try LinkedIn URL first (most reliable match)
    if (linkedinUrl) {
      // Normalize LinkedIn URL for matching (strip trailing slash)
      const normalizedUrl = linkedinUrl.replace(/\/$/, '');
      lead = lookupLeadByLinkedin.get(normalizedUrl) || lookupLeadByLinkedin.get(normalizedUrl + '/') || lookupLeadByLinkedin.get(linkedinUrl);
    }

    // Fall back to name match
    if (!lead && firstName && lastName) {
      lead = lookupLeadByName.get(firstName, lastName);
    }

    // Fall back to first name only (less reliable but better than dropping)
    if (!lead && firstName && !lastName) {
      lead = lookupLeadByFirstName.get(firstName);
    }

    if (lead) {
      log.info({ firstName, lastName, linkedinUrl, resolvedEmail: lead.email }, 'Resolved prospect from leads table');
      email = lead.email;
      if (!companyName) companyName = lead.company || '';
      if (!firstName) firstName = lead.first_name || '';
      if (!lastName) lastName = lead.last_name || '';
      if (!linkedinUrl) linkedinUrl = lead.linkedin_url || '';
    }
  }

  if (!email) {
    log.warn({ rawBody: JSON.stringify(body), firstName, lastName, linkedinUrl }, 'Could not resolve prospect email');
    return res.status(400).json({ error: 'Could not resolve prospect email' });
  }

  const sendAt = new Date(Date.now() + DELAY_HOURS * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '');

  // Resolve campaign_id and company from routing table
  const routing = resolveRouting(email);
  const campaignId = routing.campaignId
    ? Number(routing.campaignId)
    : (MAILSHAKE_CAMPAIGN_ID ? Number(MAILSHAKE_CAMPAIGN_ID) : null);
  const company = companyName || routing.company || '';

  try {
    insertProspect.run({
      first_name: firstName,
      last_name: lastName,
      email: email,
      linkedin_url: linkedinUrl || null,
      heyreach_campaign_id: body.campaign?.id || null,
      heyreach_campaign_name: body.campaign?.name || null,
      raw_payload: JSON.stringify(body),
      send_at: sendAt,
      campaign_id: campaignId,
      company: company,
    });
    log.info({ email, send_at: sendAt, campaign_id: campaignId, company }, 'Prospect stored');
    return res.json({ accepted: true, send_at: sendAt, campaign_id: campaignId, company });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      log.info({ email }, 'Duplicate prospect skipped');
      return res.json({ accepted: false, reason: 'duplicate' });
    }
    log.error({ error: err.message }, 'Failed to store prospect');
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// Leads management endpoints
// ---------------------------------------------------------------------------
app.post('/leads/load', (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads)) {
    return res.status(400).json({ error: 'Expected { leads: [...] }' });
  }

  const insertMany = db.transaction((items) => {
    let inserted = 0;
    for (const item of items) {
      if (!item.email) continue;
      upsertLead.run({
        first_name: item.first_name || '',
        last_name: item.last_name || '',
        email: item.email,
        company: item.company || null,
        linkedin_url: item.linkedin_url || null,
        pain_profile: item.pain_profile || null,
      });
      inserted++;
    }
    return inserted;
  });

  try {
    const count = insertMany(leads);
    log.info({ count }, 'Leads loaded');
    return res.json({ loaded: count });
  } catch (err) {
    log.error({ error: err.message }, 'Failed to load leads');
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/leads/count', (_req, res) => {
  const row = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  res.json({ count: row.count });
});

// ---------------------------------------------------------------------------
// Routing management endpoints
// ---------------------------------------------------------------------------
app.post('/routing/load', (req, res) => {
  const { routes } = req.body;
  if (!Array.isArray(routes)) {
    return res.status(400).json({ error: 'Expected { routes: [...] }' });
  }

  const insertMany = db.transaction((items) => {
    let inserted = 0;
    for (const item of items) {
      if (!item.email || !item.pain_profile) continue;
      upsertRouting.run({
        email: item.email,
        pain_profile: item.pain_profile,
        first_name: item.first_name || null,
        last_name: item.last_name || null,
        company: item.company || null,
      });
      inserted++;
    }
    return inserted;
  });

  try {
    const count = insertMany(routes);
    log.info({ count }, 'Routing data loaded');
    return res.json({ loaded: count });
  } catch (err) {
    log.error({ error: err.message }, 'Failed to load routing data');
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/routing/stats', (_req, res) => {
  const rows = routingStats.all();
  const stats = {};
  for (const row of rows) {
    stats[row.pain_profile] = row.count;
  }
  res.json(stats);
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

async function addRecipientToMailshake(prospect, campaignId) {
  const effectiveCampaignId = campaignId || Number(MAILSHAKE_CAMPAIGN_ID);
  const url = `${MAILSHAKE_BASE_URL}/recipients/add`;
  const payload = {
    campaignID: effectiveCampaignId,
    addAsNewList: false,
    addresses: [
      {
        emailAddress: prospect.email,
        fullName: `${prospect.first_name} ${prospect.last_name}`.trim(),
        fields: {
          first: prospect.first_name,
          last: prospect.last_name,
          linkedin: prospect.linkedin_url || '',
          company: prospect.company || '',
        },
      },
    ],
  };

  log.info({ email: prospect.email, campaignId: effectiveCampaignId }, 'Calling Mailshake recipients/add');

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

    // Use prospect-specific campaign_id, fall back to default
    const campaignId = prospect.campaign_id || null;

    try {
      await addRecipientToMailshake(prospect, campaignId);
      markSent.run(prospect.id);
      log.info({ id: prospect.id, email: prospect.email, campaign_id: campaignId }, 'Prospect sent to Mailshake');
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
  log.info({ port: PORT, delayHours: DELAY_HOURS, dbPath, campaignRouting: !!campaignRouting }, 'Sales bridge started');
  await validateMailshakeConfig();
});
