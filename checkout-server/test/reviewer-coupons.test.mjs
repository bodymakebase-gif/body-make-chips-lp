import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ReviewerCouponService } from '../src/reviewer-coupons.mjs';

const CONFIG = { prices: { trial: 'price_trial123' }, livemode: false };
const input = (extra = {}) => ({ operationId: randomUUID(), code: 'ReviewerTest01', questionnaire: '試食後アンケート 2026年11月', maxRedemptions: 20, ...extra });
const errorCode = code => error => error.code === code;
const notFound = () => Object.assign(new Error('missing'), { code: 'resource_missing', statusCode: 404 });
const copy = value => structuredClone(value);

function setup({ config = CONFIG, price = {} } = {}) {
  const prices = new Map([[CONFIG.prices.trial, { id: CONFIG.prices.trial, active: true, type: 'one_time', currency: 'jpy',
    unit_amount: 1280, product: 'prod_trial123', livemode: config.livemode, ...price }]]);
  const coupons = new Map(), promotions = new Map(), idempotency = new Map();
  const calls = { prices: [], couponCreates: [], couponRetrieves: [], promotionCreates: [], promotionUpdates: [], lists: [] };
  const failures = { couponAfterWrite: false, promotionBeforeWrite: false, promotionAfterWrite: false, stopAfterWrite: false };
  let next = 1;
  const couponView = (coupon, params = {}) => {
    const result = copy(coupon);
    if (!params.expand?.includes('applies_to')) delete result.applies_to;
    return result;
  };
  const expanded = (promotion, params = {}) => {
    const result = copy(promotion), id = result.promotion?.coupon;
    const paths = (params.expand || []).map(path => path.replace(/^data\./, ''));
    if (typeof id === 'string' && coupons.has(id) && paths.some(path => path.startsWith('promotion.coupon'))) {
      result.promotion.coupon = couponView(coupons.get(id), {
        expand: paths.includes('promotion.coupon.applies_to') ? ['applies_to'] : [],
      });
    }
    return result;
  };
  const stripe = {
    prices: { retrieve: async id => { calls.prices.push(id); if (!prices.has(id)) throw notFound(); return copy(prices.get(id)); } },
    coupons: {
      retrieve: async (id, params = {}) => {
        calls.couponRetrieves.push({ id, params: copy(params) });
        if (!coupons.has(id)) throw notFound(); return couponView(coupons.get(id), params);
      },
      create: async (params, options) => {
        calls.couponCreates.push({ params: copy(params), options: copy(options) });
        if (idempotency.has(options.idempotencyKey)) return couponView(idempotency.get(options.idempotencyKey), params);
        if (coupons.has(params.id)) throw Object.assign(new Error('already exists'), { code: 'resource_already_exists' });
        const coupon = { ...copy(params), object: 'coupon', livemode: config.livemode, amount_off: null, valid: true, times_redeemed: 0 };
        coupons.set(coupon.id, coupon); idempotency.set(options.idempotencyKey, coupon);
        if (failures.couponAfterWrite) { failures.couponAfterWrite = false; throw new Error('response lost'); }
        return couponView(coupon, params);
      },
    },
    promotionCodes: {
      list: async params => {
        calls.lists.push(copy(params));
        let data = [...promotions.values()];
        if (params.code) data = data.filter(item => item.code.toLowerCase() === params.code.toLowerCase());
        if (params.starting_after) data = data.slice(data.findIndex(item => item.id === params.starting_after) + 1);
        return { data: data.slice(0, params.limit).map(item => expanded(item, params)), has_more: data.length > params.limit };
      },
      retrieve: async (id, params = {}) => { if (!promotions.has(id)) throw notFound(); return expanded(promotions.get(id), params); },
      create: async (params, options) => {
        calls.promotionCreates.push({ params: copy(params), options: copy(options) });
        if (failures.promotionBeforeWrite) { failures.promotionBeforeWrite = false; throw new Error('request failed'); }
        if (idempotency.has(options.idempotencyKey)) return copy(idempotency.get(options.idempotencyKey));
        assert.equal(params.coupon, undefined, 'Stripe 23 requires the nested promotion parameter');
        assert.equal(params.promotion.type, 'coupon');
        if ([...promotions.values()].some(item => item.active && item.code.toLowerCase() === params.code.toLowerCase())) throw new Error('code already exists');
        const promotion = { ...copy(params), id: `promo_${next++}`, object: 'promotion_code', livemode: config.livemode,
          active: true, times_redeemed: 0, expires_at: null, customer: null, customer_account: null,
          restrictions: { first_time_transaction: false, minimum_amount: null } };
        promotions.set(promotion.id, promotion); idempotency.set(options.idempotencyKey, promotion);
        if (failures.promotionAfterWrite) { failures.promotionAfterWrite = false; throw new Error('response lost'); }
        return copy(promotion);
      },
      update: async (id, params, options) => {
        calls.promotionUpdates.push({ id, params: copy(params), options: copy(options) });
        if (idempotency.has(options.idempotencyKey)) return copy(idempotency.get(options.idempotencyKey));
        if (!promotions.has(id)) throw notFound();
        const promotion = { ...promotions.get(id), ...params };
        promotions.set(id, promotion); idempotency.set(options.idempotencyKey, promotion);
        if (failures.stopAfterWrite) { failures.stopAfterWrite = false; throw new Error('response lost'); }
        return expanded(promotion);
      },
    },
  };
  return { stripe, service: new ReviewerCouponService(stripe, config), prices, coupons, promotions, calls, failures, idempotency };
}

