import { getAnalyticsContext, trackSetSelection, trackCheckoutStart, trackCheckoutDiagnostic } from './analytics.js?v=20261105-auto';
import { classifyCheckoutError } from './tracking/checkout-diagnostics.mjs?v=20261105-auto';
const report = (...args) => { try { trackCheckoutDiagnostic(...args); } catch {} };
// Public configuration contains no Stripe credentials. Price and stock are enforced by the server.
const configNode = document.querySelector('#sale-config');
let config;
try { config = configNode ? JSON.parse(configNode.textContent).checkout : await fetch('./checkout-settings.json', { cache: 'no-store' }).then(r => r.json()); } catch {}

const keyFor = setId => `bmc-checkout-${setId}`;
const memory = new Map();
function requestIdFor(setId) {
  let id = memory.get(setId);
  try { id ||= sessionStorage.getItem(keyFor(setId)); } catch {}
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) id = crypto.randomUUID();
  memory.set(setId, id);
  try { sessionStorage.setItem(keyFor(setId), id); } catch {}
  return id;
}
function forget(setId, expected) {
  let current = memory.get(setId);
  try { current ||= sessionStorage.getItem(keyFor(setId)); } catch {}
  if (expected && current !== expected) return;
  memory.delete(setId);
  try { sessionStorage.removeItem(keyFor(setId)); } catch {}
}
async function api(path, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`${config.apiOrigin}${path}`, { ...options, credentials: 'omit', cache: 'no-store', signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch (error) {
      const code = controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout' :
        error.name === 'TypeError' ? 'network' : response.ok ? 'invalid_response' : 'http_error';
      throw Object.assign(new Error(code), { code, httpStatus: response.status });
    }
    if (!response.ok) throw Object.assign(new Error('checkout_api_error'), { code: data?.error || 'http_error', httpStatus: response.status });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('invalid_response'), { code: 'invalid_response', httpStatus: response.status });
    return data;
  } finally { clearTimeout(timeout); }
}
const messages = {
  out_of_stock: 'このセットは現在ご用意できません。ほかのセットをご確認ください。',
  checkout_unavailable: '前の購入手続きは終了しました。もう一度お試しください。',
  checkout_pending_recovery: '購入手続きの状況を確認しています。少し時間をおいて、もう一度お試しください。',
  verification_failed: '確認の有効期限が切れました。もう一度お試しください。',
  verification_unavailable: '接続を確認できませんでした。時間をおいてお試しください。',
  sales_closed: 'ただいま販売を一時停止しています。',
  not_ready: 'ただいま購入手続きをご利用いただけません。',
};
let turnstileLoading;
function loadTurnstile() {
  if (window.turnstile?.render) return Promise.resolve();
  if (!turnstileLoading) turnstileLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (code) { script.remove(); turnstileLoading = null; reject(Object.assign(new Error(code), { code })); }
      else resolve();
    };
    const timeout = setTimeout(() => finish('script_timeout'), 20000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => finish(window.turnstile?.render ? null : 'script_load');
    script.onerror = () => finish('script_load');
    document.head.append(script);
  });
  return turnstileLoading;
}

