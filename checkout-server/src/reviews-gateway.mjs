import { CheckoutError } from './catalog.mjs';
import { digest } from './admin-auth.mjs';

export const REVIEW_BODY_LIMIT = 1536 * 1024;
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const votePath = new RegExp(`^/reviews/${uuid}/helpful$`);
const imagePath = new RegExp(`^/review-images/${uuid}/${uuid}$`);
export const isAdminReviewPath = path => path === '/admin/api/reviews' ||
  new RegExp(`^/admin/api/reviews/${uuid}(?:/delete)?$`).test(path) ||
  new RegExp(`^/admin/api/review-images/${uuid}/${uuid}$`).test(path);

export async function readReviewJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new CheckoutError('invalid_content_type', 415);
  if (Number(request.headers.get('content-length')) > REVIEW_BODY_LIMIT) throw new CheckoutError('request_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new CheckoutError('invalid_json');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > REVIEW_BODY_LIMIT) { await reader.cancel(); throw new CheckoutError('request_too_large', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let input;
  try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new CheckoutError('invalid_json'); }
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new CheckoutError('invalid_json');
  return input;
}

function reviewCors(response, origin, allowed) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (allowed) { headers.set('Access-Control-Allow-Origin', origin); headers.append('Vary', 'Origin'); }
  return new Response(response.body, { status: response.status, headers });
}
function reviewError(error) {
  return Response.json({ error: error instanceof CheckoutError ? error.code : 'reviews_unavailable' }, {
    status: error instanceof CheckoutError ? error.status : 503,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function verifyReviewTurnstile(request, input, env, action, fetcher = fetch) {
  if (!env.TURNSTILE_SECRET_KEY) throw new CheckoutError('reviews_unavailable', 503);
  if (typeof input.turnstileToken !== 'string' || !input.turnstileToken || input.turnstileToken.length > 2048) throw new CheckoutError('verification_failed', 403);
  let verification;
  try {
    verification = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: input.turnstileToken,
        remoteip: request.headers.get('CF-Connecting-IP') || '' }),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new CheckoutError('verification_unavailable', 503); }
  if (!verification.ok) throw new CheckoutError('verification_unavailable', 503);
  let check;
  try { check = await verification.json(); } catch { throw new CheckoutError('verification_unavailable', 503); }
  if (!check.success || check.hostname !== new URL(env.SITE_ORIGIN).hostname || check.action !== action) throw new CheckoutError('verification_failed', 403);
}

// This gateway runs before the sales switch. Reading and writing reviews never
// creates a Stripe session or touches the inventory Durable Object.
export async function publicReviewResponse(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const isList = url.pathname === '/reviews', isVote = votePath.test(url.pathname), isImage = imagePath.test(url.pathname);
  if (!isList && !isVote && !isImage) return null;
  const origin = request.headers.get('origin'), allowed = origin === env.SITE_ORIGIN;
  try {
    if (!isImage && !allowed) throw new CheckoutError('origin_not_allowed', 403);
    if (request.method === 'OPTIONS' && allowed) return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', 'Vary': 'Origin',
    } });
    if (!env.REVIEWS) throw new CheckoutError('reviews_unavailable', 503);
    const readable = request.method === 'GET' && (isList || isImage);
    const writable = request.method === 'POST' && (isList || isVote);
    if (!readable && !writable) throw new CheckoutError('method_not_allowed', 405);
    const headers = new Headers(); let body;
    if (writable) {
      const input = await readReviewJson(request);
      if (input.website) throw new CheckoutError('invalid_review');
      await verifyReviewTurnstile(request, input, env, isVote ? 'review_helpful' : 'review_submit', fetcher);
      const day = new Date().toISOString().slice(0, 10);
      headers.set('x-review-rate-key', await digest(`${env.TURNSTILE_SECRET_KEY}|${day}|${request.headers.get('CF-Connecting-IP') || 'unknown'}`));
      headers.set('Content-Type', 'application/json');
      // Never relay public caller-supplied status, source, admin or internal headers.
      const clean = isVote ? { visitorId: input.visitorId, helpful: input.helpful } : {
        submissionId: input.submissionId, visitorId: input.visitorId, name: input.name,
        rating: input.rating, comment: input.comment, images: input.images, consent: input.consent, website: '',
      };
      body = JSON.stringify(clean);
    }
    const response = await env.REVIEWS.getByName('body-make-chips-reviews').fetch(
      new Request(`https://reviews.internal${url.pathname}${url.search}`, { method: request.method, headers, ...(body === undefined ? {} : { body }) }));
    return reviewCors(response, origin, allowed);
  } catch (error) { return reviewCors(reviewError(error), origin, allowed); }
}

// Called only after the existing admin session and CSRF checks have succeeded.
export async function relayAdminReview(request, env, actor) {
  if (!env.REVIEWS) throw new CheckoutError('reviews_unavailable', 503);
  const url = new URL(request.url);
  if (!isAdminReviewPath(url.pathname)) throw new CheckoutError('not_found', 404);
  const headers = new Headers({ 'x-review-actor': encodeURIComponent(actor) });
  let body;
  if (request.method === 'POST') { body = JSON.stringify(await readReviewJson(request)); headers.set('Content-Type', 'application/json'); }
  return env.REVIEWS.getByName('body-make-chips-reviews').fetch(new Request(
    `https://reviews.internal${url.pathname}${url.search}`, { method: request.method, headers, ...(body === undefined ? {} : { body }) }));
}
