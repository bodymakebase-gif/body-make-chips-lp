import { CATALOG, CheckoutError } from './catalog.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const states = ['unshipped', 'shipped', 'contacted'];
export const japanDay = seconds => new Date((seconds + 9 * 3600) * 1000).toISOString().slice(0, 10);
const clean = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (required && !value.trim())) throw new CheckoutError('invalid_fulfillment_input');
  return value.trim();
};
const select = `SELECT r.rowid AS cursor, r.request_id AS id, r.session_id, r.set_id, r.bags, r.amount, r.created,
  COALESCE(f.state, 'unshipped') AS status, COALESCE(f.version, 0) AS version,
  f.shipped_date, f.carrier, f.tracking, f.contacted_at, f.updated
  FROM reservations r LEFT JOIN fulfillment_orders f ON f.request_id = r.request_id`;

// Shipping is a separate ledger: it must never change paid reservations or stock.
export class FulfillmentStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fulfillment_orders (
      request_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('unshipped','shipped','contacted')),
      version INTEGER NOT NULL, shipped_date TEXT, carrier TEXT, tracking TEXT,
      contacted_at INTEGER, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fulfillment_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fulfillment_events_order ON fulfillment_events(request_id, seq);`);
  }
  get(id) {
    if (!uuid.test(id || '')) throw new CheckoutError('invalid_order');
    const row = this.sql.exec(select + ` WHERE r.request_id = ? AND r.state = 'paid'`, id).toArray()[0];
    if (!row) throw new CheckoutError('order_not_found', 404);
    return { ...row, name: CATALOG[row.set_id]?.name || row.set_id };
  }
  list(status = 'unshipped', after = 0) {
    if (![...states, 'all'].includes(status) || !Number.isSafeInteger(after) || after < 0) throw new CheckoutError('invalid_filter');
    const rows = this.sql.exec(select + ` WHERE r.state = 'paid' AND r.rowid > ?
      AND (? = 'all' OR COALESCE(f.state, 'unshipped') = ?) ORDER BY r.rowid ASC LIMIT 26`, after, status, status).toArray();
    const counts = { unshipped: 0, shipped: 0, contacted: 0, all: 0 };
    for (const row of this.sql.exec(`SELECT COALESCE(f.state, 'unshipped') AS status, COUNT(*) AS count
      FROM reservations r LEFT JOIN fulfillment_orders f ON f.request_id = r.request_id
      WHERE r.state = 'paid' GROUP BY COALESCE(f.state, 'unshipped')`).toArray()) {
      counts[row.status] = row.count; counts.all += row.count;
    }
    return { items: rows.slice(0, 25).map(row => ({ ...row, name: CATALOG[row.set_id]?.name || row.set_id })),
      next: rows.length > 25 ? rows[24].cursor : null, counts };
  }
  history(id) {
    return this.sql.exec(`SELECT seq, action, before_json, after_json, payload, actor, created
      FROM fulfillment_events WHERE request_id = ? ORDER BY seq DESC LIMIT 50`, id).toArray().map(row => ({
      seq: row.seq, action: row.action, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json),
      reason: JSON.parse(row.payload).reason || '', actor: row.actor, created: row.created,
    }));
  }
  normalize(input) {
    if (!input || !uuid.test(input.id || '') || !uuid.test(input.operationId || '') ||
        !Number.isSafeInteger(input.version) || input.version < 0 || !['ship', 'contact', 'undo'].includes(input.action)) throw new CheckoutError('invalid_fulfillment_input');
    const data = { id: input.id, operationId: input.operationId, version: input.version, action: input.action };
    if (input.action === 'ship') {
      if (input.confirmed !== true) throw new CheckoutError('shipment_confirmation_required');
      data.shippedDate = clean(input.shippedDate, 10, true);
      data.carrier = clean(input.carrier, 40, true);
      data.tracking = clean(input.tracking, 80, true);
      if (!/^[A-Za-z0-9-]+$/.test(data.tracking)) throw new CheckoutError('invalid_tracking');
    } else if (input.action === 'contact') {
      if (input.confirmed !== true) throw new CheckoutError('contact_confirmation_required');
    } else data.reason = clean(input.reason, 200, true);
    return data;
  }
  repeat(data) {
    const prior = this.sql.exec('SELECT payload FROM fulfillment_events WHERE operation_id = ?', data.operationId).toArray()[0];
    if (!prior) return null;
    if (prior.payload !== JSON.stringify(data)) throw new CheckoutError('request_conflict', 409);
    return { order: this.get(data.id), duplicate: true };
  }
  update(input, actor, now) {
    const data = this.normalize(input);
    return this.storage.transactionSync(() => {
      const prior = this.repeat(data); if (prior) return prior;
      const row = this.get(data.id);
      if (row.version !== data.version) throw new CheckoutError('order_changed', 409);
      const next = { status: row.status, shipped_date: row.shipped_date, carrier: row.carrier, tracking: row.tracking, contacted_at: row.contacted_at };
      if (data.action === 'ship') {
        if (row.status !== 'unshipped') throw new CheckoutError('invalid_transition', 409);
        const parsed = Date.parse(data.shippedDate + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data.shippedDate) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== data.shippedDate ||
            data.shippedDate > japanDay(now) || data.shippedDate < japanDay(row.created)) throw new CheckoutError('invalid_shipped_date');
        Object.assign(next, { status: 'shipped', shipped_date: data.shippedDate, carrier: data.carrier, tracking: data.tracking, contacted_at: null });
      } else if (data.action === 'contact') {
        if (row.status !== 'shipped') throw new CheckoutError('invalid_transition', 409);
        Object.assign(next, { status: 'contacted', contacted_at: now });
      } else {
        if (row.status === 'unshipped') throw new CheckoutError('invalid_transition', 409);
        Object.assign(next, row.status === 'contacted' ? { status: 'shipped', contacted_at: null } :
          { status: 'unshipped', shipped_date: null, carrier: null, tracking: null, contacted_at: null });
      }
      this.sql.exec(`INSERT INTO fulfillment_orders(request_id, state, version, shipped_date, carrier, tracking, contacted_at, updated)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET state=excluded.state, version=excluded.version,
        shipped_date=excluded.shipped_date, carrier=excluded.carrier, tracking=excluded.tracking, contacted_at=excluded.contacted_at, updated=excluded.updated`,
        row.id, next.status, row.version + 1, next.shipped_date, next.carrier, next.tracking, next.contacted_at, now);
      const after = this.get(row.id);
      this.sql.exec(`INSERT INTO fulfillment_events(operation_id, request_id, action, payload, before_json, after_json, actor, created)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, data.operationId, row.id, data.action, JSON.stringify(data), JSON.stringify(row), JSON.stringify(after), actor, now);
      return { order: after, duplicate: false };
    });
  }
}

