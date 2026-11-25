import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../src/inventory.mjs';
import { CheckoutService, sessionParameters } from '../src/checkout.mjs';
import { FulfillmentStore, FulfillmentService } from '../src/fulfillment.mjs';
import { checkoutPricing, checkoutComplete } from '../src/order-pricing.mjs';
import { purchasePayload } from '../src/analytics.mjs';
const now = Date.parse('2026-11-26T03:00:00Z') / 1000;
function setup() {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec(query, ...params) {
    if (!params.length && query.includes('CREATE TABLE')) { db.exec(query); return; }
    const stmt = db.prepare(query), rows = stmt.columns().length ? stmt.all(...params) : (stmt.run(...params), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } }, transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const store = new InventoryStore(storage, 'test');
  const sessions = new Map();
  let createCalls = [];
  const stripe = { prices: { retrieve: async () => ({ active: true, type: 'one_time', currency: 'jpy', unit_amount: 1280, livemode: false }) }, checkout: { sessions: {
    async create(params, opts) {
      createCalls.push({ params, opts });
      if (!sessions.has(opts.idempotencyKey)) sessions.set(opts.idempotencyKey, { ...params, id: 'cs_test_' + randomUUID().replaceAll('-', ''), url: 'https://checkout.stripe.com/c/pay/test',
        currency: 'jpy', amount_total: 1280, amount_subtotal: 1280, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
        livemode: false, status: 'open', payment_status: 'unpaid' });
      return sessions.get(opts.idempotencyKey);
    },
    async retrieve(id) { return [...sessions.values()].find(row => row.id === id); },
    list() { return (async function* () { yield* sessions.values(); })(); },
  } } };
  const config = { prices: { trial: 'price_trial' }, livemode: false, siteOrigin: 'https://body-make-chips.jp' };
  const service = new CheckoutService(store, stripe, config, () => now);
  const fulfillment = new FulfillmentService(new FulfillmentStore(storage), stripe, false);
  const input = { setId: 'trial', requestId: randomUUID() };
  async function order() { await service.create(input); return [...sessions.values()][0]; }
  function free(session, code = 'Reviewer00', label = 'アンケート00') {
    Object.assign(session, { amount_total: 0, total_details: { amount_discount: 1280, amount_tax: 0, amount_shipping: 0 },
      line_items: { has_more: false, data: [{ quantity: 1, amount_subtotal: 1280, price: { id: 'price_trial', product: 'prod_trial' } }] },
      discounts: [{ coupon: null, promotion_code: { id: 'promo_review00', code, livemode: false, active: false,
        metadata: { bmc_purpose: 'reviewer', bmc_set_id: 'trial', bmc_questionnaire: label },
        promotion: { type: 'coupon', coupon: { id: 'coupon_review00', livemode: false, valid: false, percent_off: 100, duration: 'once', applies_to: { products: ['prod_trial'] } } } } }],
      status: 'complete', payment_status: 'no_payment_required', payment_intent: null,
      collected_information: { shipping_details: { name: 'テスト宛先', address: { country: 'JP', postal_code: '1000001', line1: '試験' } } }, customer_details: { email: 'test@example.invalid' } });
    return session;
  }
  const event = (session, type = 'checkout.session.completed') => ({ id: 'evt_' + randomUUID(), type, livemode: false, data: { object: { id: session.id } } });
  return { db, storage, store, stripe, service, fulfillment, input, order, free, event, createCalls, config };
}

test('100% reviewer checkout becomes one free shipment with its own packing instructions', async () => {
  const f = setup(), session = f.free(await f.order());
  assert.equal(f.createCalls[0].params.allow_promotion_codes, true);
  await f.service.webhook(f.event(session)); await f.service.webhook(f.event(session));
  assert.equal(f.store.available(), 497);
  const row = f.store.get(f.input.requestId);
  assert.equal(row.state, 'paid'); assert.equal(row.amount, 1280); assert.equal(row.amount_total, 0);
  assert.equal(row.amount_discount, 1280); assert.equal(row.reviewer_code, 'Reviewer00'); assert.equal(row.questionnaire, 'アンケート00');
  assert.equal(f.fulfillment.store.list().items.length, 1);
  const detail = await f.fulfillment.detail(row.request_id);
  assert.equal(detail.order.reviewer_code, 'Reviewer00'); assert.equal(detail.recipient.name, 'テスト宛先');
  assert.match(detail.stripeUrl, /no-cost-orders$/);
  await f.fulfillment.update({ id: row.request_id, operationId: randomUUID(), version: 0, action: 'ship',
    shippedDate: '2026-11-26', carrier: '日本郵便', trackingProvided: false, tracking: '', confirmed: true }, '管理者', now);
  assert.equal(f.fulfillment.store.list('shipped').counts.shipped, 1); assert.equal(f.store.available(), 497);
});