const dialog = document.querySelector('#checkout-dialog');
if (dialog && config?.enabled) {
  const buyButtons = [...document.querySelectorAll('[data-buy-set]')];
  const submit = dialog.querySelector('[data-checkout-submit]');
  const message = dialog.querySelector('[data-checkout-message]');
  const verification = dialog.querySelector('[data-checkout-verification]');
  let selected, token, widget, busy = false, generation = 0, lastError = '';
  let journey, verifyTimer, requestTimer;
  const elapsed = start => Math.max(0, performance.now() - start);
  function diagnostic(name, details = {}, target = journey) {
    if (!target) return;
    report(name, target.set, { stage: target.stage, attempt: target.attempt || undefined,
      waitMs: elapsed(target.started), ...details });
  }
  function verifyWait(target) {
    clearTimeout(verifyTimer);
    target.stage = 'verification'; target.verifyStarted = performance.now();
    diagnostic('checkout_verify_start', { waitMs: 0 }, target);
    verifyTimer = setTimeout(() => {
      if (journey === target && dialog.open && target.stage === 'verification') {
        diagnostic('checkout_verify_slow', { waitMs: elapsed(target.verifyStarted) }, target);
      }
    }, 15000);
  }
  const availability = {};
  async function refresh() {
    try {
      const data = await api('/availability');
      if (data.livemode !== config.livemode) throw Object.assign(new Error('mode_mismatch'), { code: 'mode_mismatch' });
      if (!data.available || Array.isArray(data.available) || config.sets.some(set => typeof data.available[set.id] !== 'boolean')) {
        throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
      }
      for (const button of buyButtons) {
        const set = config.sets.find(set => set.id === button.dataset.buySet);
        availability[button.dataset.buySet] = data.available[button.dataset.buySet] === true;
        button.disabled = !availability[button.dataset.buySet];
        button.textContent = button.disabled ? 'ただいま在庫なし' : `${set.price.toLocaleString('ja-JP')}円で購入に進む`;
      }
    } catch (error) {
      report('checkout_availability_error', null, { stage: 'availability', issue: classifyCheckoutError(error), httpStatus: error.httpStatus });
      for (const button of buyButtons) { button.disabled = true; button.textContent = 'ただいま購入できません'; }
    }
  }
  function cleanup() {
    if (journey && !journey.redirected) diagnostic('checkout_dialog_close');
    generation++;
    clearTimeout(verifyTimer); clearTimeout(requestTimer);
    journey = undefined;
    if (widget !== undefined) window.turnstile?.remove(widget);
    widget = undefined; token = ''; selected = undefined;
  }
  dialog.addEventListener('close', cleanup);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.querySelector('[data-checkout-close]').addEventListener('click', () => { if (!busy) dialog.close(); });
  for (const button of buyButtons) button.addEventListener('click', async () => {
    if (dialog.open || busy) return;
    selected = config.sets.find(set => set.id === button.dataset.buySet);
    if (!selected || !availability[selected.id]) return;
    trackSetSelection(selected).catch(() => {});
    const thisGeneration = ++generation;
    const target = journey = { set: selected, started: performance.now(), stage: 'verification', attempt: 0, autoAdvance: true, usedTokens: new Set(), redirected: false, exited: false };
    const current = () => dialog.open && thisGeneration === generation && journey === target && !target.exited;
    dialog.querySelector('[data-checkout-name]').textContent = selected.name;
    dialog.querySelector('[data-checkout-quantity]').textContent = `15g × ${selected.quantity}袋`;
    dialog.querySelector('[data-checkout-total]').textContent = `${selected.price.toLocaleString('ja-JP')}円`;
    message.textContent = '接続を確認しています。認証が終わると、お支払い画面へ自動で進みます。';
    submit.disabled = true; submit.hidden = true; token = ''; lastError = '';
    dialog.showModal();
    diagnostic('checkout_dialog_open');
    verifyWait(target);
    try {
      await loadTurnstile();
      if (!current()) return;
      widget = window.turnstile.render(verification, {
        sitekey: config.turnstileSiteKey, action: 'checkout', theme: 'light', size: innerWidth < 380 ? 'compact' : 'normal',
        callback(value) {
          if (!current() || busy || typeof value !== 'string' || !value || target.usedTokens.has(value)) return;
          clearTimeout(verifyTimer); target.stage = 'ready';
          diagnostic('checkout_verify_ready', { waitMs: elapsed(target.verifyStarted) }, target);
          token = value;
          if (target.autoAdvance) void openCheckout();
          else {
            submit.disabled = false; submit.hidden = false;
            message.textContent = lastError || '接続を確認できました。「もう一度試す」を押してください。';
          }
        },
        'before-interactive-callback'() {
          if (current() && !busy) diagnostic('checkout_verify_challenge', { waitMs: elapsed(target.verifyStarted) }, target);
        },
        'expired-callback'() {
          if (!current() || busy) return;
          diagnostic('checkout_verify_expired', {}, target);
          token = ''; submit.disabled = true; message.textContent = '確認の有効期限が切れました。再確認しています…';
          verifyWait(target);
        },
        'timeout-callback'() {
          if (!current() || busy) return;
          diagnostic('checkout_verify_timeout', { issue: 'challenge_timeout', waitMs: elapsed(target.verifyStarted) }, target);
          token = ''; submit.disabled = true;
          message.textContent = '認証を再確認しています。チェック欄が表示された場合は選択してください。';
          verifyWait(target);
        },
        'unsupported-callback'() {
          if (!current() || busy) return;
          clearTimeout(verifyTimer); target.stage = 'error'; token = ''; submit.disabled = true;
          diagnostic('checkout_verify_error', { issue: 'unsupported_browser', waitMs: elapsed(target.verifyStarted) }, target);
          message.textContent = 'このブラウザーでは接続を確認できません。SafariやChromeなどのブラウザーでお試しください。';
        },
        'error-callback'(code) {
          if (!current() || busy) return true;
          clearTimeout(verifyTimer); target.stage = 'error'; token = ''; submit.disabled = true;
          diagnostic('checkout_verify_error', { issue: 'challenge_failed', verificationCode: code, waitMs: elapsed(target.verifyStarted) }, target);
          message.textContent = '接続を確認できません。画面を閉じて、もう一度お試しください。'; return true;
        },
      });
    } catch (error) {
      if (!current()) return;
      clearTimeout(verifyTimer); target.stage = 'error';
      diagnostic('checkout_verify_error', { issue: error.code || 'render_failed', waitMs: elapsed(target.verifyStarted) }, target);
      message.textContent = messages.verification_unavailable;
    }
  });
  async function openCheckout() {
    if (!selected || !token || busy || !journey || !dialog.open || journey.exited || journey.redirected) return;
    const target = journey;
    const set = target.set, verificationToken = token;
    // One purchase-button click authorizes one automatic attempt. A failed
    // request must wait for an explicit retry, even if Turnstile succeeds again.
    target.autoAdvance = false; target.usedTokens.add(verificationToken); token = '';
    const current = () => journey === target && dialog.open && !target.exited;
    const requestStarted = performance.now();
    target.stage = 'request'; target.attempt++;
    diagnostic('checkout_submit', { waitMs: 0 }, target);
    requestTimer = setTimeout(() => {
      if (journey === target && busy && !target.redirected) diagnostic('checkout_request_slow', { waitMs: elapsed(requestStarted) }, target);
    }, 10000);
    busy = true; submit.disabled = true; submit.hidden = true; lastError = '';
    dialog.querySelector('[data-checkout-close]').disabled = true;
    message.textContent = 'お支払い画面を開いています…';
    try {
      const requestId = requestIdFor(set.id);
      const analytics = await getAnalyticsContext().catch(() => null);
      if (!current()) return;
      const result = await api('/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setId: set.id, requestId, turnstileToken: verificationToken, ...(analytics ? { analytics } : {}) }) });
      if (!current()) return;
      if (result.status === 'complete' && /^cs_[A-Za-z0-9_]+$/.test(result.sessionId || '')) {
        clearTimeout(requestTimer); target.stage = 'redirect'; target.redirected = true;
        diagnostic('checkout_redirect', { waitMs: elapsed(requestStarted) }, target);
        location.assign(`./order-complete.html?session_id=${encodeURIComponent(result.sessionId)}`);
        return;
      }
      let destination;
      try { destination = new URL(result.url); }
      catch { throw Object.assign(new Error('invalid_destination'), { code: 'invalid_destination' }); }
      if (destination.origin !== 'https://checkout.stripe.com') throw Object.assign(new Error('invalid_destination'), { code: 'invalid_destination' });
      clearTimeout(requestTimer); target.stage = 'redirect'; target.redirected = true;
      diagnostic('checkout_redirect', { waitMs: elapsed(requestStarted) }, target);
      await trackCheckoutStart(set, requestId).catch(() => {});
      if (!current()) return;
      location.assign(destination.href);
    } catch (error) {
      if (!current()) return;
      clearTimeout(requestTimer); target.stage = 'error'; target.redirected = false;
      diagnostic('checkout_request_error', { issue: classifyCheckoutError(error), httpStatus: error.httpStatus, waitMs: elapsed(requestStarted) }, target);
      if (error.code === 'checkout_unavailable') forget(set.id);
      lastError = messages[error.code] || '通信を確認できませんでした。同じセットでもう一度お試しください。';
      message.textContent = lastError;
      busy = false; token = '';
      submit.disabled = true; submit.hidden = false;
      dialog.querySelector('[data-checkout-close]').disabled = false;
      if (widget !== undefined) { verifyWait(target); window.turnstile.reset(widget); }
      if (error.code === 'out_of_stock') refresh();
    }
  }
  submit.addEventListener('click', () => { if (!submit.hidden) void openCheckout(); });
  refresh();
  window.addEventListener('pagehide', () => {
    if (journey && dialog.open && !journey.redirected && !journey.exited) {
      diagnostic('checkout_page_exit'); journey.exited = true;
    }
    clearTimeout(verifyTimer); clearTimeout(requestTimer);
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      // The pagehide event already records the previous page exit, not a manual close.
      journey = undefined;
      busy = false; dialog.querySelector('[data-checkout-close]').disabled = false;
      if (dialog.open) dialog.close();
      refresh();
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !dialog.open) refresh(); });
}

