import Stripe from 'stripe';
import { DurableObject } from 'cloudflare:workers';
import { InventoryStore } from './inventory.mjs';
import { CheckoutService } from './checkout.mjs';
import { CheckoutError } from './catalog.mjs';
import { AdminAuthStore } from './admin-auth.mjs';
import { adminAsset, adminApi, adminJson, validateAdminRequest } from './admin.mjs';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const configFor = env => ({
  siteOrigin: env.SITE_ORIGIN,
  livemode: env.STRIPE_MODE === 'live',
  prices: { trial: env.PRICE_TRIAL, desk: env.PRICE_DESK, stock: env.PRICE_STOCK },
});
function validSiteOrigin(env) {
  try {
    const origin = new URL(env.SITE_ORIGIN);
    return origin.origin === env.SITE_ORIGIN && (origin.protocol === 'https:' ||
      (env.STRIPE_MODE === 'test' && origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)));
  } catch { return false; }
}
function stripeClient(env) {
  if (!['test', 'live'].includes(env.STRIPE_MODE) ||
      !new RegExp(`^rk_${env.STRIPE_MODE}_`).test(env.STRIPE_RESTRICTED_KEY || '')) throw new Error('Restricted Stripe key not configured for this environment');
  return new Stripe(env.STRIPE_RESTRICTED_KEY, {
    httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2, timeout: 15000,
  });
}
function cors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}
async function readText(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) throw new CheckoutError('invalid_request');
  let size = 0, chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new CheckoutError('request_too_large', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function readJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new CheckoutError('invalid_content_type', 415);
  try { return JSON.parse(await readText(request, 4096)); } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError('invalid_json');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const allowed = origin === env.SITE_ORIGIN;
    try {
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        validateAdminRequest(request, env.STRIPE_MODE);
        const asset = request.method === 'GET' && adminAsset(url.pathname, env.STRIPE_MODE);
        if (asset) return asset;
        if (!url.pathname.startsWith('/admin/api/')) return adminJson({ error: 'not_found' }, 404);
        const stub = env.INVENTORY.getByName('body-make-chips-first-batch');
        return stub.fetch(request);
      }
      if (url.pathname === '/webhook' && request.method === 'POST') {
        if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'not_ready' }, 503);
        if (Number(request.headers.get('content-length')) > 1048576) return json({ error: 'too_large' }, 413);
        const payload = await readText(request, 1048576);
        let event;
        try {
          event = await stripeClient(env).webhooks.constructEventAsync(
            payload, request.headers.get('stripe-signature') || '', env.STRIPE_WEBHOOK_SECRET,
            undefined, Stripe.createSubtleCryptoProvider());
        } catch { return json({ error: 'invalid_signature' }, 400); }
        const stub = env.INVENTORY.getByName('body-make-chips-first-batch');
        return stub.fetch('https://inventory.internal/webhook', { method: 'POST', body: JSON.stringify(event) });
      }
      if (!allowed) return json({ error: 'origin_not_allowed' }, 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', 'Vary': 'Origin',
      } });
      // Existing customers must still be able to check a payment when new sales are paused.
      if (url.pathname !== '/order-status' && env.SALE_ENABLED !== 'true') return cors(json({ error: 'sales_closed' }, 503), origin);
      if (!validSiteOrigin(env) || !env.TURNSTILE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
        return cors(json({ error: 'not_ready' }, 503), origin);
      }
      const stub = env.INVENTORY.getByName('body-make-chips-first-batch');
      if (url.pathname === '/availability' && request.method === 'GET') {
        return cors(await stub.fetch('https://inventory.internal/availability'), origin);
      }
      if (url.pathname === '/order-status' && request.method === 'GET') {
        const session = url.searchParams.get('session_id') || '';
        if (!/^cs_(test_|live_)?[A-Za-z0-9]{12,240}$/.test(session)) throw new CheckoutError('invalid_session');
        return cors(await stub.fetch(`https://inventory.internal/order-status?session_id=${encodeURIComponent(session)}`), origin);
      }
      if (url.pathname === '/checkout' && request.method === 'POST') {
        const input = await readJson(request);
        const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: String(input.turnstileToken || ''), remoteip: request.headers.get('CF-Connecting-IP') || '' }),
        });
        if (!verification.ok) throw new CheckoutError('verification_unavailable', 503);
        const check = await verification.json();
        if (!check.success || check.hostname !== new URL(env.SITE_ORIGIN).hostname || check.action !== 'checkout') throw new CheckoutError('verification_failed', 403);
        const response = await stub.fetch('https://inventory.internal/checkout', {
          method: 'POST', body: JSON.stringify({ setId: input.setId, requestId: input.requestId }),
        });
        return cors(response, origin);
      }
      return cors(json({ error: 'not_found' }, 404), origin);
    } catch (error) {
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        return adminJson({ error: error instanceof CheckoutError ? error.code : 'temporarily_unavailable' }, error instanceof CheckoutError ? error.status : 503);
      }
      const response = json({ error: error instanceof CheckoutError ? error.code : 'temporarily_unavailable' }, error instanceof CheckoutError ? error.status : 503);
      // Never log Stripe responses, API keys, request bodies, addresses or payment data.
      if (!(error instanceof CheckoutError)) console.error('checkout_request_failed');
      return allowed ? cors(response, origin) : response;
    }
  },
};

