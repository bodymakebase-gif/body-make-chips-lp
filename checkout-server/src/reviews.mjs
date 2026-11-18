import { CheckoutError } from './catalog.mjs';

export const REVIEW_LIMITS = Object.freeze({ name: 40, comment: 2000, images: 3,
  imageBytes: 300 * 1024, bodyBytes: 1536 * 1024, publicPageSize: 4, adminPageSize: 20 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const statuses = new Set(['pending', 'published', 'hidden']);
const sources = new Set(['customer', 'monitor', 'quoted', 'owner']);
const fail = (code = 'invalid_review', status = 400) => { throw new CheckoutError(code, status); };
const uuid = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : fail('invalid_review_id');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail();
function text(value, max, required = false, multiline = false) {
  if (typeof value !== 'string' || value.length > max ||
      (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) fail();
  const result = value.trim();
  if (required && !result) fail();
  return result;
}
function date(value) {
  if (value === '' || value == null) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '1900-01-01') fail();
  return value;
}
function sourceUrl(value = '') {
  const result = text(value, 2048);
  if (!result) return '';
  let url; try { url = new URL(result); } catch { fail('invalid_source_url'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('invalid_source_url');
  return url.href;
}
const iso = seconds => new Date(seconds * 1000).toISOString();
async function digest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function validImage(bytes, mime) {
  const b = new Uint8Array(bytes), view = new DataView(bytes);
  const dimensions = (width, height) => width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16000000;
  if (b.length < 24) return false;
  if (mime === 'image/png') {
    if (!(b.length >= 45 && [137,80,78,71,13,10,26,10].every((n,i) => b[i] === n) &&
      view.getUint32(8) === 13 && String.fromCharCode(...b.slice(12,16)) === 'IHDR' &&
      dimensions(view.getUint32(16), view.getUint32(20)))) return false;
    let data = false;
    for (let p = 8; p + 12 <= b.length;) {
      const length = view.getUint32(p), type = String.fromCharCode(...b.slice(p + 4,p + 8));
      if (length > b.length - p - 12) return false;
      if (type === 'IDAT' && length > 0) data = true;
      if (type === 'IEND') return length === 0 && p + 12 === b.length && data;
      p += 12 + length;
    }
    return false;
  }
  if (mime === 'image/webp') {
    if (b.length < 30 || String.fromCharCode(...b.slice(0,4)) !== 'RIFF' || view.getUint32(4, true) + 8 !== b.length ||
        String.fromCharCode(...b.slice(8,12)) !== 'WEBP') return false;
    let frame = false;
    for (let p = 12; p + 8 <= b.length;) {
      const type = String.fromCharCode(...b.slice(p,p + 4)), length = view.getUint32(p + 4, true), start = p + 8;
      if (length > b.length - start) return false;
      if (type === 'VP8X') {
        if (length !== 10 || (b[start] & 2)) return false; // Animated uploads are not accepted.
        const width = 1 + b[start+4] + (b[start+5] << 8) + (b[start+6] << 16);
        const height = 1 + b[start+7] + (b[start+8] << 8) + (b[start+9] << 16);
        if (!dimensions(width, height)) return false;
      } else if (type === 'VP8L') {
        if (length < 5 || b[start] !== 47) return false;
        const bits = view.getUint32(start + 1, true);
        if (!dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1)) return false;
        frame = true;
      } else if (type === 'VP8 ') {
        if (length < 10 || (b[start] & 1) || b[start+3] !== 157 || b[start+4] !== 1 || b[start+5] !== 42 ||
            !dimensions(view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383)) return false;
        frame = true;
      }
      p = start + length + (length % 2);
      if (p === b.length) return frame;
    }
    return false;
  }
  if (mime !== 'image/jpeg' || b[0] !== 255 || b[1] !== 216 || b[2] !== 255 || b.at(-2) !== 255 || b.at(-1) !== 217) return false;
  // Check a real JPEG frame header rather than accepting an extension or MIME claim.
  for (let p = 2; p + 8 < b.length;) {
    if (b[p++] !== 255) return false;
    while (b[p] === 255) p++;
    const marker = b[p++];
    if (marker === 218 || marker === 217) return false;
    if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (p + 2 > b.length) return false;
    const length = view.getUint16(p);
    if (length < 2 || p + length > b.length) return false;
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      const height = view.getUint16(p + 3), width = view.getUint16(p + 5);
      return length >= 8 && dimensions(width, height);
    }
    p += length;
  }
  return false;
}
async function images(input = []) {
  if (!Array.isArray(input) || input.length > REVIEW_LIMITS.images) fail('invalid_review_images');
  return Promise.all(input.map(async image => {
    object(image);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mime) || typeof image.data !== 'string' ||
        image.data.length > 4 * Math.ceil(REVIEW_LIMITS.imageBytes / 3) || !image.data.length ||
        image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) fail('invalid_review_images');
    let raw; try { raw = atob(image.data); } catch { fail('invalid_review_images'); }
    if (raw.length > REVIEW_LIMITS.imageBytes || btoa(raw) !== image.data) fail('invalid_review_images');
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0)).buffer;
    if (!validImage(bytes, image.mime)) fail('invalid_review_images');
    return { mime: image.mime, bytes, hash: await digest(bytes) };
  }));
}
async function normalize(input, { admin = false, existing = null } = {}) {
  object(input);
  const fallback = (key, column, def = '') => input[key] !== undefined ? input[key] : existing?.[column] ?? def;
  const name = text(fallback('name', 'name'), REVIEW_LIMITS.name, true);
  const comment = text(fallback('comment', 'comment'), REVIEW_LIMITS.comment, true, true);
  const rating = fallback('rating', 'rating', 0);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail('invalid_review_rating');
  const status = admin ? fallback('status', 'status', 'published') : 'published';
  const sourceType = admin ? fallback('sourceType', 'source_type', 'owner') : 'customer';
  if (!statuses.has(status) || !sources.has(sourceType)) fail();
  const sourceName = admin ? text(fallback('sourceName', 'source_name'), 100) : '';
  const url = admin ? sourceUrl(fallback('sourceUrl', 'source_url')) : '';
  const reviewedAt = admin ? date(fallback('reviewedAt', 'reviewed_at')) : '';
  const permission = admin && (input.permissionConfirmed === true || (input.permissionConfirmed === undefined && existing?.permission_confirmed === 1));
  if (admin && ['quoted', 'monitor'].includes(sourceType) && !permission) fail('review_permission_required');
  if (input.images !== undefined && input.newImages !== undefined) fail('invalid_review_images');
  const added = await images(input.images ?? input.newImages ?? []);
  return { name, rating, comment, status, sourceType, sourceName, sourceUrl: url, reviewedAt,
    permissionConfirmed: permission ? 1 : 0, images: added };
}
const fingerprint = data => digest(JSON.stringify({ ...data, images: data.images.map(image => ({ mime: image.mime, hash: image.hash })) }));
function pageNumber(value) {
  if (value == null || value === '') return 1;
  if (!/^[1-9]\d{0,4}$/.test(String(value)) || Number(value) > 10000) fail('invalid_review_page');
  return Number(value);
}
function version(input, row) {
  if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1)) fail();
  if (input.version !== undefined && input.version !== row.version) fail('review_changed', 409);
}