test('creates one trial-product-only, single-payment 100% coupon and a bounded shared promotion code', async () => {
  const { service, calls, coupons, promotions } = setup(); const value = input();
  const result = await service.create(value);
  assert.deepEqual(result, { coupon: { id: 'promo_1', code: value.code, questionnaire: value.questionnaire,
    maxRedemptions: 20, timesRedeemed: 0, active: true, expiresAt: null } });
  assert.equal(coupons.size, 1); assert.equal(promotions.size, 1);
  const created = calls.couponCreates[0], coupon = [...coupons.values()][0];
  assert.equal(created.params.percent_off, 100); assert.equal(created.params.duration, 'once');
  assert.deepEqual(created.params.expand, ['applies_to']);
  assert.equal(created.params.max_redemptions, 20); assert.deepEqual(created.params.applies_to, { products: ['prod_trial123'] });
  assert.equal(created.params.amount_off, undefined); assert.equal(created.params.currency, undefined);
  for (const metadata of [created.params.metadata, calls.promotionCreates[0].params.metadata]) {
    assert.equal(metadata.bmc_purpose, 'reviewer'); assert.equal(metadata.bmc_set_id, 'trial');
    assert.equal(metadata.bmc_questionnaire, value.questionnaire); assert.equal(metadata.bmc_operation_id, value.operationId);
  }
  assert.deepEqual(calls.promotionCreates[0].params.promotion, { type: 'coupon', coupon: coupon.id });
  assert.equal(calls.promotionCreates[0].params.max_redemptions, 20);
  assert.match(created.options.idempotencyKey, new RegExp(value.operationId));
  assert.match(calls.promotionCreates[0].options.idempotencyKey, new RegExp(value.operationId));
  assert.notEqual(created.options.idempotencyKey, calls.promotionCreates[0].options.idempotencyKey);
});

test('validates the exact live/test mode, JPY trial amount, active one-time price and product before creating anything', async () => {
  for (const price of [{ active: false }, { currency: 'usd' }, { unit_amount: 3980 }, { type: 'recurring' },
    { livemode: true }, { product: null }, { product: { id: 'prod_trial123', deleted: true } }, { id: 'price_other' }]) {
    const { service, calls } = setup({ price });
    await assert.rejects(service.create(input()), errorCode('reviewer_coupon_not_ready'));
    assert.equal(calls.couponCreates.length, 0); assert.equal(calls.promotionCreates.length, 0);
  }
  const expanded = setup({ price: { product: { id: 'prod_trial123' } } });
  await expanded.service.create(input()); assert.equal(expanded.promotions.size, 1);
});

test('rejects malformed input, arbitrary discount settings, questionnaire control characters and unsafe use limits', async () => {
  const { service, calls } = setup();
  const invalid = [{ operationId: 'not-a-uuid' }, { code: 'Reviewer1' }, { code: 'PublicCoupon01' },
    { code: 'Reviewerab-cd' }, { code: 'Reviewer' + 'x'.repeat(51) }, { questionnaire: '' }, { questionnaire: '   ' },
    { questionnaire: 'label\nchanged' }, { questionnaire: 'x'.repeat(81) }, { maxRedemptions: 0 },
    { maxRedemptions: 10001 }, { maxRedemptions: '20' }, { maxRedemptions: 1.5 }, { percentOff: 50 }, { expiresAt: 1800000000 }];
  for (const value of invalid) await assert.rejects(service.create(input(value)), errorCode('reviewer_coupon_invalid'));
  assert.equal(calls.prices.length, 0); assert.equal(calls.couponCreates.length, 0);
  const valid = await service.create(input({ code: 'reviewerAb', questionnaire: '日本語のラベル', maxRedemptions: 1 }));
  assert.equal(valid.coupon.maxRedemptions, 1);
});

