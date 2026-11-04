import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { classifyCheckoutError, diagnosticEvent } from '../../tracking/checkout-diagnostics.mjs';

const clientSource = (await readFile(new URL('../../checkout-client.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?$/gm, '');
const analyticsSource = await readFile(new URL('../../analytics.js', import.meta.url), 'utf8');
const diagnosticSource = analyticsSource.slice(analyticsSource.indexOf('export function trackCheckoutDiagnostic'),
  analyticsSource.indexOf('export async function getAnalyticsContext')).replace(/^export /, '');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

class Element {
  listeners = new Map();
  disabled = false;
  textContent = '';
  dataset = {};
  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || [];
    callbacks.push(callback); this.listeners.set(name, callbacks);
  }
  fire(name, event = {}) { return Promise.all((this.listeners.get(name) || []).map(callback => callback(event))); }
  remove() { this.removed = true; }
}

// Run the real browser controller with a small DOM and deterministic clocks.
// Fetch and Turnstile are boundary doubles; no Stripe sessions or network calls occur.
async function setup({ checkout, turnstileLoaded = true, measurementFails = false } = {}) {
  let now = 0, nextTimer = 0, nextRequest = 0;
  const timers = new Map(), storage = new Map();
  const events = [], requests = [], redirects = [], scripts = [], widgets = [], resets = [];
  const window = new Element(), document = new Element(), dialog = new Element();
  const controls = new Map(['submit', 'message', 'verification', 'close', 'name', 'quantity', 'total']
    .map(name => [`[data-checkout-${name}]`, new Element()]));
  dialog.open = false;
  dialog.querySelector = selector => controls.get(selector);
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; return dialog.fire('close'); };
  const buy = new Element(); buy.dataset.buySet = 'trial';
  const config = { enabled: true, livemode: false, apiOrigin: 'https://checkout.example.test', turnstileSiteKey: 'test-only',
    sets: [{ id: 'trial', name: 'お試し3袋', quantity: 3, price: 1280 }] };
  document.querySelector = selector => selector === '#sale-config' ? { textContent: JSON.stringify({ checkout: config }) } :
    selector === '#checkout-dialog' ? dialog : null;
  document.querySelectorAll = () => [buy];
  document.createElement = () => new Element();
  document.head = { append(script) { scripts.push(script); } };
  const turnstile = {
    render(node, options) { widgets.push(options); return widgets.length - 1; },
    remove() {}, reset(id) { resets.push(id); },
  };
  if (turnstileLoaded) window.turnstile = turnstile;
  const context = {
    window, document, URL, AbortController, innerWidth: 390, performance: { now: () => now },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextRequest).padStart(12, '0')}` },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    location: { assign: url => redirects.push(url) },
    classifyCheckoutError,
    trackSetSelection: async () => { if (measurementFails) throw new Error('measurement unavailable'); },
    getAnalyticsContext: async () => { if (measurementFails) throw new Error('measurement unavailable'); return null; },
    trackCheckoutStart: async () => { if (measurementFails) throw new Error('measurement unavailable'); },
    trackCheckoutDiagnostic: vm.runInNewContext(`${diagnosticSource}; trackCheckoutDiagnostic`, {
      diagnosticEvent, active: true, analyticsReady: Promise.resolve(true),
      emit(name, params) { if (measurementFails) throw new Error('tag unavailable'); events.push({ name, ...params }); },
    }),
    fetch: async (url, options) => {
      if (url.endsWith('/availability')) return response({ livemode: false, available: { trial: true } });
      requests.push(JSON.parse(options.body));
      return checkout ? checkout(options, requests.length) : response({ url: 'https://checkout.stripe.com/c/pay/test' });
    },
  };
  await vm.runInNewContext(`(async () => { ${clientSource}\n })()`, context);
  await flush();
  return {
    window, dialog, controls, widgets, scripts, requests, redirects, resets, events, turnstile,
    event: name => events.filter(event => event.name === name),
    open: () => buy.fire('click'), submit: () => controls.get('[data-checkout-submit]').fire('click'),
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback(); await flush();
      }
      now = until; await flush();
    },
  };
}

test('late verification callbacks cannot enable or report a newly reopened checkout', async () => {
  const h = await setup();
  await h.open(); const old = h.widgets[0];
  await h.dialog.close(); await h.open();
  old.callback('old-token'); old['error-callback']('110100'); old['before-interactive-callback']();
  assert.equal(h.controls.get('[data-checkout-submit]').disabled, true);
  assert.equal(h.event('checkout_verify_ready').length, 0);
  assert.equal(h.event('checkout_verify_error').length, 0);
  assert.equal(h.event('checkout_verify_challenge').length, 0);
  h.widgets[1].callback('fresh-token'); await h.submit();
  assert.equal(h.requests[0].turnstileToken, 'fresh-token');
  assert.equal(h.redirects.length, 1);
});

test('challenge display, verification wait, and ready-stage dismissal are distinct', async () => {
  const h = await setup(); await h.open();
  h.widgets[0]['before-interactive-callback']();
  await h.advance(14999); assert.equal(h.event('checkout_verify_slow').length, 0);
  await h.advance(1); assert.equal(h.event('checkout_verify_slow').length, 1);
  h.widgets[0].callback('token'); await h.dialog.close(); await h.advance(20000);
  assert.equal(h.event('checkout_verify_challenge').length, 1);
  assert.equal(h.event('checkout_verify_ready').length, 1);
  assert.equal(h.event('checkout_verify_slow').length, 1);
  assert.equal(h.event('checkout_dialog_close')[0].checkout_stage, 'ready');
});

test('a stalled verification script ends after 20 seconds and can be loaded again', async () => {
  const h = await setup({ turnstileLoaded: false });
  const pending = h.open(); await flush();
  await h.advance(15000);
  assert.equal(h.event('checkout_verify_slow').length, 1);
  await h.advance(5000); await pending;
  assert.equal(h.event('checkout_verify_error')[0].checkout_issue, 'script_timeout');
  assert.equal(h.scripts[0].removed, true);
  assert.equal(h.controls.get('[data-checkout-submit]').disabled, true);
  await h.dialog.close();
  const retry = h.open(); await flush();
  assert.equal(h.scripts.length, 2);
  h.window.turnstile = h.turnstile; h.scripts[1].onload(); await retry;
  h.widgets[0].callback('token'); await h.submit();
  assert.equal(h.redirects.length, 1);
});

for (const [label, failure, issue, status] of [
  ['network failure', () => { throw new TypeError('Failed to fetch'); }, 'network', undefined],
  ['HTTP error', () => response({ error: 'not_ready' }, 503), 'not_ready', 503],
  ['invalid success JSON', () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }), 'invalid_response', 200],
  ['non-JSON HTTP failure', () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError('HTML response'); } }), 'http_error', 502],
]) {
  test(`${label} is classified and retry retains the same order identity`, async () => {
    const h = await setup({ checkout: (options, attempt) => attempt === 1 ? failure(options) : response({ url: 'https://checkout.stripe.com/c/pay/retry' }) });
    await h.open(); h.widgets[0].callback('token-one'); await h.submit();
    const error = h.event('checkout_request_error')[0];
    assert.equal(error.checkout_issue, issue); assert.equal(error.http_status, status);
    assert.equal(h.redirects.length, 0); assert.equal(h.resets.length, 1);
    h.widgets[0].callback('token-two'); await h.submit();
    assert.equal(h.requests[0].requestId, h.requests[1].requestId);
    assert.equal(h.requests[1].turnstileToken, 'token-two');
    assert.equal(h.event('checkout_submit')[1].checkout_attempt, 2);
    assert.equal(h.redirects.length, 1);
  });
}

test('request slowdown and 45-second abort are tracked without abandoning the order ID', async () => {
  const h = await setup({ checkout: (options, attempt) => attempt > 1 ? response({ url: 'https://checkout.stripe.com/c/pay/recovered' }) :
    new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))) });
  await h.open(); h.widgets[0].callback('token-one'); const pending = h.submit(); await flush();
  await h.advance(10000); assert.equal(h.event('checkout_request_slow').length, 1);
  await h.advance(35000); await pending;
  assert.equal(h.event('checkout_request_error')[0].checkout_issue, 'timeout');
  assert.equal(h.controls.get('[data-checkout-close]').disabled, false);
  h.widgets[0].callback('token-two'); await h.submit();
  assert.equal(h.requests[0].requestId, h.requests[1].requestId);
});

test('a response whose body stalls is classified as a timeout after headers arrive', async () => {
  const h = await setup({ checkout: (options, attempt) => attempt > 1 ? response({ url: 'https://checkout.stripe.com/c/pay/recovered' }) : {
    status: 200, ok: true,
    json: () => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))),
  } });
  await h.open(); h.widgets[0].callback('token-one'); const pending = h.submit(); await flush();
  await h.advance(45000); await pending;
  const error = h.event('checkout_request_error')[0];
  assert.equal(error.checkout_issue, 'timeout');
  assert.equal(error.http_status, 200);
  assert.equal(h.redirects.length, 0);
  assert.equal(h.controls.get('[data-checkout-close]').disabled, false);
  h.widgets[0].callback('token-two'); await h.submit();
  assert.equal(h.requests[0].requestId, h.requests[1].requestId);
  assert.equal(h.redirects[0], 'https://checkout.stripe.com/c/pay/recovered');
});

test('a pending request completing after back-cache restoration cannot alter a new checkout', async () => {
  for (const failed of [false, true]) {
    let resolveOld, rejectOld;
    const h = await setup({ checkout: (options, attempt) => attempt === 1 ? new Promise((resolve, reject) => {
      resolveOld = resolve; rejectOld = reject;
    }) : response({ url: 'https://checkout.stripe.com/c/pay/current' }) });
    await h.open(); h.widgets[0].callback('old-token'); const pending = h.submit(); await flush();
    assert.equal(h.requests.length, 1);
    await h.window.fire('pagehide'); await h.window.fire('pageshow', { persisted: true }); await flush();
    await h.open();
    const message = h.controls.get('[data-checkout-message]').textContent;
    if (failed) rejectOld(new TypeError('late old request failed'));
    else resolveOld(response({ url: 'https://checkout.stripe.com/c/pay/old' }));
    await pending;
    assert.equal(h.redirects.length, 0);
    assert.equal(h.event('checkout_request_error').length, 0);
    assert.equal(h.event('checkout_redirect').length, 0);
    assert.equal(h.controls.get('[data-checkout-message]').textContent, message);
    assert.equal(h.controls.get('[data-checkout-submit]').disabled, true);
    assert.equal(h.resets.length, 0);
    await h.advance(15000);
    assert.equal(h.event('checkout_verify_slow').length, 1);
    h.widgets[1].callback('fresh-token'); await h.submit();
    assert.equal(h.requests[0].requestId, h.requests[1].requestId);
    assert.equal(h.requests[1].turnstileToken, 'fresh-token');
    assert.deepEqual(h.redirects, ['https://checkout.stripe.com/c/pay/current']);
  }
});

test('successful Stripe redirects do not count as checkout abandonment', async () => {
  const h = await setup(); await h.open(); h.widgets[0].callback('token'); await h.submit();
  await h.window.fire('pagehide'); await h.dialog.close(); await h.advance(60000);
  assert.equal(h.event('checkout_redirect').length, 1);
  assert.equal(h.event('checkout_page_exit').length, 0);
  assert.equal(h.event('checkout_dialog_close').length, 0);
  assert.equal(h.event('checkout_request_slow').length, 0);
});

test('leaving while waiting is counted once, including a browser back-cache restore', async () => {
  const h = await setup(); await h.open(); await h.window.fire('pagehide'); await h.window.fire('pagehide');
  assert.equal(h.event('checkout_page_exit').length, 1);
  assert.equal(h.event('checkout_page_exit')[0].checkout_stage, 'verification');
  await h.window.fire('pageshow', { persisted: true });
  assert.equal(h.event('checkout_dialog_close').length, 0);
  await h.advance(20000); assert.equal(h.event('checkout_verify_slow').length, 0);
});

test('an unsafe redirect is rejected and never recorded as a successful handoff', async () => {
  const h = await setup({ checkout: () => response({ url: 'https://checkout.stripe.com.attacker.test/pay' }) });
  await h.open(); h.widgets[0].callback('token'); await h.submit();
  assert.equal(h.redirects.length, 0); assert.equal(h.event('checkout_redirect').length, 0);
  assert.equal(h.event('checkout_request_error')[0].checkout_issue, 'invalid_destination');
});

test('broken analytics, including a throwing diagnostic tag, cannot block purchase', async () => {
  const h = await setup({ measurementFails: true });
  await h.open(); h.widgets[0].callback('token'); await h.submit();
  assert.equal(h.requests.length, 1);
  assert.equal(h.redirects[0], 'https://checkout.stripe.com/c/pay/test');
});
