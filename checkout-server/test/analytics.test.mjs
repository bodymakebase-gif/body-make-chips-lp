import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../src/inventory.mjs';
import { analyticsContext, analyticsDefaultAllowed, PurchaseAnalytics } from '../src/analytics.mjs';
import { cleanLocation, ecommerceItem } from '../../tracking/analytics-core.mjs';

test('public page URLs keep campaign labels but never expose order tokens or personal query data', () => {
  assert.equal(cleanLocation('https://body-make-chips.jp/order-complete.html?session_id=cs_live_secret&email=name%40example.com#address'),
    'https://body-make-chips.jp/order-complete.html');
  assert.equal(cleanLocation('https://body-make-chips.jp/?utm_source=instagram&utm_medium=social&utm_campaign=launch_202611&utm_content=name%40example.com&preview=1#top'),
    'https://body-make-chips.jp/?utm_source=instagram&utm_medium=social&utm_campaign=launch_202611');
});
test('ecommerce represents one purchased set, not its bag count multiplied by the set price', () => {
  const item = ecommerceItem({ id: 'desk', name: '10袋セット', quantity: 10, price: 3980, email: 'must-not-copy@example.com' });
  assert.equal(item.quantity * item.price, 3980);
  assert.equal(item.item_variant, '10袋'); assert.equal(Object.hasOwn(item, 'email'), false);
});