test('supports merchant-provided Stripe Product IDs while retaining the exact verified trial scope', async () => {
  const product = 'bmc_trial_lp_20261009';
  const { service, calls, coupons } = setup({ price: { product } });
  const value = input();
  const first = await service.create(value);
  assert.deepEqual(calls.couponCreates[0].params.applies_to, { products: [product] });
  assert.deepEqual(await service.create(value), first);
  [...coupons.values()][0].applies_to.products = ['bmc_desk_lp_20261009'];
  await assert.rejects(service.create({ ...value, operationId: randomUUID() }), errorCode('reviewer_coupon_conflict'));
});

test('explicitly expands product restrictions and hydrates shallow expanded coupons when applies_to is absent', async () => {
  const { service, stripe, calls } = setup(); const first = await service.create(input());
  const couponId = calls.couponCreates[0].params.id;
  assert.equal((await stripe.coupons.retrieve(couponId)).applies_to, undefined,
    'Stripe does not return applies_to without an explicit expansion');
  const shallow = await stripe.promotionCodes.retrieve(first.coupon.id, { expand: ['promotion.coupon'] });
  assert.equal(typeof shallow.promotion.coupon, 'object');
  assert.equal(shallow.promotion.coupon.applies_to, undefined);
  const list = stripe.promotionCodes.list;
  stripe.promotionCodes.list = async params => {
    const result = await list(params);
    for (const promotion of result.data) if (typeof promotion.promotion?.coupon === 'object') delete promotion.promotion.coupon.applies_to;
    return result;
  };
  assert.deepEqual((await service.list()).items, [first.coupon]);
  assert.deepEqual(calls.couponRetrieves.at(-1), { id: couponId, params: { expand: ['applies_to'] } });
  assert.deepEqual(calls.lists.at(-1).expand, ['data.promotion.coupon.applies_to']);
});

test('retries and case-insensitive duplicate codes do not create new promotions or change questionnaire history', async () => {
  const { service, calls, promotions } = setup(); const value = input();
  const first = await service.create(value), retry = await service.create(value);
  assert.deepEqual(retry, first);
  const duplicate = await service.create({ ...value, operationId: randomUUID(), code: value.code.toLowerCase() });
  assert.deepEqual(duplicate, first);
  assert.equal(calls.couponCreates.length, 1); assert.equal(calls.promotionCreates.length, 1);
  await assert.rejects(service.create({ ...value, questionnaire: '変更されたアンケート' }), errorCode('reviewer_coupon_conflict'));
  await assert.rejects(service.create({ ...value, operationId: randomUUID(), maxRedemptions: 21 }), errorCode('reviewer_coupon_conflict'));
  assert.equal([...promotions.values()][0].metadata.bmc_questionnaire, value.questionnaire);
});

for (const failure of ['couponAfterWrite', 'promotionAfterWrite']) {
  test(`recovers a lost ${failure} response without duplicate discounts`, async () => {
    const { service, failures, coupons, promotions } = setup(); const value = input(); failures[failure] = true;
    const first = await service.create(value), retry = await service.create(value);
    assert.deepEqual(retry, first); assert.equal(coupons.size, 1); assert.equal(promotions.size, 1);
  });
}

test('a permanent coupon ID recovers a partial create after the 24-hour idempotency cache has expired', async () => {
  const { service, failures, idempotency, calls, coupons, promotions } = setup(); const value = input();
  failures.promotionBeforeWrite = true;
  await assert.rejects(service.create(value), /request failed/);
  assert.equal(coupons.size, 1); assert.equal(promotions.size, 0);
  idempotency.clear();
  const result = await service.create(value);
  assert.equal(result.coupon.code, value.code); assert.equal(coupons.size, 1); assert.equal(promotions.size, 1);
  assert.equal(calls.couponCreates.length, 1);
  assert.equal(calls.promotionCreates[0].options.idempotencyKey, calls.promotionCreates[1].options.idempotencyKey);
  await assert.rejects(service.create({ ...value, code: 'ReviewerOther01' }), errorCode('reviewer_coupon_conflict'));
});

test('a code already used for a different purpose is a conflict even when inactive', async () => {
  for (const active of [true, false]) {
    const { service, promotions, calls } = setup();
    promotions.set('promo_foreign', { id: 'promo_foreign', code: 'ReviewerTest01', active, livemode: false,
      metadata: { bmc_purpose: 'other_campaign' }, promotion: { type: 'coupon', coupon: 'foreign_coupon' } });
    await assert.rejects(service.create(input()), errorCode('reviewer_coupon_conflict'));
    assert.equal(calls.couponCreates.length, 0); assert.equal(calls.promotionCreates.length, 0);
  }
});

