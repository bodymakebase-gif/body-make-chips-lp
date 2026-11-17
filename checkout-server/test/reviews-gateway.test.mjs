import test from 'node:test';
import assert from 'node:assert/strict';
import { publicReviewResponse, readReviewJson, relayAdminReview, REVIEW_BODY_LIMIT } from '../src/reviews-gateway.mjs';

const origin = 'https://body-make-chips.jp';
const id = 'aabbeeff-1234-4234-8234-123456789abc';
const envFor = handler => ({ SITE_ORIGIN: origin, TURNSTILE_SECRET_KEY: 'test-only-secret',
  REVIEWS: { getByName(name) { assert.equal(name, 'body-make-chips-reviews'); return { fetch: handler }; } } });
const request = (path = '/reviews', data, headers = {}) => new Request('https://api.example' + path, {
  method: data === undefined ? 'GET' : 'POST',
  headers: { Origin: origin, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
});
const verified = action => async () => Response.json({ success: true, hostname: 'body-make-chips.jp', action });

test('public review reads are CORS restricted and do not touch inventory or Stripe', async () => {
  let calls = 0;
  const env = envFor(async req => { calls++; assert.equal(new URL(req.url).pathname, '/reviews'); return Response.json({ items: [] }); });
  env.SALE_ENABLED = 'false';
  let response = await publicReviewResponse(request(), env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  response = await publicReviewResponse(request('/reviews', undefined, { Origin: 'https://untrusted.example' }), env);
  assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null); assert.equal(calls, 1);
  assert.equal(await publicReviewResponse(request('/availability'), env), null);
});

test('image GET works without Origin for img tags; methods and internal admin headers stay isolated', async () => {
  const env = envFor(async req => { assert.equal(req.headers.get('x-review-actor'), null); return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } }); });
  const req = new Request(`https://api.example/review-images/${id}/${id}`, { headers: { 'x-review-actor': 'forged' } });
  assert.equal((await publicReviewResponse(req, env)).status, 200);
  assert.equal((await publicReviewResponse(request(`/review-images/${id}/${id}`, {}), env)).status, 405);
});

test('verified public submit strips administrative privileges and stores only a salted rate key', async () => {
  let received;
  const env = envFor(async req => { received = req; return Response.json({ status: 'pending' }, { status: 201 }); });
  const data = { submissionId: id, visitorId: id, name: '投稿者', rating: 2, comment: '率直な感想', images: [], consent: true,
    turnstileToken: 'test-token', status: 'published', admin: true, sourceType: 'quoted', sourceUrl: 'https://untrusted.example' };
  const response = await publicReviewResponse(request('/reviews', data, { 'CF-Connecting-IP': '192.0.2.5', 'x-review-actor': 'forged' }), env, verified('review_submit'));
  assert.equal(response.status, 201);
  const clean = await received.json();
  for (const key of ['turnstileToken', 'status', 'admin', 'sourceType', 'sourceUrl']) assert.equal(clean[key], undefined);
  assert.equal(received.headers.get('x-review-actor'), null);
  assert.match(received.headers.get('x-review-rate-key'), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(clean).includes('192.0.2.5'), false);
});

test('Turnstile action and hostname are both checked and network errors fail closed', async () => {
  let calls = 0; const env = envFor(async () => { calls++; return Response.json({}); });
  const input = { turnstileToken: 'test-token' };
  for (const fetcher of [verified('checkout'), async () => Response.json({ success: true, action: 'review_submit', hostname: 'evil.example' }),
    async () => { throw new Error('offline'); }]) {
    assert.ok((await publicReviewResponse(request('/reviews', input), env, fetcher)).status >= 400);
  }
  assert.equal(calls, 0);
  assert.equal((await publicReviewResponse(request('/reviews', {}), env, verified('review_submit'))).status, 403);
});

test('helpful requires its own verification action and only relays vote fields', async () => {
  const env = envFor(async req => { assert.deepEqual(await req.json(), { visitorId: id, helpful: false }); return Response.json({ helpfulCount: 0, helpfulVoted: false }); });
  const response = await publicReviewResponse(request(`/reviews/${id}/helpful`, { visitorId: id, helpful: false, rating: 5, turnstileToken: 'token' }), env, verified('review_helpful'));
  assert.equal(response.status, 200);
});

test('review JSON accepts pictures but bounds streamed bytes, malformed JSON, and content types', async () => {
  await assert.rejects(readReviewJson(new Request('https://example.test', { method: 'POST', body: '{}' })), error => error.code === 'invalid_content_type');
  for (const body of ['null', '[]', '{']) await assert.rejects(readReviewJson(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })));
  await assert.rejects(readReviewJson(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(REVIEW_BODY_LIMIT + 1) })), error => error.status === 413);
});

test('authenticated admin relay preserves full data while replacing spoofed actor', async () => {
  const env = envFor(async req => { assert.equal(req.headers.get('x-review-actor'), 'authenticated-admin'); assert.equal((await req.json()).status, 'published'); return Response.json({ item: {} }); });
  assert.equal((await relayAdminReview(request('/admin/api/reviews', { status: 'published' }, { 'x-review-actor': 'forged' }), env, 'authenticated-admin')).status, 200);
  await assert.rejects(relayAdminReview(request('/admin/api/summary'), env, 'admin'), error => error.status === 404);
});

test('Japanese administrator identity survives the HTTP relay without invalid header bytes', async () => {
  const env = envFor(async req => {
    assert.equal(decodeURIComponent(req.headers.get('x-review-actor')), '管理者');
    return Response.json({ items: [] });
  });
  assert.equal((await relayAdminReview(request('/admin/api/reviews'), env, '管理者')).status, 200);
});