export class Inventory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.store = new InventoryStore(ctx.storage, env.STRIPE_MODE);
    this.adminAuth = new AdminAuthStore(ctx.storage);
    this.stripe = stripeClient(env);
    this.service = new CheckoutService(this.store, this.stripe, configFor(env));
  }
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/admin/api/')) {
        return await adminApi(request, this.store, this.adminAuth, this.env.INVENTORY_ADMIN_KEY_HASH, readJson);
      }
      if (url.pathname === '/availability') return json({ available: this.store.status(), remainingBags: Math.max(0, this.store.available()), livemode: this.env.STRIPE_MODE === 'live' });
      if (url.pathname === '/order-status') {
        const session = await this.stripe.checkout.sessions.retrieve(url.searchParams.get('session_id'));
        this.service.validateMode(session);
        const row = this.store.get(session.client_reference_id);
        if (!row || (row.session_id && row.session_id !== session.id)) return json({ error: 'not_found' }, 404);
        if (session.amount_total !== row.amount || session.currency !== 'jpy' || session.mode !== 'payment' ||
            session.metadata?.set_id !== row.set_id || session.metadata?.bags !== String(row.bags) || row.state === 'review') {
          return json({ error: 'order_needs_review' }, 409);
        }
        return json({ paid: session.payment_status === 'paid', recorded: row.state === 'paid', state: row.state,
          status: session.status, bags: row.bags, amount: row.amount, setId: row.set_id, requestId: row.request_id });
      }
      if (url.pathname === '/checkout') {
        // Schedule before the API call so a lost response still gets reconciled.
        await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
        return json(await this.service.create(await request.json()));
      }
      if (url.pathname === '/webhook') {
        await this.service.webhook(await request.json());
        return json({ received: true });
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (url.pathname.startsWith('/admin/api/')) {
        return adminJson({ error: error instanceof CheckoutError ? error.code : 'temporarily_unavailable' }, error instanceof CheckoutError ? error.status : 503);
      }
      if (!(error instanceof CheckoutError)) console.error('inventory_operation_failed');
      return json({ error: error instanceof CheckoutError ? error.code : 'temporarily_unavailable' }, error instanceof CheckoutError ? error.status : 503);
    }
  }
  async alarm() {
    // Always reschedule first, including persistent upstream failures.
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    await this.service.reconcile();
    if (!this.store.pending().length) await this.ctx.storage.deleteAlarm();
  }
}