test('different Reviewer codes retain distinct questionnaires and saved instructions survive later metadata changes', async () => {
  const f = setup(), session = f.free(await f.order(), 'Reviewer01', '食感アンケート01');
  await f.service.webhook(f.event(session));
  session.discounts[0].promotion_code.metadata.bmc_questionnaire = '後日変更';
  await f.service.webhook(f.event(session));
  assert.equal((await f.fulfillment.detail(f.input.requestId)).order.questionnaire, '食感アンケート01');
  assert.equal(f.store.get(f.input.requestId).reviewer_code, 'Reviewer01');
});

test('Stripe free paid sessions without a PaymentIntent hydrate optional coupon product restrictions', async () => {
  const f = setup(), session = f.free(await f.order());
  const coupon = session.discounts[0].promotion_code.promotion.coupon;
  session.discounts[0].promotion_code.promotion.coupon = coupon.id;
  session.payment_status = 'paid';
  let reads = 0;
  f.stripe.coupons = { async retrieve(id, params) { assert.equal(id, coupon.id); assert.deepEqual(params, { expand: ['applies_to'] }); reads++; return coupon; } };
  await f.service.webhook(f.event(session));
  assert.equal(reads, 1); assert.equal(f.store.get(f.input.requestId).state, 'paid');
  assert.equal(f.store.get(f.input.requestId).amount_total, 0); assert.equal(session.payment_intent, null);
});

test('an open or unpaid free checkout is never ready to ship', async () => {
  for (const change of [{ status: 'open' }, { payment_status: 'unpaid' }]) {
    const f = setup(), session = f.free(await f.order()); Object.assign(session, change);
    await f.service.webhook(f.event(session));
    assert.notEqual(f.store.get(f.input.requestId).state, 'paid');
    assert.equal(f.fulfillment.store.list().items.length, 0);
    assert.equal(checkoutComplete(session, checkoutPricing(session, f.store.get(f.input.requestId))), false);
  }
});

test('ordinary orders do not request any coupon or promotion permissions', async () => {
  const f = setup(), session = await f.order(), retrieve = f.stripe.checkout.sessions.retrieve;
  session.status = 'complete'; session.payment_status = 'paid';
  f.stripe.checkout.sessions.retrieve = async (id, params) => { assert.equal(params, undefined); return retrieve(id); };
  await f.service.webhook(f.event(session));
  assert.equal(f.store.get(f.input.requestId).state, 'paid'); assert.equal(f.store.available(), 497);
  await f.fulfillment.detail(f.input.requestId);
});

test('malformed discounts, missing trusted metadata, wrong sets and counterfeit free amounts are held for review', async () => {
  for (const mutate of [s => { s.amount_subtotal = 1; }, s => { s.total_details.amount_discount = 1; },
    s => { s.total_details.amount_shipping = 100; }, s => { s.currency = 'usd'; },
    s => { s.line_items.data[0].price.id = 'wrong'; }, s => { s.line_items.data[0].quantity = 2; },
    s => { s.discounts[0].promotion_code.metadata = {}; }, s => { s.discounts[0].promotion_code = 'promo_unexpanded'; },
    s => { s.discounts[0].promotion_code.promotion.coupon.applies_to.products = ['prod_stock']; },
    s => { s.discounts[0].promotion_code.metadata.bmc_set_id = 'stock'; },
    s => { s.discounts[0].promotion_code.livemode = true; }]) {
    const f = setup(), session = f.free(await f.order()); mutate(session);
    await assert.rejects(f.service.webhook(f.event(session)));
    assert.equal(f.store.get(f.input.requestId).state, 'review');
    assert.equal(f.store.available(), 497); assert.equal(f.fulfillment.store.list().items.length, 0);
  }
});

