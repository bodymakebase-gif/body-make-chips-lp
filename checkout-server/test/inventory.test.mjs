import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../src/inventory.mjs';
import { CheckoutService } from '../src/checkout.mjs';
import { CATALOG } from '../src/catalog.mjs';

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