function setup(fetcher = async () => new Response(null, { status: 204 })) {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(query, ...params) {
      if (!params.length && query.includes('CREATE TABLE')) { db.exec(query); return; }
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
  const inventory = new InventoryStore(storage, 'test');
  const analytics = new PurchaseAnalytics(storage, { GA4_MEASUREMENT_ID: 'G-UNITTEST', GA4_API_SECRET: 'unit-test-only-not-a-real-key', STRIPE_MODE: 'test' }, fetcher);
  function order(setId = 'trial', consent = true) {
    const input = { setId, requestId: randomUUID() };
    const row = inventory.reserve(input, 'price_test', 1000000);
    analytics.remember(row, consent ? { clientId: '12345.1000000', sessionId: 1000000, consent: 'granted' } : null, 1000000);
    const session = { id: 'cs_test_' + input.requestId.replaceAll('-', ''), url: 'https://checkout.stripe.com/c/pay/test', client_reference_id: input.requestId,
      amount_total: row.amount, mode: 'payment', currency: 'jpy', metadata: { set_id: row.set_id, bags: String(row.bags) },
      payment_status: 'unpaid', status: 'open', expires_at: row.expires };
    inventory.attach(row.request_id, session, 1000000);
    return { row, session, pay() { session.payment_status = 'paid'; session.status = 'complete'; inventory.applySession(session, 1000001); } };
  }
  return { db, storage, inventory, analytics, order };
}
test('analytics accepts only consented GA numeric IDs and drops arbitrary text and PII', () => {
  for (const input of [null, {}, { clientId: 'name@example.com', sessionId: 1, consent: 'granted' },
    { clientId: '123.456', sessionId: 'https://example.com', consent: 'granted' },
    { clientId: '123.456', sessionId: 1, consent: 'denied' }]) assert.equal(analyticsContext(input), null);
  assert.deepEqual(analyticsContext({ clientId: '123.456', sessionId: '123', consent: 'granted', email: 'ignored@example.com' }),
    { clientId: '123.456', sessionId: 123, consent: 'granted' });
});
test('consent-required and unknown locations do not default to tracking', () => {
  for (const country of ['FR', 'DE', 'GB', 'CH', 'NO', 'XX', 'T1', '', undefined]) assert.equal(analyticsDefaultAllowed(country), false);
  assert.equal(analyticsDefaultAllowed('JP'), true);
});
test('paid webhook state produces one purchase per order without a thank-you page visit', async () => {
  const requests = [];
  const { analytics, inventory, order } = setup(async (url, options) => { requests.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); });
  const sample = order('desk'); sample.pay();
  await analytics.flush(1000002); await analytics.flush(1000003);
  inventory.applySession(sample.session, 1000004, 'evt_duplicate');
  await analytics.flush(1000005);
  assert.equal(requests.length, 1); assert.equal(inventory.available(), 490);
  const event = requests[0].events[0];
  assert.equal(event.name, 'purchase'); assert.equal(event.params.transaction_id, 'bmc_' + sample.row.request_id);
  assert.equal(event.params.value, 3980); assert.equal(event.params.currency, 'JPY');
  assert.equal(event.params.items[0].quantity, 1); assert.equal(event.params.items[0].item_variant, '10袋');
  assert.equal(requests[0].client_id, '12345.1000000');
  assert.equal(event.params.session_id, 1000000);
  assert.equal(JSON.stringify(requests).includes('cs_test'), false);
});
test('unpaid, cancelled, untracked and mismatched orders never become analytics purchases', async () => {
  let calls = 0;
  const { analytics, inventory, order } = setup(async () => { calls++; return new Response(null, { status: 204 }); });
  order();
  const cancelled = order(); cancelled.session.status = 'expired'; inventory.applySession(cancelled.session, 1000001);
  const untracked = order('trial', false); untracked.pay();
  const mismatch = order(); mismatch.session.amount_total = 1;
  assert.throws(() => mismatch.pay());
  await analytics.flush(1000002);
  assert.equal(calls, 0);
});
test('temporary Google failures retain purchases and retry the same transaction without changing stock', async () => {
  const messages = []; let fail = true;
  const { analytics, inventory, order } = setup(async (_, options) => {
    messages.push(options.body); if (fail) throw new Error('timeout'); return new Response(null, { status: 204 });
  });
  order('stock').pay();
  await analytics.flush(1000002); assert.equal(analytics.hasPending(), true); assert.equal(inventory.available(), 470);
  await analytics.flush(1000003); assert.equal(messages.length, 1);
  fail = false; await analytics.flush(1000062);
  assert.equal(analytics.hasPending(), false); assert.equal(messages[0], messages[1]); assert.equal(inventory.available(), 470);
});
test('concurrent deliveries claim a single outbox record', async () => {
  let calls = 0;
  const { analytics, order } = setup(async () => { calls++; await new Promise(r => setTimeout(r, 10)); return new Response(null, { status: 204 }); });
  order().pay();
  await Promise.all([analytics.flush(1000002), analytics.flush(1000002), analytics.flush(1000002)]);
  assert.equal(calls, 1);
});
test('runtime fetch is called without rebinding it to the analytics service', async () => {
  const original = globalThis.fetch;
  const { storage, order } = setup();
  let calls = 0;
  globalThis.fetch = function () {
    assert.equal(this instanceof PurchaseAnalytics, false);
    calls++; return Promise.resolve(new Response(null, { status: 204 }));
  };
  try {
    const analytics = new PurchaseAnalytics(storage, { GA4_MEASUREMENT_ID: 'G-UNITTEST', GA4_API_SECRET: 'unit-test-only-not-a-real-key' });
    order().pay(); await analytics.flush(1000002);
    assert.equal(calls, 1); assert.equal(analytics.hasPending(), false);
    assert.deepEqual(analytics.status().deliveries.map(x => [x.state,x.total]), [['sent',1]]);
  } finally { globalThis.fetch = original; }
});
test('a return to a paid order cannot attach or replace a browser identity', async () => {
  const { analytics, inventory, order, storage } = setup();
  const sample = order('trial', false); sample.pay();
  analytics.remember(inventory.get(sample.row.request_id), { clientId: '999.999', sessionId: 999, consent: 'granted' }, 1000002);
  await analytics.flush(1000002);
  assert.equal(storage.sql.exec('SELECT * FROM analytics_context').toArray().length, 0);
});
test('deliveries older than the GA4 backdating window expire instead of inventing a new purchase date', async () => {
  const { analytics, order, storage } = setup(async () => { throw new Error('down'); });
  order().pay(); await analytics.flush(1000002);
  await analytics.flush(1000002 + 72 * 3600);
  assert.equal(analytics.hasPending(), false);
  assert.equal(storage.sql.exec('SELECT state FROM analytics_outbox').one().state, 'stale');
});