test('existing reviewer metadata cannot disguise an unrestricted, wrong-product or partial discount', async () => {
  for (const change of [{ applies_to: { products: ['prod_other'] } }, { applies_to: { products: ['prod_trial123', 'prod_other'] } },
    { percent_off: 50 }, { duration: 'forever' }, { livemode: true }]) {
    const { service, coupons } = setup(); const value = input(); await service.create(value);
    Object.assign([...coupons.values()][0], change);
    await assert.rejects(service.create({ ...value, operationId: randomUUID() }), errorCode('reviewer_coupon_conflict'));
  }
});

test('concurrent requests for the same code produce only one redeemable promotion', async () => {
  const { service, promotions } = setup();
  const results = await Promise.all([service.create(input()), service.create(input())]);
  assert.equal(results[0].coupon.id, results[1].coupon.id); assert.equal(promotions.size, 1);
});

test('lists only reviewer promotions and preserves Stripe cursors across unrelated empty pages', async () => {
  const { service, promotions, calls } = setup();
  for (let i = 0; i < 50; i++) promotions.set(`promo_foreign${i}`, { id: `promo_foreign${i}`, code: `Other${i}`, metadata: {}, promotion: {} });
  const created = await service.create(input());
  const first = await service.list();
  assert.deepEqual(first.items, []); assert.equal(first.next, 'promo_foreign49');
  const second = await service.list(first.next);
  assert.deepEqual(second.items, [created.coupon]); assert.equal(second.next, null);
  assert.equal(calls.lists.at(-1).starting_after, first.next);
  await assert.rejects(service.list('not-a-promotion-id'), errorCode('reviewer_coupon_invalid'));
});

test('stopping a reviewer code is idempotent, preserves redemption history and cannot reactivate or edit labels', async () => {
  const { service, promotions, calls, prices } = setup(); const value = input(); const { coupon } = await service.create(value);
  promotions.get(coupon.id).times_redeemed = 7;
  // Stopping an issued code must remain possible after the catalog price is archived.
  prices.get(CONFIG.prices.trial).active = false;
  const operationId = randomUUID();
  const stopped = await service.stop(coupon.id, { operationId, active: false });
  assert.equal(stopped.coupon.active, false); assert.equal(stopped.coupon.timesRedeemed, 7);
  assert.equal(stopped.coupon.questionnaire, value.questionnaire);
  assert.deepEqual(await service.stop(coupon.id, { operationId, active: false }), stopped);
  assert.equal(calls.promotionUpdates.length, 1);
  assert.deepEqual(calls.promotionUpdates[0].params, { active: false });
  await assert.rejects(service.stop(coupon.id, { operationId: randomUUID(), active: true }), errorCode('reviewer_coupon_invalid'));
  await assert.rejects(service.stop(coupon.id, { operationId: randomUUID(), active: false, questionnaire: '書き換え' }), errorCode('reviewer_coupon_invalid'));
});

test('lost stop responses recover on retry, and foreign or missing codes cannot be stopped', async () => {
  const { service, promotions, failures, calls } = setup(); const { coupon } = await service.create(input());
  const operation = { operationId: randomUUID(), active: false }; failures.stopAfterWrite = true;
  await assert.rejects(service.stop(coupon.id, operation), /response lost/);
  assert.equal((await service.stop(coupon.id, operation)).coupon.active, false);
  assert.equal(calls.promotionUpdates.length, 1);
  await assert.rejects(service.stop('promo_missing', operation), errorCode('reviewer_coupon_not_found'));
  promotions.set('promo_foreign', { id: 'promo_foreign', metadata: {} });
  await assert.rejects(service.stop('promo_foreign', operation), errorCode('reviewer_coupon_not_found'));
});

test('a stopped or exhausted existing code is returned inactive and is never silently recreated', async () => {
  const { service, promotions, coupons, calls } = setup(); const value = input(); const first = await service.create(value);
  promotions.get(first.coupon.id).active = false; promotions.get(first.coupon.id).times_redeemed = 20;
  [...coupons.values()][0].valid = false;
  const again = await service.create({ ...value, operationId: randomUUID() });
  assert.equal(again.coupon.active, false); assert.equal(again.coupon.timesRedeemed, 20);
  assert.equal(calls.couponCreates.length, 1); assert.equal(calls.promotionCreates.length, 1);
});