// Separate from inventory: review traffic and moderation never modify an order.
// Cloudflare sql.exec binds BLOBs as ArrayBuffer (SqlStorageValue), never a base64 string.
export class ReviewsStore {
  constructor(storage, clock = () => Math.floor(Date.now() / 1000)) {
    this.storage = storage; this.sql = storage.sql; this.clock = clock;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','published','hidden')),
      source_type TEXT NOT NULL, source_name TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT NOT NULL DEFAULT '', permission_confirmed INTEGER NOT NULL DEFAULT 0,
      admin_posted INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS reviews_status_created ON reviews(status,created_at DESC);
      CREATE TABLE IF NOT EXISTS review_images (
        id TEXT PRIMARY KEY, review_id TEXT NOT NULL, position INTEGER NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS review_images_review ON review_images(review_id,position);
      CREATE TABLE IF NOT EXISTS review_votes (
        review_id TEXT NOT NULL, visitor_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(review_id,visitor_id));
      CREATE TABLE IF NOT EXISTS review_operations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, review_id TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_submitters (visitor_id TEXT PRIMARY KEY, last_submit INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);`);
  }
  raw(id) { return this.sql.exec('SELECT * FROM reviews WHERE id=?', id).toArray()[0]; }
  creationResult(id, duplicate) {
    const row = this.raw(id);
    return { id, status: row?.status === 'published' ? 'published' : row?.status === 'pending' ? 'pending' : 'received', duplicate };
  }
  item(row, { admin = false, visitorId = '' } = {}) {
    if (!row) fail('review_not_found', 404);
    const imageRows = this.sql.exec('SELECT id FROM review_images WHERE review_id=? ORDER BY position,id', row.id).toArray();
    const result = { id: row.id, name: row.name, rating: row.rating, comment: row.comment,
      images: imageRows.map(image => ({ id: image.id, url: `${admin ? '/admin/api' : ''}/review-images/${row.id}/${image.id}` })),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), sourceType: row.source_type,
      sourceName: row.source_name, sourceUrl: row.source_url, reviewedAt: row.reviewed_at,
      adminPosted: row.admin_posted === 1,
      helpfulCount: this.sql.exec('SELECT COUNT(*) AS n FROM review_votes WHERE review_id=?', row.id).one().n,
      helpfulVoted: !!visitorId && !!this.sql.exec('SELECT 1 FROM review_votes WHERE review_id=? AND visitor_id=?', row.id, visitorId).toArray().length };
    if (admin) Object.assign(result, { status: row.status, version: row.version,
      permissionConfirmed: row.permission_confirmed === 1, createdBy: row.created_by });
    return result;
  }
  summary() {
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0, total = 0;
    for (const row of this.sql.exec("SELECT rating,COUNT(*) AS n FROM reviews WHERE status='published' GROUP BY rating").toArray()) {
      distribution[row.rating] = row.n; count += row.n; total += row.rating * row.n;
    }
    return { count, average: count ? Math.round(total / count * 100) / 100 : 0, distribution };
  }
  async list({ admin = false, status = 'pending', sort = 'helpful', page = 1, visitorId = '' } = {}) {
    page = pageNumber(page);
    if (visitorId) visitorId = await digest(uuid(visitorId));
    if (!['helpful', 'newest'].includes(sort)) fail('invalid_review_sort');
    if (admin && status !== 'all' && !statuses.has(status)) fail('invalid_review_status');
    const pageSize = admin ? REVIEW_LIMITS.adminPageSize : REVIEW_LIMITS.publicPageSize;
    const where = admin && status === 'all' ? '' : 'WHERE r.status=?';
    const params = where ? [admin ? status : 'published'] : [];
    const order = sort === 'helpful' && !admin ? 'helpful_count DESC,r.created_at DESC,r.id DESC' : 'r.created_at DESC,r.id DESC';
    const rows = this.sql.exec(`SELECT r.*,(SELECT COUNT(*) FROM review_votes v WHERE v.review_id=r.id) AS helpful_count
      FROM reviews r ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, pageSize + 1, (page - 1) * pageSize).toArray();
    const result = { items: rows.slice(0, pageSize).map(row => this.item(row, { admin, visitorId })),
      summary: this.summary(), page, hasMore: rows.length > pageSize };
    if (admin) {
      result.counts = { pending: 0, published: 0, hidden: 0, all: 0 };
      for (const row of this.sql.exec('SELECT status,COUNT(*) AS n FROM reviews GROUP BY status').toArray()) {
        result.counts[row.status] = row.n; result.counts.all += row.n;
      }
    }
    return result;
  }
  priorOperation(id, kind, reviewId, hash) {
    if (!id) return false;
    const row = this.sql.exec('SELECT * FROM review_operations WHERE id=?', id).toArray()[0];
    if (!row) return false;
    if (row.kind !== kind || row.review_id !== reviewId || row.hash !== hash) fail('request_conflict', 409);
    return true;
  }
  rememberOperation(id, kind, reviewId, hash, now) {
    if (id) this.sql.exec('INSERT INTO review_operations(id,kind,review_id,hash,created_at) VALUES(?,?,?,?,?)', id, kind, reviewId, hash, now);
  }
  limit(bucket, maximum, period, now) {
    const row = this.sql.exec('SELECT count,reset_at FROM review_rate_limits WHERE bucket=?', bucket).toArray()[0];
    if (row && row.reset_at > now && row.count >= maximum) fail('review_rate_limited', 429);
    this.sql.exec(`INSERT INTO review_rate_limits(bucket,count,reset_at) VALUES(?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
      reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END`, bucket, now + period, now, now);
  }
  rateKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) fail('reviews_not_ready', 503);
    return value;
  }
  saveImages(id, added, start = 0) {
    for (let i = 0; i < added.length; i++) this.sql.exec(
      'INSERT INTO review_images(id,review_id,position,mime,data) VALUES(?,?,?,?,?)',
      crypto.randomUUID(), id, start + i, added[i].mime, added[i].bytes);
  }
  async create(input, { admin = false, actor = '', rateKey = '' } = {}) {
    object(input);
    const id = uuid(input.submissionId), visitorId = admin ? '' : await digest(uuid(input.visitorId));
    if (!admin && (input.consent !== true || (input.website !== undefined && input.website !== ''))) fail('review_consent_required');
    const data = await normalize(input, { admin });
    // Keep the original public request fingerprint stable across the publication-policy change.
    // A retry of an older pending submission must return that row without approving or duplicating it.
    const hash = await fingerprint({ ...data, status: admin ? data.status : 'pending', visitorId, admin });
    const now = this.clock();
    return this.storage.transactionSync(() => {
      if (this.priorOperation(id, 'create', id, hash)) {
        if (admin) return { item: this.item(this.raw(id), { admin: true }), duplicate: true };
        return this.creationResult(id, true);
      }
      if (this.raw(id)) fail('request_conflict', 409);
      if (!admin) {
        this.rateKey(rateKey);
        const previous = this.sql.exec('SELECT last_submit FROM review_submitters WHERE visitor_id=?', visitorId).toArray()[0];
        if (previous && previous.last_submit > now - 86400) fail('review_rate_limited', 429);
        this.limit(`submit:${rateKey}`, 10, 86400, now);
        this.sql.exec('INSERT INTO review_submitters(visitor_id,last_submit) VALUES(?,?) ON CONFLICT(visitor_id) DO UPDATE SET last_submit=excluded.last_submit', visitorId, now);
      }
      this.sql.exec(`INSERT INTO reviews(id,name,rating,comment,status,source_type,source_name,source_url,reviewed_at,
        permission_confirmed,admin_posted,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, data.name, data.rating, data.comment, data.status, data.sourceType, data.sourceName, data.sourceUrl,
        data.reviewedAt, data.permissionConfirmed, admin ? 1 : 0, admin ? text(actor, 100) : '', now, now);
      this.saveImages(id, data.images);
      this.rememberOperation(id, 'create', id, hash, now);
      this.sql.exec('DELETE FROM review_rate_limits WHERE reset_at<=?', now);
      // Keep the daily limit even after moderation/deletion, without retaining names or IP addresses.
      this.sql.exec('DELETE FROM review_submitters WHERE last_submit<?', now - 2 * 86400);
      return admin ? { item: this.item(this.raw(id), { admin: true }) } : this.creationResult(id, false);
    });
  }
  async update(id, input, { actor = '' } = {}) {
    id = uuid(id); object(input);
    const operationId = input.operationId === undefined ? '' : uuid(input.operationId);
    // Hash the submitted operation before filling omitted fields from mutable current state.
    const requestHash = await digest(JSON.stringify(input));
    if (this.priorOperation(operationId, 'update', id, requestHash)) return { item: this.item(this.raw(id), { admin: true }), duplicate: true };
    const before = this.raw(id); if (!before) fail('review_not_found', 404);
    const data = await normalize(input, { admin: true, existing: before });
    const existingImages = this.sql.exec('SELECT id FROM review_images WHERE review_id=? ORDER BY position,id', id).toArray().map(row => row.id);
    const keep = input.keepImageIds === undefined ? existingImages : input.keepImageIds;
    if (!Array.isArray(keep) || keep.length > 3 || new Set(keep).size !== keep.length || keep.some(imageId => !existingImages.includes(imageId)) || keep.length + data.images.length > 3) fail('invalid_review_images');
    const now = this.clock();
    return this.storage.transactionSync(() => {
      if (this.priorOperation(operationId, 'update', id, requestHash)) return { item: this.item(this.raw(id), { admin: true }), duplicate: true };
      const row = this.raw(id); if (!row) fail('review_not_found', 404);
      version(input, row);
      if (row.version !== before.version) fail('review_changed', 409);
      this.sql.exec(`UPDATE reviews SET name=?,rating=?,comment=?,status=?,source_type=?,source_name=?,source_url=?,
        reviewed_at=?,permission_confirmed=?,updated_at=?,version=version+1 WHERE id=?`,
        data.name, data.rating, data.comment, data.status, data.sourceType, data.sourceName, data.sourceUrl,
        data.reviewedAt, data.permissionConfirmed, now, id);
      for (const imageId of existingImages) if (!keep.includes(imageId)) this.sql.exec('DELETE FROM review_images WHERE review_id=? AND id=?', id, imageId);
      keep.forEach((imageId, position) => this.sql.exec('UPDATE review_images SET position=? WHERE review_id=? AND id=?', position, id, imageId));
      this.saveImages(id, data.images, keep.length);
      this.rememberOperation(operationId, 'update', id, requestHash, now);
      return { item: this.item(this.raw(id), { admin: true }) };
    });
  }
  async delete(id, input = {}) {
    id = uuid(id); object(input);
    const operationId = input.operationId === undefined ? '' : uuid(input.operationId);
    const hash = await digest(JSON.stringify(input));
    return this.storage.transactionSync(() => {
      if (this.priorOperation(operationId, 'delete', id, hash)) return { id, deleted: true, duplicate: true };
      const row = this.raw(id);
      if (row) version(input, row);
      this.sql.exec('DELETE FROM review_images WHERE review_id=?', id);
      this.sql.exec('DELETE FROM review_votes WHERE review_id=?', id);
      this.sql.exec('DELETE FROM reviews WHERE id=?', id);
      this.rememberOperation(operationId, 'delete', id, hash, this.clock());
      return { id, deleted: true };
    });
  }
  async vote(id, input, { rateKey = '' } = {}) {
    id = uuid(id); object(input); const visitorId = await digest(uuid(input.visitorId));
    if (typeof input.helpful !== 'boolean') fail('invalid_review_vote');
    return this.storage.transactionSync(() => {
      const row = this.raw(id); if (!row || row.status !== 'published') fail('review_not_found', 404);
      const exists = !!this.sql.exec('SELECT 1 FROM review_votes WHERE review_id=? AND visitor_id=?', id, visitorId).toArray().length;
      if (exists !== input.helpful) {
        this.rateKey(rateKey); const now = this.clock();
        this.limit(`vote:visitor:${visitorId}`, 60, 3600, now);
        this.limit(`vote:ip:${rateKey}`, 180, 3600, now);
        if (input.helpful) this.sql.exec('INSERT INTO review_votes(review_id,visitor_id,created_at) VALUES(?,?,?)', id, visitorId, now);
        else this.sql.exec('DELETE FROM review_votes WHERE review_id=? AND visitor_id=?', id, visitorId);
        this.sql.exec('DELETE FROM review_rate_limits WHERE reset_at<=?', now);
      }
      return { helpfulCount: this.sql.exec('SELECT COUNT(*) AS n FROM review_votes WHERE review_id=?', id).one().n, helpfulVoted: input.helpful };
    });
  }
  image(reviewId, imageId, { admin = false } = {}) {
    reviewId = uuid(reviewId); imageId = uuid(imageId);
    const row = this.sql.exec(`SELECT i.mime,i.data FROM review_images i JOIN reviews r ON r.id=i.review_id
      WHERE i.review_id=? AND i.id=? ${admin ? '' : "AND r.status='published'"}`, reviewId, imageId).toArray()[0];
    if (!row) fail('review_not_found', 404);
    return new Response(row.data, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': admin ? 'same-origin' : 'cross-origin' } });
  }
}
export { ReviewsStore as ReviewStore };

async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('invalid_content_type', 415);
  if (Number(request.headers.get('content-length')) > REVIEW_LIMITS.bodyBytes) fail('request_too_large', 413);
  const reader = request.body?.getReader(); if (!reader) fail('invalid_json');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > REVIEW_LIMITS.bodyBytes) { await reader.cancel(); fail('request_too_large', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch (error) { if (error instanceof CheckoutError) throw error; fail('invalid_json'); }
}
const json = (data, status = 200) => Response.json(data, { status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// Authentication, public Origin checks, trusted rateKey derivation and Turnstile run in the Worker.
// Never derive admin authority or the rate key from JSON or public request headers here.
export async function reviewApi(request, store, options = {}) {
  try {
    const { admin = false } = options, url = new URL(request.url), path = url.pathname;
    const publicImage = path.match(/^\/review-images\/([^/]+)\/([^/]+)$/);
    const adminImage = path.match(/^\/admin\/api\/review-images\/([^/]+)\/([^/]+)$/);
    if ((publicImage || (admin && adminImage)) && request.method === 'GET') {
      const match = publicImage || adminImage;
      return store.image(match[1], match[2], { admin: !!adminImage && admin });
    }
    if (path === (admin ? '/admin/api/reviews' : '/reviews')) {
      if (request.method === 'GET') return json(await store.list({ admin,
        status: url.searchParams.get('status') || 'pending', sort: url.searchParams.get('sort') || (admin ? 'newest' : 'helpful'),
        page: url.searchParams.get('page') || 1, visitorId: url.searchParams.get('visitorId') || '' }));
      if (request.method === 'POST') return json(await store.create(await readJson(request), options), 201);
      fail('method_not_allowed', 405);
    }
    const helpful = path.match(/^\/reviews\/([^/]+)\/helpful$/);
    if (!admin && helpful && request.method === 'POST') return json(await store.vote(helpful[1], await readJson(request), options));
    const edit = path.match(/^\/admin\/api\/reviews\/([^/]+)(\/delete)?$/);
    if (admin && edit && request.method === 'POST') {
      const input = await readJson(request);
      return json(edit[2] ? await store.delete(edit[1], input) : await store.update(edit[1], input, options));
    }
    fail('not_found', 404);
  } catch (error) {
    if (error instanceof CheckoutError) return json({ error: error.code }, error.status);
    throw error;
  }
}
