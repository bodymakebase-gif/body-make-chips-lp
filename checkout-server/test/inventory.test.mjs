import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../src/inventory.mjs';
import { CheckoutService } from '../src/checkout.mjs';
import { CATALOG } from '../src/catalog.mjs';
import { AdminAuthStore, digest, cookieToken, sessionCookie } from '../src/admin-auth.mjs';

function setup(total = 500) {
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
  const store = new InventoryStore(storage, 'test', total);
  const sessions = new Map(); const ids = new Map();
  const stripe = {
    prices: { async retrieve(id) { const item = CATALOG[id]; return { active:true, type:'one_time', currency:'jpy',unit_amount:item.amount,livemode:false }; } },
    checkout: { sessions: {
      async create(params, {idempotencyKey}) {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (!sessions.has(idempotencyKey)) {
          const item = CATALOG[params.line_items[0].price];
          const session = { ...params, id:`cs_test_${randomUUID().replaceAll('-','')}`, url:'https://checkout.stripe.com/c/pay/test',amount_total:item.amount,currency:'jpy',livemode:false,status:'open',payment_status:'unpaid' };
          sessions.set(idempotencyKey,session); ids.set(session.id,session);
        }
        return sessions.get(idempotencyKey);
      },
      async retrieve(id) { return ids.get(id); },
      list() { return (async function* () { for (const session of ids.values()) yield session; })(); },
    } },
  };
  const service = new CheckoutService(store,stripe,{prices:{trial:'trial',desk:'desk',stock:'stock'},livemode:false,siteOrigin:'https://body-make-chips.jp'},()=>1000000);
  return { store, service, stripe, sessions, ids, storage };
}
const request = setId => ({setId,requestId:randomUUID()});

test('returning customers resume a completed checkout without a second reservation',async()=>{
  const {service,store,ids,sessions}=setup(); const input=request('desk'); await service.create(input);
  const session=ids.get(store.get(input.requestId).session_id);
  session.status='complete'; session.payment_status='paid';
  const result=await service.create(input);
  assert.deepEqual(result,{status:'complete',sessionId:session.id});
  assert.equal(store.available(),490);assert.equal(sessions.size,1);
  assert.deepEqual(await service.create(input),result);
});