const order = document.querySelector('[data-order-status]');
if (order) {
  const sessionId = new URLSearchParams(location.search).get('session_id');
  const heading = document.querySelector('[data-order-heading]');
  const checkButton = document.querySelector('[data-order-check]');
  let polls = 0, checking = false;
  async function check() {
    if (checking) return;
    checking = true; checkButton.disabled = true;
    try {
      if (!config?.apiOrigin || !/^cs_[A-Za-z0-9_]+$/.test(sessionId || '')) throw new Error('missing_session');
      const result = await api(`/order-status?session_id=${encodeURIComponent(sessionId)}`);
      if (result.paid && result.recorded) {
        heading.textContent = 'ご注文ありがとうございます。';
        order.textContent = `${result.bags}袋・${result.amount.toLocaleString('ja-JP')}円（税込・送料込み）のお支払いを確認しました。入金確認後3営業日以内に発送します。`;
        forget(result.setId, result.requestId);
        checkButton.hidden = true;
      } else if (result.state === 'failed' || result.status === 'expired') {
        heading.textContent = 'お支払いは完了していません。';
        order.textContent = 'この購入手続きは終了しました。セット一覧から、もう一度お手続きいただけます。';
        forget(result.setId, result.requestId);
      } else {
        heading.textContent = 'お支払いの確認待ちです。';
        order.textContent = '決済の確認後に発送を手配します。確認に時間がかかる場合があります。重複して注文せず、しばらくお待ちください。';
        if (++polls < 5) setTimeout(check, 4000);
      }
    } catch {
      heading.textContent = '注文状況を確認できませんでした。';
      order.textContent = 'この表示だけでは決済の完了・未完了を判断できません。再確認するか、お問い合わせフォームからご連絡ください。重複して注文しないようご注意ください。';
    } finally { checking = false; checkButton.disabled = false; }
  }
  checkButton.addEventListener('click', check);
  check();
}
