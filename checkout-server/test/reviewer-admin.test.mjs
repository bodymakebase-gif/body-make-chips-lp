import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { CheckoutError } from '../src/catalog.mjs';
const loader = registerHooks({ load(url, context, next) {
  if (/\/admin\/(index\.html|admin\.css|admin\.js)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))}`, shortCircuit: true };
  return next(url, context);
} });
const { adminApi, validateAdminRequest } = await import('../src/admin.mjs'); loader.deregister();
const origin = 'https://admin.example.test';
function setup(authorized = true) {
  const calls = [];
  const auth = { async authenticate() { if (!authorized) throw new CheckoutError('authentication_required', 401); return { actor: '管理者' }; } };
  const coupons = Object.fromEntries(['list','create','stop'].map(name => [name, async (...args) => { calls.push({ name, args }); return name === 'list' ? { items: [], next: null } : { coupon: { code: 'Reviewer00' } }; }]));
  async function request(path = '', body) {
    const req = new Request(origin + '/admin/api/reviewer-coupons' + path, { method: body ? 'POST' : 'GET',
      headers: { Origin: origin, 'x-bmc-admin': '1', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    validateAdminRequest(req, 'live');
    return adminApi(req, {}, auth, 'unused', req => req.json(), 1000, null, null, null, coupons);
  }
  return { calls, request };
}
test('coupon administration requires the existing administrator authentication before any Stripe call', async () => {
  const f = setup(false);
  for (const [path, body] of [['',undefined],['',{code:'Reviewer00'}],['/promo_sample',{active:false}]]) {
    await assert.rejects(f.request(path, body), e => e.code === 'authentication_required');
  }
  assert.equal(f.calls.length, 0);
});
test('authenticated coupon routes forward the exact page cursor and write identities', async () => {
  const f = setup(), body = { operationId: 'id-kept-by-client', code: 'Reviewer00', questionnaire: 'アンケート00', maxRedemptions: 20 };
  assert.equal((await f.request('?after=promo_cursor')).status, 200);
  await f.request('',body); await f.request('/promo_sample',{operationId:'stop-kept-by-client',active:false});
  assert.deepEqual(f.calls,[{name:'list',args:['promo_cursor']},{name:'create',args:[body]},
    {name:'stop',args:['promo_sample',{operationId:'stop-kept-by-client',active:false}]}]);
});