test('an integrity incident remains in review even if a later event looks valid',async()=>{
  const {service,store,ids}=setup();const input=request('stock');await service.create(input);
  const session=ids.get(store.get(input.requestId).session_id);session.status='complete';session.payment_status='paid';
  session.amount_total=1;
  const event={id:'evt_mismatch',type:'checkout.session.completed',livemode:false,data:{object:{id:session.id}}};
  await assert.rejects(service.webhook(event));session.amount_total=10500;
  await assert.rejects(service.webhook({...event,id:'evt_later'}));
  assert.equal(store.get(input.requestId).state,'review');assert.equal(store.available(),470);
});
test('concurrent 3/10/30-bag orders cannot exceed 500 bags',async()=>{
  const {service,store}=setup();
  const results=await Promise.allSettled(Array.from({length:120},(_,i)=>service.create(request(['stock','desk','trial'][i%3]))));
  assert.ok(results.some(r=>r.status==='rejected'));
  assert.ok(store.available()>=0);
  assert.ok(store.available()<3);
});
test('duplicate requests reserve once and use one Stripe session',async()=>{
  const {service,store,sessions}=setup(); const input=request('stock');
  const results=await Promise.all(Array.from({length:10},()=>service.create(input)));
  assert.equal(store.available(),470); assert.equal(sessions.size,1);
  assert.equal(new Set(results.map(r=>r.url)).size,1);
});
test('a request ID cannot change its set',async()=>{
  const {service,store}=setup(); const input=request('trial'); await service.create(input);
  await assert.rejects(service.create({...input,setId:'stock'}),e=>e.code==='request_conflict');
  assert.equal(store.available(),497);
});
test('duplicated and out-of-order webhooks cannot release a paid order',async()=>{
  const {service,store,ids}=setup(); const input=request('desk'); await service.create(input);
  const session=ids.get(store.get(input.requestId).session_id); session.status='complete'; session.payment_status='paid';
  const event={id:'evt_paid',type:'checkout.session.completed',livemode:false,data:{object:{id:session.id}}};
  await service.webhook(event); await service.webhook(event);
  await service.webhook({...event,id:'evt_old_expiry',type:'checkout.session.expired'});
  assert.equal(store.available(),490); assert.equal(store.get(input.requestId).state,'paid');
});
test('expired checkout releases bags once',async()=>{
  const {service,store,ids}=setup(); const input=request('stock'); await service.create(input);
  const session=ids.get(store.get(input.requestId).session_id); session.status='expired';
  const event={id:'evt_exp',type:'checkout.session.expired',livemode:false,data:{object:{id:session.id}}};
  await service.webhook(event); await service.webhook(event);
  assert.equal(store.available(),500);
});
test('pending asynchronous payments hold stock until failure or success',async()=>{
  const {service,store,ids}=setup(); const input=request('trial'); await service.create(input);
  const session=ids.get(store.get(input.requestId).session_id); session.status='complete';
  const event={id:'evt_pending',type:'checkout.session.completed',livemode:false,data:{object:{id:session.id}}};
  await service.webhook(event); assert.equal(store.get(input.requestId).state,'pending'); assert.equal(store.available(),497);
  await service.webhook({...event,id:'evt_failed',type:'checkout.session.async_payment_failed'});
  assert.equal(store.available(),500);
});
test('lost create responses retain stock and recover with the same idempotency key',async()=>{
  const {service,store,stripe,sessions}=setup(); const input=request('desk'); const create=stripe.checkout.sessions.create;
  stripe.checkout.sessions.create=async(...args)=>{await create(...args);throw new Error('network timeout');};
  await assert.rejects(service.create(input)); assert.equal(store.available(),490);
  stripe.checkout.sessions.create=create;
  await service.create(input); assert.equal(sessions.size,1); assert.equal(store.available(),490);
});
test('wrong amount, currency, mode or product never becomes paid',async()=>{
  for(const invalid of [{amount_total:1},{currency:'usd'},{mode:'subscription'},{metadata:{set_id:'stock',bags:'30'}}]){
    const {service,store,ids}=setup(); const input=request('trial'); await service.create(input);
    const session=ids.get(store.get(input.requestId).session_id); Object.assign(session,invalid,{status:'complete',payment_status:'paid'});
    await assert.rejects(service.webhook({id:'evt_bad',type:'checkout.session.completed',livemode:false,data:{object:{id:session.id}}}));
    assert.notEqual(store.get(input.requestId).state,'paid'); assert.equal(store.available(),497);
  }
});
test('test and live inventory cannot share a namespace',()=>{
  const {storage}=setup(); assert.throws(()=>new InventoryStore(storage,'live'),/environment mismatch/);
});
test('a delayed completed event cannot reserve stock again after an async failure',async()=>{
  const {service,store,ids}=setup(); const input=request('stock'); await service.create(input);
  const session=ids.get(store.get(input.requestId).session_id); session.status='complete';
  const event={id:'evt_fail_first',type:'checkout.session.async_payment_failed',livemode:false,data:{object:{id:session.id}}};
  await service.webhook(event); await service.webhook({...event,id:'evt_delayed',type:'checkout.session.completed'});
  assert.equal(store.available(),500); assert.equal(store.get(input.requestId).state,'failed');
});
test('reconciliation recovers a lost session after the create retry window',async()=>{
  const {service,store,stripe,ids}=setup(); const input=request('desk'); const create=stripe.checkout.sessions.create;
  stripe.checkout.sessions.create=async(...args)=>{await create(...args);throw new Error('lost response');};
  await assert.rejects(service.create(input));
  service.clock=()=>1002500;
  for(const session of ids.values())session.status='expired';
  await service.reconcile(); assert.equal(store.available(),500); assert.equal(store.get(input.requestId).state,'expired');
});
test('failed create is released only after expiry and a complete successful Stripe lookup',async()=>{
  const {service,store,stripe}=setup(); const input=request('stock');
  stripe.checkout.sessions.create=async()=>{throw new Error('network did not reach Stripe');};
  await assert.rejects(service.create(input)); service.clock=()=>1002300;
  await service.reconcile(); assert.equal(store.available(),470);
  service.clock=()=>1002500;
  stripe.checkout.sessions.list=()=>{throw new Error('Stripe lookup failed');};
  await service.reconcile(); assert.equal(store.available(),470);
  stripe.checkout.sessions.list=()=> (async function*(){})();
  await service.reconcile(); assert.equal(store.available(),500);
});
test('invalid or altered client pricing cannot change the server catalog',async()=>{
  const {service,store}=setup(); const input={...request('trial'),amount:1,bags:1}; await service.create(input);
  assert.equal(store.get(input.requestId).amount,1280); assert.equal(store.get(input.requestId).bags,3);
  await assert.rejects(service.create(request('__proto__')),e=>e.code==='invalid_set');
});

const adjustment = (bags = 10, kind = 'sample') => ({ requestId: randomUUID(), kind, bags, note: 'テスト用' });

test('manual adjustments preserve paid and held reservations and survive reconstruction', async () => {
  const { service, store, ids, storage } = setup();
  const paid = request('desk'), held = request('stock'); await service.create(paid); await service.create(held);
  const session = ids.get(store.get(paid.requestId).session_id); session.status = 'complete'; session.payment_status = 'paid';
  store.applySession(session, 1000000);
  const input = adjustment(); store.adjust(input, '管理者', 1000001);
  assert.deepEqual(store.summary(), { initial: 500, total: 490, adjustments: -10, held: 30, paid: 10, review: 0, available: 450 });
  const reopened = new InventoryStore(storage, 'test'); assert.equal(reopened.available(), 450);
  assert.equal(reopened.history()[0].note, 'テスト用'); assert.equal(reopened.history()[0].after_available, 450);
  store.adjust(adjustment(7, 'receipt'), '管理者', 1000002);
  assert.equal(store.available(), 457); assert.equal(store.get(paid.requestId).state, 'paid');
});