test('expired reservations are not silently consumed by a late free completion', async () => {
  const f = setup(), session = await f.order(); session.status = 'expired';
  await f.service.webhook(f.event(session, 'checkout.session.expired')); assert.equal(f.store.available(), 500);
  f.free(session); await assert.rejects(f.service.webhook(f.event(session)));
  assert.equal(f.store.get(f.input.requestId).state, 'review'); assert.equal(f.fulfillment.store.list().items.length, 0);
});

test('lost create responses use the same promotion-enabled parameters and never reserve twice', async () => {
  const f = setup(), create = f.stripe.checkout.sessions.create;
  f.stripe.checkout.sessions.create = async (...args) => { await create(...args); throw new Error('lost'); };
  await assert.rejects(f.order()); f.stripe.checkout.sessions.create = create;
  await f.service.reconcile();
  assert.equal(f.store.available(), 497); assert.equal(f.createCalls.length, 2);
  assert.deepEqual(f.createCalls[0], f.createCalls[1]);
});

test('old reservations keep the exact pre-promotion creation parameters after a schema upgrade', async () => {
  const f = setup(); const row = f.store.reserve(f.input, 'price_trial', now);
  f.db.prepare('UPDATE reservations SET checkout_version=1 WHERE request_id=?').run(row.request_id);
  new InventoryStore(f.storage, 'test');
  const params = sessionParameters(f.store.get(row.request_id), f.config);
  assert.equal(Object.hasOwn(params, 'allow_promotion_codes'), false);
  await f.service.create(f.input); assert.equal(f.store.available(), 497);
});

test('real legacy schemas gain columns without changing paid orders or stock', () => {
  const f = setup(), id = randomUUID();
  f.db.exec(`DROP TABLE reservations; CREATE TABLE reservations (
    request_id TEXT PRIMARY KEY,set_id TEXT NOT NULL,bags INTEGER NOT NULL,amount INTEGER NOT NULL,price_id TEXT NOT NULL,
    created INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,session_id TEXT UNIQUE,session_url TEXT,updated INTEGER NOT NULL);`);
  f.db.prepare(`INSERT INTO reservations VALUES(?, 'trial',3,1280,'price_trial',?,?,'paid','cs_test_legacy',NULL,?)`).run(id, now-100, now+2000, now);
  const migrated = new InventoryStore(f.storage, 'test'), old = migrated.get(id);
  assert.equal(old.checkout_version, 1); assert.equal(old.amount_total, null); assert.equal(old.amount_discount, 0);
  assert.equal(old.state, 'paid'); assert.equal(old.reviewer_code, null); assert.equal(migrated.available(), 497);
  assert.equal(f.fulfillment.store.get(id).amount, 1280);
});

test('a string coupon reference falls back to the expanded applied promotion, while unrelated free codes are rejected', async () => {
  const f = setup(), session = f.free(await f.order());
  session.discounts[0].coupon = 'coupon_review00';
  await f.service.webhook(f.event(session)); assert.equal(f.store.get(f.input.requestId).state, 'paid');
  const other = setup(), bad = other.free(await other.order(), 'OTHERFREE');
  bad.discounts[0].promotion_code.metadata = {};
  await assert.rejects(other.service.webhook(other.event(bad)));
  assert.equal(other.store.get(other.input.requestId).state, 'review');
});

test('free samples are excluded from GA4 purchases and positive discounted sales use the actual amount', () => {
  const row = { state: 'paid', set_id: 'trial', amount: 1280, bags: 3, request_id: randomUUID() };
  const context = { clientId: '123.456', sessionId: 1000 };
  assert.equal(purchasePayload({ ...row, reviewer_code: 'Reviewer00', amount_total: 0 }, context, now), null);
  assert.equal(purchasePayload({ ...row, amount_total: 0 }, context, now), null);
  const payload = purchasePayload({ ...row, amount_total: 1000 }, context, now);
  assert.equal(payload.events[0].params.value, 1000); assert.equal(payload.events[0].params.items[0].price, 1000);
});
