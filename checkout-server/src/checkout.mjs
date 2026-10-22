import { CheckoutError, SHIPPING_START, validateRequest } from './catalog.mjs';

export function sessionParameters(row, config) {
  return {
    mode: 'payment',
    line_items: [{ price: row.price_id, quantity: 1 }],
    client_reference_id: row.request_id,
    metadata: { set_id: row.set_id, bags: String(row.bags), shipping_start: SHIPPING_START },
    payment_intent_data: { metadata: { set_id: row.set_id, bags: String(row.bags), shipping_start: SHIPPING_START } },
    shipping_address_collection: { allowed_countries: ['JP'] },
    phone_number_collection: { enabled: true },
    // Shipping already requires the recipient name; avoid asking for it twice.
    locale: 'ja',
    expires_at: row.expires,
    success_url: `${config.siteOrigin}/order-complete.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteOrigin}/#lineup`,
    // Omit payment_method_types; eligible methods are managed in the Stripe Dashboard.
    consent_collection: { terms_of_service: 'required' },
    adaptive_pricing: { enabled: false },
    custom_text: { submit: { message: '税込・送料込み。2026年11月5日から順次発送。以降の通常注文は入金確認後3営業日以内に発送。お客様都合の返品不可。不良品・誤配送は到着後7日以内にご連絡ください。' } },
    integration_identifier: 'body_make_chips_sopnqvte',
  };
}

export class CheckoutService {
  constructor(store, stripe, config, clock = () => Math.floor(Date.now() / 1000), analytics = null) {
    this.store = store; this.stripe = stripe; this.config = config; this.clock = clock; this.analytics = analytics;
  }
  async create(input) {
    const item = validateRequest(input);
    const priceId = this.config.prices[input.setId];
    if (!priceId) throw new CheckoutError('not_ready', 503);
    const existing = this.store.get(input.requestId);
    if (!existing) {
      const price = await this.stripe.prices.retrieve(priceId);
      if (!price.active || price.type !== 'one_time' || price.currency !== 'jpy' ||
          price.unit_amount !== item.amount || price.livemode !== this.config.livemode) throw new CheckoutError('not_ready', 503);
    }
    const row = this.store.reserve(input, priceId, this.clock());
    try { this.analytics?.remember(row, input.analytics, this.clock()); } catch { /* Analytics cannot prevent checkout. */ }
    if (['paid', 'pending'].includes(row.state)) return { status: 'complete', sessionId: row.session_id };
    if (['expired', 'failed', 'review'].includes(row.state)) throw new CheckoutError('checkout_unavailable', 409);
    if (row.session_id) {
      const session = await this.stripe.checkout.sessions.retrieve(row.session_id);
      this.validateMode(session);
      this.store.applySession(session, this.clock());
      if (session.status === 'complete') return { status: 'complete', sessionId: session.id };
      if (session.status !== 'open') throw new CheckoutError('checkout_unavailable', 409);
      return { url: session.url };
    }
    // The minimum expiry for a newly created session is 30 minutes. Late/uncertain
    // requests are reconciled from Stripe instead of creating another checkout.
    if (row.expires - this.clock() < 1850) throw new CheckoutError('checkout_pending_recovery', 503);
    const session = await this.stripe.checkout.sessions.create(sessionParameters(row, this.config), {
      idempotencyKey: `bmc-${row.request_id}`,
    });
    this.validateMode(session);
    this.store.attach(row.request_id, session, this.clock());
    return { url: session.url };
  }
  validateMode(session) {
    if (session.livemode !== this.config.livemode) throw new Error('Stripe mode mismatch');
  }
  async webhook(event) {
    if (!['checkout.session.completed','checkout.session.expired','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed'].includes(event.type)) return;
    if (event.livemode !== this.config.livemode) throw new Error('Webhook mode mismatch');
    // Fetch authoritative state so delayed/out-of-order events cannot release a paid order.
    const session = await this.stripe.checkout.sessions.retrieve(event.data.object.id);
    this.validateMode(session);
    if (event.type === 'checkout.session.async_payment_failed' && session.status === 'complete' && session.payment_status === 'unpaid') {
      this.store.failAsync(session, this.clock(), event.id);
    } else this.store.applySession(session, this.clock(), event.id);
  }
  async reconcile() {
    for (const row of this.store.pending()) {
      try {
        if (row.session_id) {
          const session = await this.stripe.checkout.sessions.retrieve(row.session_id);
          this.validateMode(session);
          this.store.applySession(session, this.clock());
        } else if (row.expires - this.clock() >= 1850) {
          // Repeat exactly the same create call to recover a lost response, then reconcile it.
          await this.create({ requestId: row.request_id, setId: row.set_id });
        } else {
          let found = false;
          // Exhaust the paginated list before declaring a create request absent. The
          // fixed expires_at cannot create a new session once it is in the past.
          for await (const session of this.stripe.checkout.sessions.list({ created: { gte: row.created - 60, lte: row.expires }, limit: 100 })) {
            if (session.client_reference_id !== row.request_id) continue;
            found = true;
            this.validateMode(session);
            this.store.attach(row.request_id, session, this.clock());
            this.store.applySession(session, this.clock());
            break;
          }
          if (!found && this.clock() > row.expires + 300) this.store.failCreation(row.request_id, this.clock());
        }
      } catch { /* Failed reads keep stock held; the alarm retries. */ }
      finally { this.store.touch(row.request_id, this.clock()); }
    }
  }
}