test('manual removal and checkout competition never consume reserved stock', async () => {
  const { service, store } = setup(40); await service.create(request('stock'));
  assert.throws(() => store.adjust(adjustment(11), '管理者', 1), e => e.code === 'insufficient_stock');
  assert.equal(store.available(), 10); assert.equal(store.history().length, 0);
  store.adjust(adjustment(10), '管理者', 2); assert.equal(store.available(), 0);
  await assert.rejects(service.create(request('trial')), e => e.code === 'out_of_stock');
  assert.deepEqual(store.status(), { trial: false, desk: false, stock: false });
});

test('retried manual adjustments apply once even after inventory has changed', () => {
  const { store } = setup(); const input = adjustment();
  store.adjust(input, '管理者', 1); store.adjust(adjustment(3), '管理者', 2);
  assert.equal(store.adjust(input, '管理者', 3).duplicate, true); assert.equal(store.available(), 487);
  assert.throws(() => store.adjust({ ...input, bags: 11 }, '管理者', 4), e => e.code === 'request_conflict');
  assert.equal(store.history().length, 2);
});

test('undo is an audited inverse entry, cannot be repeated or steal allocated stock', async () => {
  const { store, service } = setup(0); const receipt = adjustment(10, 'receipt'); store.adjust(receipt, '管理者', 1);
  await service.create(request('desk'));
  const undo = { requestId: randomUUID(), kind: 'reversal', reversalOf: receipt.requestId, note: '誤登録' };
  assert.throws(() => store.adjust(undo, '管理者', 2), e => e.code === 'insufficient_stock');
  const sample = adjustment(3); store.adjust(adjustment(3, 'receipt'), '管理者', 3); store.adjust(sample, '管理者', 4);
  const cancelSample = { ...undo, requestId: randomUUID(), reversalOf: sample.requestId };
  store.adjust(cancelSample, '管理者', 5); assert.equal(store.available(), 3);
  assert.equal(store.adjust(cancelSample, '管理者', 6).duplicate, true);
  assert.throws(() => store.adjust({ ...cancelSample, requestId: randomUUID() }, '管理者', 7), e => e.code === 'already_reversed');
  assert.equal(store.history().find(r => r.request_id === sample.requestId).reversed_by, cancelSample.requestId);
});

test('invalid quantities, unrecognized reasons and review incidents cannot alter inventory', () => {
  const { store } = setup();
  for (const bags of [-10, 0, 1.5, '10', 100001, Infinity]) assert.throws(() => store.adjust(adjustment(bags), '管理者', 1));
  assert.throws(() => store.adjust(adjustment(1, '__proto__'), '管理者', 1));
  assert.equal(store.available(), 500); assert.equal(store.history().length, 0);
  const reserved = request('trial'); store.reserve(reserved, 'trial', 0);
  store.sql.exec("UPDATE reservations SET state='review' WHERE request_id=?", reserved.requestId);
  assert.throws(() => store.adjust(adjustment(1), '管理者', 1), e => e.code === 'inventory_needs_review');
});

test('history pagination is stable for same-second entries', () => {
  const { store } = setup(); for (let i = 0; i < 30; i++) store.adjust(adjustment(1), '管理者', 1000);
  const first = store.history(); const second = store.history(first.at(-1).seq);
  assert.equal(first.length, 25); assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second].map(r => r.request_id)).size, 30);
});

test('admin sessions require the correct key and expire, revoke on logout or key rotation', async () => {
  const { storage } = setup(); const auth = new AdminAuthStore(storage); const hash = await digest('random-test-key');
  await assert.rejects(auth.login('wrong', hash, 'ip-a', 1), e => e.code === 'invalid_admin_key');
  const token = await auth.login('random-test-key', hash, 'ip-a', 2);
  assert.equal((await auth.authenticate(token, hash, 3)).actor, '管理者');
  assert.equal(cookieToken(new Request('https://example.com', { headers: { cookie: sessionCookie(token) } })), token);
  await assert.rejects(auth.authenticate(token, hash, 28802), e => e.code === 'authentication_required');
  await assert.rejects(auth.authenticate(token, await digest('rotated'), 3), e => e.code === 'authentication_required');
  await auth.logout(token); await assert.rejects(auth.authenticate(token, hash, 3), e => e.code === 'authentication_required');
});

test('admin brute force attempts are throttled and missing configuration fails closed', async () => {
  const { storage } = setup(); const auth = new AdminAuthStore(storage), hash = await digest('test-key');
  for (let i = 0; i < 8; i++) await assert.rejects(auth.login('wrong', hash, 'ip-a', 1), e => e.code === 'invalid_admin_key');
  await assert.rejects(auth.login('test-key', hash, 'ip-a', 2), e => e.code === 'too_many_attempts');
  assert.ok(await auth.login('test-key', hash, 'ip-a', 902));
  await assert.rejects(auth.login('test-key', '', 'ip-a', 903), e => e.code === 'admin_not_configured');
});
