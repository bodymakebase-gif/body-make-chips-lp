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
  const response = await fetch(`${config.apiOrigin}${path}`, { ...options, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(45000) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'unavailable'), { code: data.error });
  return data;
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
  if (window.turnstile) return Promise.resolve();
  if (!turnstileLoading) turnstileLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => { script.remove(); turnstileLoading = null; reject(new Error('verification_unavailable')); };
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
  const availability = {};
  async function refresh() {
    try {
      const data = await api('/availability');
      if (data.livemode !== config.livemode) throw new Error('mode_mismatch');
      for (const button of buyButtons) {
        availability[button.dataset.buySet] = data.available[button.dataset.buySet] === true;
        button.disabled = !availability[button.dataset.buySet];
        button.textContent = button.disabled ? 'ただいま在庫なし' : 'このセットを購入';
      }
    } catch {
      for (const button of buyButtons) { button.disabled = true; button.textContent = 'ただいま購入できません'; }
    }
  }
  function cleanup() {
    generation++;
    if (widget !== undefined) window.turnstile?.remove(widget);
    widget = undefined; token = ''; selected = undefined;
  }
  dialog.addEventListener('close', cleanup);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.querySelector('[data-checkout-close]').addEventListener('click', () => { if (!busy) dialog.close(); });
  for (const button of buyButtons) button.addEventListener('click', async () => {
    selected = config.sets.find(set => set.id === button.dataset.buySet);
    if (!selected || !availability[selected.id]) return;
    const thisGeneration = ++generation;
    dialog.querySelector('[data-checkout-name]').textContent = selected.name;
    dialog.querySelector('[data-checkout-quantity]').textContent = `15g × ${selected.quantity}袋`;
    dialog.querySelector('[data-checkout-total]').textContent = `${selected.price.toLocaleString('ja-JP')}円`;
    message.textContent = '接続を確認しています…';
    submit.disabled = true; token = ''; lastError = '';
    dialog.showModal();
    try {
      await loadTurnstile();
      if (!dialog.open || thisGeneration !== generation) return;
      widget = window.turnstile.render(verification, {
        sitekey: config.turnstileSiteKey, action: 'checkout', theme: 'light', size: innerWidth < 380 ? 'compact' : 'normal',
        callback(value) { token = value; submit.disabled = busy; message.textContent = lastError || '次の画面で配送先・お支払い方法を入力できます。'; },
        'expired-callback'() { token = ''; submit.disabled = true; message.textContent = '確認の有効期限が切れました。再確認しています…'; },
        'error-callback'() { token = ''; submit.disabled = true; message.textContent = '接続を確認できません。画面を閉じて、もう一度お試しください。'; return true; },
      });
    } catch { message.textContent = messages.verification_unavailable; }
  });
  submit.addEventListener('click', async () => {
    if (!selected || !token || busy) return;
    busy = true; submit.disabled = true; lastError = '';
    dialog.querySelector('[data-checkout-close]').disabled = true;
    message.textContent = 'お支払い画面を開いています…';
    try {
      const result = await api('/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setId: selected.id, requestId: requestIdFor(selected.id), turnstileToken: token }) });
      if (result.status === 'complete' && /^cs_[A-Za-z0-9_]+$/.test(result.sessionId || '')) {
        location.assign(`./order-complete.html?session_id=${encodeURIComponent(result.sessionId)}`);
        return;
      }
      const destination = new URL(result.url);
      if (destination.origin !== 'https://checkout.stripe.com') throw new Error('invalid_destination');
      location.assign(destination.href);
    } catch (error) {
      if (error.code === 'checkout_unavailable') forget(selected.id);
      lastError = messages[error.code] || '通信を確認できませんでした。同じセットでもう一度お試しください。';
      message.textContent = lastError;
      busy = false; token = '';
      dialog.querySelector('[data-checkout-close]').disabled = false;
      if (widget !== undefined) window.turnstile.reset(widget);
      if (error.code === 'out_of_stock') refresh();
    }
  });
  refresh();
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
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
        order.textContent = `${result.bags}袋・${result.amount.toLocaleString('ja-JP')}円（税込・送料込み）のお支払いを確認しました。2026年11月5日から順次発送します。それ以降の通常注文は入金確認後3営業日以内に発送します。`;
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
