import { CATALOG } from './catalog.mjs';

const MAX_AGE = 71 * 60 * 60;
// Accept only GA-generated numeric identifiers, never arbitrary text, URLs or customer data.
export function analyticsContext(input) {
  if (!input || input.consent !== 'granted' ||
      !/^\d{1,20}\.\d{1,20}$/.test(input.clientId || '') ||
      !/^\d{1,15}$/.test(String(input.sessionId || ''))) return null;
  const sessionId = Number(input.sessionId);
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) return null;
  return { clientId: input.clientId, sessionId, consent: 'granted' };
}

export function purchasePayload(row, context, now, debug = false) {
  const item = CATALOG[row.set_id];
  if (!item || row.state !== 'paid' || row.amount !== item.amount || row.bags !== item.bags) return null;
  return {
    client_id: context.clientId,
    timestamp_micros: now * 1000000,
    consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
    events: [{ name: 'purchase', params: {
      transaction_id: `bmc_${row.request_id}`,
      currency: 'JPY', value: row.amount,
      session_id: context.sessionId, engagement_time_msec: 1,
      ...(debug ? { debug_mode: true } : {}),
      items: [{ item_id: row.set_id, item_name: `BODY-MAKE CHIPS ${item.name}`,
        item_brand: 'BODY-MAKE CHIPS', item_variant: `${item.bags}袋`, price: row.amount, quantity: 1 }],
    } }],
  };
}

// Analytics is a separate outbox. It cannot change inventory or decide whether an order is paid.
export class PurchaseAnalytics {
  constructor(storage, env, fetcher = (...args) => fetch(...args)) {
    this.storage = storage; this.sql = storage.sql; this.env = env; this.fetcher = fetcher;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS analytics_context (
      request_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, session_id INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_outbox (
        request_id TEXT PRIMARY KEY, payload TEXT, created INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, sent INTEGER);
      CREATE INDEX IF NOT EXISTS analytics_due ON analytics_outbox(state,next_attempt);`);
  }
  enabled() {
    return /^G-[A-Z0-9]+$/.test(this.env.GA4_MEASUREMENT_ID || '') &&
      typeof this.env.GA4_API_SECRET === 'string' && this.env.GA4_API_SECRET.length >= 10;
  }
  remember(row, input, now) {
    const context = analyticsContext(input);
    // A returning visitor cannot attach a new identity to an already completed order.
    if (!this.enabled() || !context || !['creating', 'open'].includes(row.state)) return;
    this.sql.exec(`INSERT OR IGNORE INTO analytics_context(request_id,client_id,session_id,created) VALUES(?,?,?,?)`,
      row.request_id, context.clientId, context.sessionId, now);
  }
  capturePaid(now) {
    if (!this.enabled()) return;
    this.storage.transactionSync(() => {
      const rows = this.sql.exec(`SELECT r.*,c.client_id,c.session_id AS ga_session_id FROM analytics_context c
        JOIN reservations r ON r.request_id=c.request_id
        LEFT JOIN analytics_outbox o ON o.request_id=c.request_id
        WHERE r.state='paid' AND o.request_id IS NULL`).toArray();
      for (const row of rows) {
        const payload = purchasePayload(row, { clientId: row.client_id, sessionId: row.ga_session_id }, now,
          this.env.STRIPE_MODE === 'test');
        if (payload) this.sql.exec('INSERT OR IGNORE INTO analytics_outbox(request_id,payload,created,next_attempt) VALUES(?,?,?,?)',
          row.request_id, JSON.stringify(payload), now, now);
      }
    });
  }
  hasPending() { return !!this.sql.exec("SELECT 1 FROM analytics_outbox WHERE state='pending' LIMIT 1").toArray().length; }
  status() {
    return { enabled: this.enabled(),
      contexts: this.sql.exec('SELECT COUNT(*) AS total FROM analytics_context').toArray()[0].total,
      deliveries: this.sql.exec('SELECT state,COUNT(*) AS total,MAX(attempts) AS maxAttempts,MAX(sent) AS lastSent FROM analytics_outbox GROUP BY state').toArray() };
  }
  async flush(now = Math.floor(Date.now() / 1000)) {
    if (!this.enabled()) return;
    this.capturePaid(now);
    this.sql.exec("UPDATE analytics_outbox SET state='stale',payload=NULL WHERE state='pending' AND created<?", now - MAX_AGE);
    const rows = this.storage.transactionSync(() => {
      const due = this.sql.exec("SELECT * FROM analytics_outbox WHERE state='pending' AND next_attempt<=? ORDER BY created LIMIT 20", now).toArray();
      // Lease each message before yielding so concurrent webhooks do not send it together.
      for (const row of due) this.sql.exec('UPDATE analytics_outbox SET attempts=attempts+1,next_attempt=? WHERE request_id=?', now + 60, row.request_id);
      return due;
    });
    for (const row of rows) {
      try {
        const url = new URL('https://www.google-analytics.com/mp/collect');
        url.searchParams.set('measurement_id', this.env.GA4_MEASUREMENT_ID);
        url.searchParams.set('api_secret', this.env.GA4_API_SECRET);
        const response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: row.payload, signal: AbortSignal.timeout(6000) });
        if (!response.ok) {
          console.warn('analytics_http_status', response.status);
          throw new Error('analytics_delivery_failed');
        }
        this.sql.exec("UPDATE analytics_outbox SET state='sent',sent=? WHERE request_id=?", now, row.request_id);
      } catch (error) {
        console.warn('analytics_delivery_retry', error?.name === 'TimeoutError' ? 'timeout' : 'delivery_failed');
        // GA4 deduplicates a retried purchase by its stable transaction_id.
        this.sql.exec("UPDATE analytics_outbox SET next_attempt=? WHERE request_id=? AND state='pending'",
          now + Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6)), row.request_id);
      }
    }
    // Keep the transaction receipt for deduplication; expire browser identifiers and payloads.
    this.sql.exec("UPDATE analytics_outbox SET payload=NULL WHERE state='sent' AND sent<?", now - 7 * 86400);
    this.sql.exec(`DELETE FROM analytics_context WHERE created<? AND request_id IN
      (SELECT request_id FROM reservations WHERE state IN ('paid','expired','failed','review'))`, now - 7 * 86400);
  }
}

// No analytics without a choice in the EEA/UK/Switzerland or when geolocation is unavailable.
const CONSENT_REGIONS = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LI LV LT LU MT NL NO PL PT RO SK SI ES SE GB CH'.split(' '));
export function analyticsDefaultAllowed(country) {
  return /^[A-Z]{2}$/.test(country || '') && !['XX', 'T1'].includes(country) && !CONSENT_REGIONS.has(country);
}
