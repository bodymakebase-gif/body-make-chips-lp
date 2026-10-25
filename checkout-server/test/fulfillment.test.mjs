import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { InventoryStore } from '../src/inventory.mjs';
import { FulfillmentStore, FulfillmentService, japanDay } from '../src/fulfillment.mjs';
import { AdminAuthStore, digest, sessionCookie } from '../src/admin-auth.mjs';

const loader = registerHooks({ load(url, context, next) {
  if (/\/admin\/(index\.html|admin\.css|admin\.js)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))}`, shortCircuit: true };
  return next(url, context);
} });
const { adminApi, validateAdminRequest } = await import('../src/admin.mjs');
loader.deregister();
const now = Date.parse('2026-10-25T10:00:00Z') / 1000;
function setup() {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec(query, ...params) {
    if (!params.length && query.includes('CREATE TABLE')) { db.exec(query); return; }
    const stmt = db.prepare(query), rows = stmt.columns().length ? stmt.all(...params) : (stmt.run(...params), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } }, transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const inventory = new InventoryStore(storage, 'test', 500);
  const sessions = new Map();
  function add(paid = true) {
    const id = randomUUID(); inventory.reserve({ requestId: id, setId: 'trial' }, 'price_test', now - 1000);
    const session = { id: 'cs_test_' + id.replaceAll('-', ''), client_reference_id: id, mode: 'payment', livemode: false,
      currency: 'jpy', amount_total: 1280, metadata: { set_id: 'trial', bags: '3' }, payment_status: paid ? 'paid' : 'unpaid', status: paid ? 'complete' : 'open',
      customer_details: { email: 'fixture@example.com', phone: '00000000000' },
      collected_information: { shipping_details: { name: 'テスト宛先', address: { country: 'JP', postal_code: '1000001', state: '東京都', city: 'テスト区', line1: 'テスト町1' } } }, payment_intent: 'pi_test123' };
    inventory.applySession(session, now - 900); sessions.set(session.id, session); return id;
  }
  const first = add(); // Legacy paid order exists before the new tables are created.
  const store = new FulfillmentStore(storage);
  const stripe = { checkout: { sessions: { retrieve: async id => sessions.get(id) } } };
  const service = new FulfillmentService(store, stripe, false);
  return { db, storage, inventory, store, service, sessions, add, first };
}
const ship = (id, version = 0) => ({ operationId: randomUUID(), id, version, action: 'ship', shippedDate: '2026-10-25', carrier: '日本郵便', tracking: '1234-5678-9012', confirmed: true });
const step = (id, version, action, extra = {}) => ({ operationId: randomUUID(), id, version, action, ...extra });
const code = expected => error => error.code === expected;

test('old and new paid orders appear once as unshipped; unpaid orders never appear', () => {
  const { store, add, first, inventory, sessions } = setup(); const unpaid = add(false); const second = add();
  const items = store.list().items;
  assert.deepEqual(items.map(row => row.id), [first, second]); assert.equal(store.list().counts.unshipped, 2);
  assert.throws(() => store.get(unpaid), code('order_not_found'));
  inventory.applySession(sessions.get(inventory.get(first).session_id), now, 'evt_repeated');
  assert.equal(store.list().items.length, 2);
});
test('ship, contact and audited corrections persist without changing any inventory quantity', async () => {
  const { store, service, inventory, storage, first } = setup(); const before = inventory.summary();
  assert.equal((await service.update(ship(first), '管理者', now)).order.status, 'shipped');
  assert.equal(store.list('unshipped').items.length, 0); assert.equal(store.list('shipped').counts.shipped, 1);
  assert.equal(store.update(step(first, 1, 'contact', { confirmed: true }), '管理者', now + 1).order.contacted_at, now + 1);
  const reopened = new FulfillmentStore(storage); assert.equal(reopened.get(first).status, 'contacted');
  store.update(step(first, 2, 'undo', { reason: '宛先の再確認' }), '管理者', now + 2);
  store.update(step(first, 3, 'undo', { reason: '追跡番号の訂正' }), '管理者', now + 3);
  assert.equal(store.get(first).status, 'unshipped'); assert.equal(store.get(first).tracking, null);
  assert.equal(store.history(first).length, 4); assert.equal(store.history(first)[0].before.tracking, '1234-5678-9012');
  assert.deepEqual(inventory.summary(), before); assert.equal(inventory.get(first).state, 'paid');
});
test('lost-response retries cannot double-register and stale screens cannot overwrite another operator', async () => {
  const { store, service, first } = setup(); const input = ship(first);
  const results = await Promise.all([service.update(input, '管理者', now), service.update(input, '管理者', now)]);
  assert.equal(results.filter(result => result.duplicate).length, 1); assert.equal(store.history(first).length, 1);
  await assert.rejects(service.update(ship(first), '管理者', now), code('order_changed'));
  store.update(step(first, 1, 'contact', { confirmed: true }), '管理者', now + 1);
  assert.equal((await service.update(input, '管理者', now + 2)).order.status, 'contacted');
  await assert.rejects(service.update({ ...input, tracking: '9999' }, '管理者', now), code('request_conflict'));
});
test('invalid transitions, date, tracking and missing confirmations cannot create history', () => {
  const { store, first, add } = setup();
  assert.throws(() => store.update(step(first, 0, 'contact', { confirmed: true }), '管理者', now), code('invalid_transition'));
  assert.throws(() => store.update(step(first, 0, 'undo', { reason: '誤登録' }), '管理者', now), code('invalid_transition'));
  for (const shippedDate of ['2026-10-26', '2026-10-24', '2026-02-30', '2026-1-25', 'garbage']) assert.throws(() => store.update({ ...ship(first), shippedDate }, '管理者', now), code('invalid_shipped_date'));
  assert.throws(() => store.update({ ...ship(first), confirmed: false }, '管理者', now), code('shipment_confirmation_required'));
  assert.throws(() => store.update({ ...ship(first), tracking: '<script>' }, '管理者', now), code('invalid_tracking'));
  assert.throws(() => store.update(ship(add(false)), '管理者', now), code('order_not_found'));
  assert.equal(store.history(first).length, 0);
});
test('payment updates never reset shipping state; mismatched authoritative Stripe sessions block shipping', async () => {
  const { store, service, first, sessions, inventory } = setup();
  const session = sessions.get(inventory.get(first).session_id);
  for (const [field, bad] of [['livemode', true], ['amount_total', 1], ['payment_status', 'unpaid'], ['client_reference_id', randomUUID()]]) {
    const original = session[field]; session[field] = bad;
    await assert.rejects(service.update(ship(first), '管理者', now), code('order_needs_review')); session[field] = original;
  }
  await service.update(ship(first), '管理者', now);
  inventory.applySession(session, now + 1, 'evt_duplicate'); assert.equal(store.get(first).status, 'shipped');
});
test('recipient details are fetched on demand and never stored in the fulfillment ledger', async () => {
  const { service, store, first, db } = setup();
  const detail = await service.detail(first); assert.equal(detail.recipient.name, 'テスト宛先');
  assert.match(detail.stripeUrl, /acct_1ThYmB2KjzkCozaC\/test\/payments\/pi_test123$/);
  await service.update(ship(first), '管理者', now);
  const persisted = JSON.stringify(db.prepare('SELECT * FROM fulfillment_events').all());
  assert.equal(persisted.includes('fixture@example.com'), false); assert.equal(persisted.includes('テスト町'), false);
  assert.equal(JSON.stringify(store.list()).includes('テスト宛先'), false);
});
test('same-second orders paginate without duplication and filters/counts track each state', () => {
  const { store, add, first } = setup(); for (let i = 0; i < 30; i++) add();
  const a = store.list(), b = store.list('unshipped', a.next);
  assert.equal(a.items.length, 25); assert.equal(b.items.length, 6); assert.equal(b.next, null);
  assert.equal(new Set([...a.items, ...b.items].map(row => row.id)).size, 31);
  store.update(ship(first), '管理者', now); store.update(step(first, 1, 'contact', { confirmed: true }), '管理者', now);
  assert.deepEqual(store.list('all').counts, { unshipped: 30, shipped: 0, contacted: 1, all: 31 });
  for (const filter of ['__proto__', "' OR 1=1"]) assert.throws(() => store.list(filter));
  assert.throws(() => store.list('all', NaN));
});
test('all fulfillment endpoints require authentication, enforce same-origin writes and return no-store', async () => {
  const { storage, inventory, service, first } = setup();
  const auth = new AdminAuthStore(storage), hash = await digest('test-key-for-unit-tests');
  const token = await auth.login('test-key-for-unit-tests', hash, 'test-ip', now);
  const request = (path, authenticated, data) => new Request('https://admin.example/admin/api/' + path, {
    method: data ? 'POST' : 'GET', headers: { ...(authenticated ? { cookie: sessionCookie(token) } : {}), ...(data ? { origin: 'https://admin.example', 'x-bmc-admin': '1', 'content-type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined,
  });
  const run = req => adminApi(req, inventory, auth, hash, req => req.json(), now, null, service);
  for (const [path, data] of [['orders'], ['order?id=' + first], ['fulfillment', ship(first)]]) await assert.rejects(run(request(path, false, data)), code('authentication_required'));
  const orders = await run(request('orders', true)); assert.equal(orders.headers.get('cache-control'), 'no-store'); assert.equal((await orders.json()).counts.unshipped, 1);
  const mutation = request('fulfillment', true, ship(first)); validateAdminRequest(mutation, 'test');
  assert.equal((await (await run(mutation)).json()).order.status, 'shipped');
  for (const headers of [{ origin: 'https://evil.example', 'x-bmc-admin': '1' }, { origin: 'https://admin.example' }, { 'x-bmc-admin': '1' }]) assert.throws(() => validateAdminRequest(new Request('https://admin.example/admin/api/fulfillment', { method: 'POST', headers }), 'test'), code('origin_not_allowed'));
  assert.equal(japanDay(Date.parse('2026-10-24T15:00:00Z') / 1000), '2026-10-25');
});
