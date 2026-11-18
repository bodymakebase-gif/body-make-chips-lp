import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { ReviewsStore, reviewApi, REVIEW_LIMITS } from '../src/reviews.mjs';

const RATE = 'a'.repeat(64);
const png = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XQAAAAASUVORK5CYII=' };
const webp = { mime: 'image/webp', data: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA' };
function setup() {
  const db = new DatabaseSync(':memory:'); let now = 1800000000;
  const storage = { sql: { exec(query, ...bindings) {
    if (!bindings.length && query.includes('CREATE TABLE')) { db.exec(query); return; }
    // Cloudflare binds and returns ArrayBuffer for BLOBs; node:sqlite uses Uint8Array.
    const params = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...params).map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value]))) : (statement.run(...params), []);
    return { toArray: () => rows, one() { assert.equal(rows.length, 1); return rows[0]; } };
  } }, transactionSync(fn) {
    db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  const store = new ReviewsStore(storage, () => now);
  return { db, storage, store, advance: seconds => { now += seconds; } };
}
const input = (extra = {}) => ({ submissionId: randomUUID(), visitorId: randomUUID(), name: 'お客様',
  rating: 4, comment: '歯ごたえと薄塩の味が気に入りました。', images: [], consent: true, website: '', ...extra });
const admin = { admin: true, actor: '管理者' };
const publicOptions = { rateKey: RATE };
const code = expected => error => error.code === expected;
const req = (path, body, method = body === undefined ? 'GET' : 'POST') => new Request(`https://reviews.internal${path}`, {
  method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
async function published(store, extra = {}) { return (await store.create(input(extra), admin)).item; }

test('public negative reviews publish immediately with images and votes; admin hide and delete remove public access', async () => {
  const { store } = setup(); const first = input({ rating: 1, comment: 'まずい。私には合いませんでした。価格も高く感じます。', images: [png] });
  const result = await store.create(first, publicOptions);
  assert.deepEqual(result, { id: first.submissionId, status: 'published', duplicate: false });
  const publicItems = (await store.list()).items;
  assert.equal(publicItems.length, 1); assert.equal(publicItems[0].rating, 1); assert.equal(publicItems[0].comment, first.comment);
  assert.equal(store.summary().count, 1); assert.equal(store.summary().average, 1);
  const review = (await store.list({ admin: true, status: 'published' })).items[0];
  assert.equal(review.adminPosted, false); assert.equal(review.status, 'published');
  assert.match(review.images[0].url, /^\/admin\/api\/review-images\//);
  const image = store.image(review.id, review.images[0].id, { admin: true });
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal(image.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal((await image.arrayBuffer()).byteLength, Buffer.from(png.data, 'base64').length);
  const visible = publicItems[0];
  assert.equal(visible.status, undefined); assert.equal(visible.createdBy, undefined);
  assert.match(visible.images[0].url, /^\/review-images\//);
  assert.equal(store.image(visible.id, visible.images[0].id).status, 200);
  assert.equal(store.image(visible.id, visible.images[0].id).headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  assert.equal((await store.vote(review.id, { visitorId: randomUUID(), helpful: true }, publicOptions)).helpfulCount, 1);
  await store.update(review.id, { status: 'hidden', version: review.version, operationId: randomUUID() });
  assert.equal((await store.list()).items.length, 0); assert.equal(store.summary().count, 0);
  assert.throws(() => store.image(review.id, visible.images[0].id), code('review_not_found'));
  await assert.rejects(store.vote(review.id, { visitorId: randomUUID(), helpful: true }, publicOptions), code('review_not_found'));
  assert.deepEqual(await store.create(first, publicOptions), { id: review.id, status: 'received', duplicate: true });
  assert.equal(store.raw(review.id).status, 'hidden');
  const deletion = { operationId: randomUUID(), version: store.raw(review.id).version };
  await store.delete(review.id, deletion); await store.delete(review.id, deletion);
  assert.deepEqual(await store.create(first, publicOptions), { id: review.id, status: 'received', duplicate: true });
  assert.equal(store.raw(review.id), undefined);
});

test('public create is retry-safe, cannot smuggle admin fields, and survives moderation or deletion', async () => {
  const { store } = setup(); const first = input({ status: 'hidden', sourceType: 'owner', sourceName: '偽の出典', permissionConfirmed: true, adminPosted: true });
  const [a,b] = await Promise.all([store.create(first, publicOptions), store.create(first, publicOptions)]);
  assert.equal(a.id, b.id); assert.equal(a.status, 'published'); assert.equal(b.status, 'published');
  assert.equal((await store.list({ admin: true, status: 'all' })).items.length, 1);
  const row = store.raw(a.id); assert.equal(row.status, 'published'); assert.equal(row.source_type, 'customer'); assert.equal(row.admin_posted, 0);
  assert.equal(row.source_name, ''); assert.equal(row.permission_confirmed, 0);
  await assert.rejects(store.create({ ...first, comment: '異なる本文' }, publicOptions), code('request_conflict'));
  await store.delete(a.id, { operationId: randomUUID() });
  assert.deepEqual(await store.create(first, publicOptions), { id: a.id, status: 'received', duplicate: true });
  assert.equal((await store.list({ admin: true, status: 'all' })).items.length, 0);
});

test('a submission replay matches the original pending fingerprint without approving legacy pending content', async () => {
  const { store, db } = setup(); const submission = input({ rating: 1, comment: '以前の投稿です。私には味が合いませんでした。' });
  const visitorHash = createHash('sha256').update(submission.visitorId).digest('hex');
  // This is the previously deployed request fingerprint, independently built from the old public fields.
  const legacyHash = createHash('sha256').update(JSON.stringify({ name: submission.name, rating: submission.rating,
    comment: submission.comment, status: 'pending', sourceType: 'customer', sourceName: '', sourceUrl: '', reviewedAt: '',
    permissionConfirmed: 0, images: [], visitorId: visitorHash, admin: false })).digest('hex');
  db.prepare(`INSERT INTO reviews(id,name,rating,comment,status,source_type,created_at,updated_at)
    VALUES(?,?,?,?,'pending','customer',?,?)`).run(submission.submissionId, submission.name, submission.rating, submission.comment, 1800000000, 1800000000);
  db.prepare('INSERT INTO review_operations(id,kind,review_id,hash,created_at) VALUES(?,?,?,?,?)')
    .run(submission.submissionId, 'create', submission.submissionId, legacyHash, 1800000000);
  assert.deepEqual(await store.create(submission, publicOptions), { id: submission.submissionId, status: 'pending', duplicate: true });
  assert.deepEqual(await store.create({ ...submission, status: 'published' }, publicOptions), { id: submission.submissionId, status: 'pending', duplicate: true });
  assert.equal(store.raw(submission.submissionId).status, 'pending'); assert.equal(store.raw(submission.submissionId).version, 1);
  assert.equal(store.summary().count, 0); assert.equal((await store.list()).items.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 1);
  await assert.rejects(store.create({ ...submission, comment: '内容を変更した再送' }, publicOptions), code('request_conflict'));
  await store.update(submission.submissionId, { status: 'published' });
  assert.deepEqual(await store.create(submission, publicOptions), { id: submission.submissionId, status: 'published', duplicate: true });
});

test('one public submission per visitor per rolling day; retries do not consume IP limits', async () => {
  const { store, advance } = setup(); const first = input();
  await store.create(first, publicOptions);
  for (let i = 0; i < 12; i++) await store.create(first, publicOptions);
  await assert.rejects(store.create(input({ visitorId: first.visitorId }), publicOptions), code('review_rate_limited'));
  for (let i = 0; i < 9; i++) await store.create(input(), publicOptions);
  await assert.rejects(store.create(input(), publicOptions), code('review_rate_limited'));
  advance(86400);
  await store.create(input({ visitorId: first.visitorId }), publicOptions);
});

test('public traffic requires trusted rate keys, while authenticated admin bypasses public daily limits', async () => {
  const { store } = setup();
  await assert.rejects(store.create(input()), code('reviews_not_ready'));
  for (let i = 0; i < 15; i++) await published(store);
  assert.equal((await store.list({ admin: true, status: 'all' })).counts.all, 15);
  assert.equal(store.summary().count, 15);
});

test('helpful counts rank independently of stars, support undo, and are visitor-specific and idempotent', async () => {
  const { store, advance } = setup(); const one = await published(store, { rating: 1 });
  advance(1); const five = await published(store, { rating: 5 }); const voter = randomUUID();
  assert.equal((await store.list()).items[0].id, five.id);
  assert.deepEqual(await store.vote(one.id, { visitorId: voter, helpful: true }, publicOptions), { helpfulCount: 1, helpfulVoted: true });
  for (let i = 0; i < 70; i++) assert.equal((await store.vote(one.id, { visitorId: voter, helpful: true }, publicOptions)).helpfulCount, 1);
  assert.equal((await store.list({ visitorId: voter })).items[0].id, one.id);
  assert.equal((await store.list({ visitorId: voter })).items[0].helpfulVoted, true);
  assert.equal((await store.list({ visitorId: randomUUID() })).items[0].helpfulVoted, false);
  assert.equal(store.summary().average, 3);
  await store.vote(one.id, { visitorId: voter, helpful: false }, publicOptions);
  assert.equal((await store.list()).items[0].id, five.id);
  assert.equal((await store.vote(one.id, { visitorId: voter, helpful: false })).helpfulCount, 0);
});

test('hidden or pending reviews cannot be voted or expose their images; status change updates totals immediately', async () => {
  const { store } = setup(); const review = await published(store, { images: [png] });
  await store.vote(review.id, { visitorId: randomUUID(), helpful: true }, publicOptions);
  await store.update(review.id, { status: 'hidden' });
  assert.equal((await store.list()).items.length, 0); assert.equal(store.summary().count, 0);
  await assert.rejects(store.vote(review.id, { visitorId: randomUUID(), helpful: true }, publicOptions), code('review_not_found'));
  assert.throws(() => store.image(review.id, review.images[0].id), code('review_not_found'));
  assert.equal((await store.list({ admin: true, status: 'hidden' })).items[0].helpfulCount, 1);
});

test('server throttles vote toggling with hashed visitor identity and permits voting after expiry', async () => {
  const { store, db, advance } = setup(); const review = await published(store); const voter = randomUUID();
  for (let i = 0; i < 60; i++) await store.vote(review.id, { visitorId: voter, helpful: i % 2 === 0 }, publicOptions);
  await assert.rejects(store.vote(review.id, { visitorId: voter, helpful: true }, publicOptions), code('review_rate_limited'));
  const hashed = createHash('sha256').update(voter).digest('hex');
  assert.equal(db.prepare('SELECT count FROM review_rate_limits WHERE bucket=?').get(`vote:visitor:${hashed}`).count, 60);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_rate_limits WHERE bucket LIKE ?').get(`%${voter}%`).n, 0);
  advance(3600);
  assert.equal((await store.vote(review.id, { visitorId: voter, helpful: true }, publicOptions)).helpfulCount, 1);
});

test('admin imports require permission, honest provenance, valid dates and HTTPS attribution URLs', async () => {
  const { store } = setup();
  for (const sourceType of ['quoted','monitor']) {
    await assert.rejects(published(store, { sourceType }), code('review_permission_required'));
    const review = await published(store, { sourceType, sourceName: '提供元', sourceUrl: 'https://example.com/review', reviewedAt: '2026-11-01', permissionConfirmed: true });
    assert.equal(review.adminPosted, true); assert.equal(review.sourceType, sourceType); assert.equal(review.permissionConfirmed, true);
  }
  for (const sourceUrl of ['http://example.com', 'javascript:alert(1)', 'https://user:password@example.com'])
    await assert.rejects(published(store, { sourceUrl }), code('invalid_source_url'));
  for (const reviewedAt of ['2026-02-30','2026-13-01','yesterday']) await assert.rejects(published(store, { reviewedAt }));
});

test('admin updates retain selected images, reject foreign image IDs and retry without duplicate images', async () => {
  const { store } = setup(); const review = await published(store, { images: [png, png] });
  const operation = { operationId: randomUUID(), version: review.version, keepImageIds: [review.images[1].id], images: [png], comment: '編集後の感想です。' };
  const first = await store.update(review.id, operation), retry = await store.update(review.id, operation);
  assert.equal(first.item.version, 2); assert.equal(retry.item.version, 2); assert.equal(retry.duplicate, true);
  assert.equal(first.item.images.length, 2); assert.deepEqual(first.item.images, retry.item.images);
  assert.equal(first.item.images[0].id, review.images[1].id);
  assert.throws(() => store.image(review.id, review.images[0].id, { admin: true }), code('review_not_found'));
  await assert.rejects(store.update(review.id, { ...operation, comment: '内容を変えた再利用' }), code('request_conflict'));
  await assert.rejects(store.update(review.id, { keepImageIds: [randomUUID()] }), code('invalid_review_images'));
  await assert.rejects(store.update(review.id, { version: 1, status: 'hidden' }), code('review_changed'));
});

test('hard delete removes image bytes and votes and retry does not resurrect data', async () => {
  const { store, db } = setup(); const review = await published(store, { images: [png] });
  await store.vote(review.id, { visitorId: randomUUID(), helpful: true }, publicOptions);
  const operation = { operationId: randomUUID(), version: review.version };
  assert.equal((await store.delete(review.id, operation)).deleted, true);
  assert.equal((await store.delete(review.id, operation)).duplicate, true);
  for (const table of ['reviews','review_images','review_votes']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
});

test('image validation rejects SVG, remote URLs, mismatched MIME, malformed base64 and excessive uploads', async () => {
  const { store } = setup();
  const bad = [ [{ mime: 'image/svg+xml', data: btoa('<svg></svg>') }],
    [{ mime: 'image/png', url: 'https://example.com/image.png' }], [{ ...png, mime: 'image/jpeg' }],
    [{ ...png, data: png.data + '\n' }], [{ ...png, data: 'not_base64' }],
    [{ ...png, data: 'A'.repeat(4 * Math.ceil(REVIEW_LIMITS.imageBytes / 3) + 4) }], [png,png,png,png] ];
  for (const images of bad) await assert.rejects(published(store, { images }), code('invalid_review_images'));
  assert.equal(store.summary().count, 0);
});

test('valid WebP frames are stored as BLOBs; malformed containers and excessive decoded dimensions are rejected', async () => {
  const { store } = setup();
  const good = await published(store, { images: [webp] });
  const response = store.image(good.id, good.images[0].id);
  assert.equal(response.headers.get('Content-Type'), 'image/webp');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(webp.data, 'base64'));
  const largePng = Buffer.from(png.data, 'base64'); largePng.writeUInt32BE(10000, 16);
  const largeWebp = Buffer.from(webp.data, 'base64'); largeWebp.writeUInt16LE(10000, 26);
  const wrongSize = Buffer.from(webp.data, 'base64'); wrongSize.writeUInt32LE(99999, 4);
  const truncated = Buffer.from(png.data, 'base64').subarray(0, -3);
  for (const [mime, bytes] of [['image/png',largePng],['image/webp',largeWebp],['image/webp',wrongSize],['image/png',truncated]])
    await assert.rejects(published(store, { images: [{ mime, data: bytes.toString('base64') }] }), code('invalid_review_images'));
});

test('only SHA256 visitor identifiers are persisted, and rejected IP votes roll back other limit counters', async () => {
  const { store, db } = setup(); const submission = input();
  await store.create(submission, publicOptions);
  const submitter = db.prepare('SELECT visitor_id FROM review_submitters').get().visitor_id;
  assert.equal(submitter, createHash('sha256').update(submission.visitorId).digest('hex'));
  const review = await published(store), voter = randomUUID();
  // Use the real rate-limit path to exhaust this IP independently of visitor quotas.
  for (let i = 0; i < 180; i++) await store.vote(review.id, { visitorId: randomUUID(), helpful: true }, publicOptions);
  await assert.rejects(store.vote(review.id, { visitorId: voter, helpful: true }, publicOptions), code('review_rate_limited'));
  const hash = createHash('sha256').update(voter).digest('hex');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_rate_limits WHERE bucket=?').get(`vote:visitor:${hash}`).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_votes WHERE visitor_id=?').get(voter).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_votes').get().n, 180);
});

test('failed storage writes roll back review, images, operations and public submission limits atomically', async () => {
  const { store, storage, db } = setup(); const exec = storage.sql.exec;
  storage.sql.exec = (query, ...params) => { if (query.startsWith('INSERT INTO review_images')) throw new Error('storage unavailable'); return exec(query, ...params); };
  const submission = input({ images: [png] });
  await assert.rejects(store.create(submission, publicOptions), /storage unavailable/);
  for (const table of ['reviews','review_images','review_operations','review_submitters','review_rate_limits']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  storage.sql.exec = exec; await store.create(submission, publicOptions);
});

test('API enforces access boundary, methods, payload limit, validation and non-cacheable errors', async () => {
  const { store } = setup();
  let response = await reviewApi(req('/reviews', input()), store, publicOptions);
  assert.equal(response.status, 201); assert.equal((await response.json()).status, 'published');
  response = await reviewApi(req('/admin/api/reviews'), store);
  assert.equal(response.status, 404);
  response = await reviewApi(req('/reviews', input(), 'PUT'), store, publicOptions);
  assert.equal(response.status, 405); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  for (const body of [input({ rating: 6 }), input({ rating: '4' }), input({ name: '' }), input({ name: 'x'.repeat(41) }), input({ comment: 'x'.repeat(2001) }), input({ consent: false }), input({ website: 'spam' }), input({ submissionId: "'); DROP TABLE reviews;--" })]) {
    response = await reviewApi(req('/reviews', body), store, publicOptions); assert.equal(response.status, 400);
  }
  response = await reviewApi(new Request('https://reviews.internal/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(REVIEW_LIMITS.bodyBytes + 1) }), store, publicOptions);
  assert.equal(response.status, 413);
  response = await reviewApi(req('/reviews?sort=rating'), store); assert.equal(response.status, 400);
  response = await reviewApi(req('/reviews?page=-1'), store); assert.equal(response.status, 400);
});

test('admin API previews pending images, paginates and filters counts; public summary spans all published pages', async () => {
  const { store, advance } = setup();
  for (let i = 0; i < 12; i++) { await published(store, { rating: i % 5 + 1 }); advance(1); }
  const pending = (await store.create(input({ status: 'pending', images: [png] }), admin)).item;
  const pages = [];
  for (let number = 1; number <= 3; number++) {
    const response = await reviewApi(req(`/reviews?page=${number}`), store); const page = await response.json();
    assert.equal(page.page, number); assert.equal(page.items.length, 4);
    assert.equal(page.hasMore, number < 3); assert.equal(page.summary.count, 12);
    assert.equal(page.summary.average, 2.75); pages.push(page);
  }
  assert.equal(new Set(pages.flatMap(page => page.items.map(item => item.id))).size, 12);
  assert.deepEqual(pages[1].summary, pages[0].summary); assert.deepEqual(pages[2].summary, pages[0].summary);
  assert.equal(REVIEW_LIMITS.adminPageSize, 20);
  let response;
  response = await reviewApi(req('/admin/api/reviews?status=pending'), store, admin); const listed = await response.json();
  assert.equal(listed.items[0].id, pending.id); assert.equal(listed.counts.pending, 1); assert.equal(listed.counts.published, 12);
  response = await reviewApi(req(listed.items[0].images[0].url), store, admin); assert.equal(response.status, 200);
  response = await reviewApi(req(listed.items[0].images[0].url), store); assert.equal(response.status, 404);
});