export class FulfillmentService {
  constructor(store, stripe, livemode) { this.store = store; this.stripe = stripe; this.livemode = livemode; }
  async session(row) {
    const session = await this.stripe.checkout.sessions.retrieve(row.session_id);
    if (session.id !== row.session_id || session.client_reference_id !== row.id || session.livemode !== this.livemode ||
        session.payment_status !== 'paid' || session.mode !== 'payment' || session.currency !== 'jpy' || session.amount_total !== row.amount ||
        session.metadata?.set_id !== row.set_id || session.metadata?.bags !== String(row.bags)) throw new CheckoutError('order_needs_review', 409);
    return session;
  }
  async detail(id) {
    const row = this.store.get(id);
    const session = await this.session(row);
    const shipping = session.collected_information?.shipping_details || session.shipping_details;
    const customer = session.customer_details || {};
    const payment = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    const account = this.livemode ? 'acct_1ThYlsRzqHvlt8DA' : 'acct_1ThYmB2KjzkCozaC/test';
    // Recipient details are fetched on demand, not copied into the shipping ledger or logs.
    return { order: this.store.get(id), history: this.store.history(id), recipient: {
      name: shipping?.name || '', address: shipping?.address || null,
      email: customer.email || '', phone: customer.phone || '',
    }, stripeUrl: `https://dashboard.stripe.com/${account}/payments${/^pi_[A-Za-z0-9]+$/.test(payment || '') ? '/' + payment : ''}` };
  }
  async update(input, actor, now) {
    const prior = this.store.repeat(this.store.normalize(input)); if (prior) return prior;
    if (input.action === 'ship') await this.session(this.store.get(input.id));
    return this.store.update(input, actor, now);
  }
}
