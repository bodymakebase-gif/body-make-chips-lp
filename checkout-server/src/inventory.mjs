import { CATALOG, INITIAL_STOCK, CheckoutError, validateRequest } from './catalog.mjs';

// This store contains no customer addresses or card data. Stripe remains the order record.
// SQL operations inside transactionSync finish before any network await.
export class InventoryStore {
  constructor(storage, environment, initialStock = INITIAL_STOCK) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY CHECK(id=1), environment TEXT NOT NULL, total INTEGER NOT NULL CHECK(total>=0));
      CREATE TABLE IF NOT EXISTS reservations (
        request_id TEXT PRIMARY KEY, set_id TEXT NOT NULL, bags INTEGER NOT NULL,
        amount INTEGER NOT NULL, price_id TEXT NOT NULL, created INTEGER NOT NULL,
        expires INTEGER NOT NULL, state TEXT NOT NULL, session_id TEXT UNIQUE,
        session_url TEXT, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reservations_state ON reservations(state);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, processed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS adjustments (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, bags INTEGER NOT NULL, delta INTEGER NOT NULL,
        note TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL,
        before_available INTEGER NOT NULL, after_available INTEGER NOT NULL,
        reversal_of TEXT UNIQUE);`);
    this.sql.exec('INSERT OR IGNORE INTO inventory(id,environment,total) VALUES(1,?,?)', environment, initialStock);
    if (this.sql.exec('SELECT environment FROM inventory WHERE id=1').one().environment !== environment) {
      throw new Error('Inventory environment mismatch; use separate namespaces for test and live.');
    }
  }
  get(id) { return this.sql.exec('SELECT * FROM reservations WHERE request_id=?', id).toArray()[0]; }
  available() {
    return this.sql.exec(`SELECT total-COALESCE((SELECT SUM(bags) FROM reservations
      WHERE state IN ('creating','open','pending','paid','review')),0) AS available FROM inventory WHERE id=1`).one().available;
  }
  reserve(input, priceId, now) {
    const item = validateRequest(input);
    return this.storage.transactionSync(() => {
      const existing = this.get(input.requestId);
      if (existing) {
        if (existing.set_id !== input.setId) throw new CheckoutError('request_conflict', 409);
        return existing;
      }
      if (this.available() < item.bags) throw new CheckoutError('out_of_stock', 409);
      // 35 minutes gives Stripe's 30-minute minimum headroom on the initial request.
      this.sql.exec(`INSERT INTO reservations
        (request_id,set_id,bags,amount,price_id,created,expires,state,updated)
        VALUES(?,?,?,?,?,?,?,'creating',?)`,
        input.requestId, input.setId, item.bags, item.amount, priceId, now, now + 2100, now);
      return this.get(input.requestId);
    });
  }
  attach(id, session, now) {
    return this.storage.transactionSync(() => {
      const row = this.get(id);
      if (!row || (row.session_id && row.session_id !== session.id)) throw new Error('Session mismatch');
      // A webhook may arrive before the create request returns. Never downgrade paid/pending.
      this.sql.exec(`UPDATE reservations SET session_id=?,session_url=?,expires=?,
        state=CASE WHEN state='creating' THEN 'open' ELSE state END,updated=? WHERE request_id=?`,
        session.id, session.url, session.expires_at, now, id);
      return this.get(id);
    });
  }
  applySession(session, now, eventId) {
    const issue = this.storage.transactionSync(() => {
      if (eventId && this.sql.exec('SELECT id FROM events WHERE id=?', eventId).toArray().length) return;
      const row = this.get(session.client_reference_id);
      // Existing Payment Links are separate test fixtures, not reservations in this inventory.
      if (!row) return;
      if (row.session_id && row.session_id !== session.id) throw new Error('Session mismatch');
      if (row.state === 'review') return 'Order requires manual review';
      if (session.amount_total !== row.amount || session.currency !== 'jpy' || session.mode !== 'payment' ||
          session.metadata?.set_id !== row.set_id || session.metadata?.bags !== String(row.bags)) {
        this.sql.exec("UPDATE reservations SET state='review',updated=? WHERE request_id=?", now, row.request_id);
        return 'Order integrity mismatch';
      }
      let state = row.state;
      if (session.payment_status === 'paid') {
        // Released stock must not be silently reallocated by an unexpected late payment.
        if (['expired', 'failed'].includes(row.state)) {
          this.sql.exec("UPDATE reservations SET state='review',updated=? WHERE request_id=?", now, row.request_id);
          return 'Payment received for released reservation';
        }
        state = 'paid';
      } else if (!['paid', 'review', 'expired', 'failed'].includes(row.state)) {
        if (session.status === 'expired') state = 'expired';
        else if (session.status === 'complete') state = 'pending';
        else if (session.status === 'open') state = 'open';
      }
      this.sql.exec('UPDATE reservations SET session_id=?,state=?,updated=? WHERE request_id=?', session.id, state, now, row.request_id);
      if (eventId) this.sql.exec('INSERT INTO events(id,processed) VALUES(?,?)', eventId, now);
    });
    if (issue) throw new Error(issue);
  }
  failAsync(session, now, eventId) {
    this.applySession(session, now);
    this.storage.transactionSync(() => {
      const row = this.get(session.client_reference_id);
      if (!row || row.state === 'paid' || row.state === 'review') return;
      this.sql.exec("UPDATE reservations SET state='failed',updated=? WHERE request_id=?", now, row.request_id);
      if (eventId) this.sql.exec('INSERT OR IGNORE INTO events(id,processed) VALUES(?,?)', eventId, now);
    });
  }
  failCreation(id, now) {
    this.sql.exec("UPDATE reservations SET state='failed',updated=? WHERE request_id=? AND state='creating' AND session_id IS NULL", now, id);
  }
  touch(id, now) { this.sql.exec('UPDATE reservations SET updated=? WHERE request_id=?', now, id); }
  pending() { return this.sql.exec("SELECT * FROM reservations WHERE state IN ('creating','open','pending') ORDER BY updated LIMIT 40").toArray(); }
  status() { const available = Math.max(0, this.available()); return Object.fromEntries(Object.entries(CATALOG).map(([key, item]) => [key, available >= item.bags])); }

  summary() {
    const total = this.sql.exec('SELECT total FROM inventory WHERE id=1').one().total;
    const grouped = this.sql.exec('SELECT state,SUM(bags) AS bags FROM reservations GROUP BY state').toArray();
    const counts = Object.fromEntries(grouped.map(row => [row.state, row.bags]));
    const held = (counts.creating || 0) + (counts.open || 0) + (counts.pending || 0);
    const paid = counts.paid || 0, review = counts.review || 0;
    const adjustments = this.sql.exec('SELECT COALESCE(SUM(delta),0) AS net FROM adjustments').one().net;
    return { total, initial: total - adjustments, adjustments, held, paid, review,
      available: total - held - paid - review };
  }

  history(before = Number.MAX_SAFE_INTEGER, limit = 25) {
    return this.sql.exec(`SELECT a.*,r.request_id AS reversed_by FROM adjustments a
      LEFT JOIN adjustments r ON r.reversal_of=a.request_id WHERE a.seq<? ORDER BY a.seq DESC LIMIT ?`, before, limit).toArray();
  }

  adjust(input, actor, now) {
    const directions = { sample: -1, damage: -1, receipt: 1, return: 1 };
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    if (!input || !uuid.test(input.requestId || '')) throw new CheckoutError('invalid_request_id');
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > 200 || /[\x00-\x08\x0b-\x1f\x7f]/.test(note)) throw new CheckoutError('invalid_note');
    if (input.kind !== 'reversal' && !Object.hasOwn(directions, input.kind)) throw new CheckoutError('invalid_adjustment');
    if (input.kind !== 'reversal' && (!Number.isSafeInteger(input.bags) || input.bags < 1 || input.bags > 100000)) throw new CheckoutError('invalid_quantity');
    if (input.kind === 'reversal' && !uuid.test(input.reversalOf || '')) throw new CheckoutError('invalid_adjustment');
    return this.storage.transactionSync(() => {
      const existing = this.sql.exec('SELECT * FROM adjustments WHERE request_id=?', input.requestId).toArray()[0];
      if (existing) {
        if (existing.kind !== input.kind || existing.note !== note ||
            (input.kind === 'reversal' ? existing.reversal_of !== input.reversalOf : existing.bags !== input.bags)) {
          throw new CheckoutError('request_conflict', 409);
        }
        return { adjustment: existing, duplicate: true };
      }
      let bags = input.bags, delta = directions[input.kind] * bags;
      if (input.kind === 'reversal') {
        const original = this.sql.exec('SELECT * FROM adjustments WHERE request_id=?', input.reversalOf).toArray()[0];
        if (!original || original.kind === 'reversal') throw new CheckoutError('invalid_reversal');
        if (this.sql.exec('SELECT 1 FROM adjustments WHERE reversal_of=?', input.reversalOf).toArray().length) throw new CheckoutError('already_reversed', 409);
        bags = original.bags; delta = -original.delta;
      }
      const before = this.available();
      if (before < 0 || this.summary().review > 0) throw new CheckoutError('inventory_needs_review', 409);
      if (before + delta < 0) throw new CheckoutError('insufficient_stock', 409);
      const total = this.sql.exec('SELECT total FROM inventory WHERE id=1').one().total;
      if (total + delta > 10000000) throw new CheckoutError('quantity_limit');
      this.sql.exec('UPDATE inventory SET total=total+? WHERE id=1', delta);
      this.sql.exec(`INSERT INTO adjustments(request_id,kind,bags,delta,note,actor,created,before_available,after_available,reversal_of)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, input.requestId, input.kind, bags, delta, note, actor, now, before, before + delta, input.kind === 'reversal' ? input.reversalOf : null);
      return { adjustment: this.sql.exec('SELECT * FROM adjustments WHERE request_id=?', input.requestId).one(), duplicate: false };
    });
  }
}
