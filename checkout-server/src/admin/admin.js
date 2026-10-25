const $ = id => document.getElementById(id);
const labels = { sample: '試供品として取り分け', damage: '破損・廃棄', receipt: '追加納品', return: '返品分を戻す', reversal: '誤登録の取り消し' };
const signs = { sample: -1, damage: -1, receipt: 1, return: 1 };
const format = value => Number(value).toLocaleString('ja-JP');
const date = seconds => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(seconds * 1000));
const messages = {
  invalid_admin_key: '管理キーが違います。コピーした内容を確認してください。',
  authentication_required: 'ログインの有効期限が切れました。もう一度ログインしてください。',
  too_many_attempts: 'ログインの試行が続いています。15分ほど待ってからお試しください。',
  insufficient_stock: '販売可能数を超えています。最新の在庫を確認し、袋数を減らしてください。',
  inventory_needs_review: '確認が必要な在庫があります。変更を止め、決済記録と照合してください。',
  already_reversed: 'この記録はすでに取り消されています。',
  request_conflict: '同じ登録番号で異なる内容が指定されました。画面を更新して履歴を確認してください。',
  invalid_quantity: '袋数は1〜100,000の整数で入力してください。',
  admin_not_configured: '管理キーの設定が完了していません。',
  order_changed: '別の画面で更新されています。最新の内容を読み直してから操作してください。',
  invalid_transition: '注文の状態が変わっています。最新の内容を読み直してください。',
  order_not_found: '支払い済みの注文が見つかりません。',
  order_needs_review: '決済記録との照合が必要です。発送を止め、Stripeで確認してください。',
  invalid_shipped_date: '発送日は注文日から今日までの実際の日付を指定してください。',
  invalid_tracking: '追跡番号には半角英数字とハイフンを使ってください。',
  invalid_fulfillment_input: '入力内容を確認してください。配送会社・追跡番号・訂正理由などに不備があります。',
  shipment_confirmation_required: '実際に発送したことを確認してください。',
  contact_confirmation_required: 'お客様へメールを送信したことを確認してください。',
};
let summary = null, nextCursor = null, busy = false, loggedIn = false, pending = null, uncertain = false, refreshVersion = 0;
try { pending = JSON.parse(sessionStorage.getItem('bmc-stock-pending') || 'null'); if (pending) uncertain = true; } catch {}
const remember = () => { try { if (pending) sessionStorage.setItem('bmc-stock-pending', JSON.stringify(pending)); else sessionStorage.removeItem('bmc-stock-pending'); } catch {} };
function message(id, text, type = 'error') { $(id).textContent = text; $(id).className = 'message ' + type; }
function requireLogin() {
  loggedIn = false; summary = null; refreshVersion++;
  $('dashboard').hidden = true; $('logout').hidden = true; $('login-panel').hidden = false;
  if ($('confirm-dialog').open) $('confirm-dialog').close();
  clearOrderView();
}
async function api(path, data) {
  let response;
  try { response = await fetch('/admin/api/' + path, { method: data ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: data ? { 'Content-Type': 'application/json', 'X-BMC-Admin': '1' } : {}, body: data ? JSON.stringify(data) : undefined }); }
  catch { throw Object.assign(new Error('通信できませんでした。接続を確認して再試行してください。'), { uncertain: true }); }
  let result; try { result = await response.json(); } catch { throw Object.assign(new Error('応答を確認できませんでした。もう一度お試しください。'), { uncertain: true }); }
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') { const expired = loggedIn; requireLogin(); if (expired) message('login-message', messages.authentication_required); }
    throw Object.assign(new Error(messages[result.error] || '処理できませんでした。時間をおいて再試行してください。'), { code: result.error, uncertain: response.status >= 500 });
  }
  return result;
}
function renderSummary(data) {
  summary = data;
  for (const key of ['available', 'held', 'paid']) $(key).textContent = format(data[key]);
  $('calculation').textContent = `開始時 ${format(data.initial)}袋 ＋ 手動の増減 ${data.adjustments >= 0 ? '+' : '−'}${format(Math.abs(data.adjustments))}袋 − 購入手続き中 ${format(data.held)}袋 − 販売済み ${format(data.paid)}袋${data.review ? ` − 要確認 ${format(data.review)}袋` : ''}`;
  $('updated').textContent = '更新 ' + date(data.updatedAt);
  $('review-warning').hidden = !(data.review || data.available < 0);
  $('review-warning').textContent = `要確認の在庫：${format(data.review)}袋。安全のため在庫変更を停止しています。Stripeの記録との照合が必要です。`;
  $('adjust-fields').disabled = Boolean(data.review || data.available < 0 || busy || pending);
  updatePreview();
}
function updatePreview() {
  const bags = Number($('bags').value), sign = signs[$('kind').value];
  $('quantity-hint').textContent = $('kind').value === 'return' ? '再販売できることを確認した商品だけを登録します。' : 'セット数ではなく、袋数を入力します。';
  if (!summary || !Number.isInteger(bags) || bags < 1) { $('preview').textContent = '袋数を入れると、変更後の在庫が表示されます。'; return; }
  const after = summary.available + sign * bags;
  $('preview').textContent = after < 0 ? '販売可能数を超えています。袋数を減らしてください。' : `販売可能 ${format(summary.available)}袋 → ${format(after)}袋`;
}
function showConfirm() {
  if (!pending || !loggedIn) return;
  $('confirm-title').textContent = uncertain ? '前回の登録結果を確認します' : 'この内容で登録しますか？';
  $('confirm-kind').textContent = labels[pending.kind];
  $('confirm-quantity').textContent = (pending.delta > 0 ? '＋' : '−') + format(pending.bags) + '袋';
  $('confirm-note').textContent = pending.note || 'メモなし';
  $('confirm-impact').textContent = summary ? `販売可能 ${format(summary.available)}袋 → ${format(summary.available + pending.delta)}袋` : '最新の在庫に反映します。';
  if (uncertain) $('confirm-impact').textContent = '同じ登録番号で確認します。すでに登録済みの場合、重複して変更しません。';
  message('confirm-error', uncertain ? '通信が途切れた登録が残っています。「登録結果を確認」を押してください。' : '');
  $('cancel-change').disabled = uncertain; $('dialog-close').disabled = uncertain;
  $('commit-change').textContent = uncertain ? '登録結果を確認' : '登録する';
  if (!$('confirm-dialog').open) $('confirm-dialog').showModal();
}
function clearPending() { pending = null; uncertain = false; remember(); if (summary) renderSummary(summary); }
function renderHistory(items, append) {
  const parent = $('history'); if (!append) parent.replaceChildren();
  if (!items.length && !append) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '手動で変更した記録はまだありません。'; parent.append(empty); return; }
  for (const row of items) {
    const item = document.createElement('article'); item.className = 'history-item';
    const detail = document.createElement('div'), action = document.createElement('div');
    const time = document.createElement('div'); time.className = 'history-time'; time.textContent = `${date(row.created)} · ${row.actor}`;
    const title = document.createElement('h3'); title.textContent = labels[row.kind] || row.kind;
    const note = document.createElement('p'); note.className = 'history-note'; note.textContent = row.note;
    const meta = document.createElement('p'); meta.className = 'history-meta'; meta.textContent = `登録時の販売可能数 ${format(row.before_available)} → ${format(row.after_available)}袋`;
    detail.append(time, title); if (row.note) detail.append(note); detail.append(meta);
    const delta = document.createElement('p'); delta.className = 'delta ' + (row.delta > 0 ? 'positive' : 'negative'); delta.textContent = (row.delta > 0 ? '＋' : '−') + format(Math.abs(row.delta)) + '袋'; action.append(delta);
    if (row.reversed_by || row.kind === 'reversal') {
      const label = document.createElement('p'); label.className = 'undone'; label.textContent = row.reversed_by ? '取り消し済み' : '取り消し記録'; action.append(label);
    } else {
      const undo = document.createElement('button'); undo.className = 'undo'; undo.textContent = '取り消す'; undo.setAttribute('aria-label', `${date(row.created)}の${labels[row.kind]} ${row.bags}袋を取り消す`);
      undo.addEventListener('click', () => {
        if (busy || pending || !summary || summary.review) return;
        pending = { requestId: crypto.randomUUID(), kind: 'reversal', reversalOf: row.request_id, bags: row.bags, delta: -row.delta, note: `${date(row.created)}「${labels[row.kind]}」の誤登録を取り消し` };
        uncertain = false; renderSummary(summary); showConfirm();
      }); action.append(undo);
    }
    item.append(detail, action); parent.append(item);
  }
}
async function loadStockHistory(append = false) {
  const result = await api('history' + (append && nextCursor ? '?before=' + nextCursor : ''));
  if (!loggedIn) return;
  renderHistory(result.items, append); nextCursor = result.next; $('load-more').hidden = !nextCursor;
}
async function refresh(withHistory = false) {
  const version = ++refreshVersion;
  try {
    const data = await api('summary'); if (version !== refreshVersion) return;
    loggedIn = true; $('dashboard').hidden = false; $('logout').hidden = false; $('login-panel').hidden = true;
    renderSummary(data);
    if (withHistory) await loadStockHistory();
    if (pending && !$('confirm-dialog').open) showConfirm();
    if (activeTab === 'orders') await refreshOrders();
    if (orderPending && !$('order-dialog').open && !$('confirm-dialog').open) openOrder(orderPending.id);
  } catch (error) {
    if (version !== refreshVersion) return;
    if (loggedIn) { $('adjust-fields').disabled = true; message('status', '最新の在庫を取得できません。' + error.message); }
    else if (error.code !== 'authentication_required') message('login-message', error.message);
  }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-button').disabled = true; message('login-message', '');
  try { await api('login', { key: $('admin-key').value.trim() }); $('admin-key').value = ''; await refresh(true); }
  catch (error) { message('login-message', error.message); }
  finally { $('login-button').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  if (busy) return;
  try { await api('logout', {}); requireLogin(); message('login-message', 'ログアウトしました。', 'success'); }
  catch (error) { message('status', error.message); }
});
$('refresh').addEventListener('click', async () => { if (busy) return; $('refresh').disabled = true; message('status', ''); await refresh(true); $('refresh').disabled = false; });
for (const id of ['bags', 'kind']) $(id).addEventListener('input', updatePreview);
$('adjust-form').addEventListener('submit', event => {
  event.preventDefault(); if (!summary || busy || pending) return;
  const bags = Number($('bags').value), kind = $('kind').value;
  if (!Number.isSafeInteger(bags) || bags < 1 || bags > 100000 || summary.available + signs[kind] * bags < 0) { message('status', messages.insufficient_stock); return; }
  pending = { requestId: crypto.randomUUID(), kind, bags, delta: signs[kind] * bags, note: $('note').value.trim() };
  uncertain = false; renderSummary(summary); showConfirm();
});
function cancel() { if (busy || uncertain) return; $('confirm-dialog').close(); clearPending(); }
$('cancel-change').addEventListener('click', cancel);
$('dialog-close').addEventListener('click', event => { event.preventDefault(); cancel(); });
$('confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); cancel(); });
$('commit-change').addEventListener('click', async () => {
  if (!pending || busy) return;
  busy = true; uncertain = true; remember(); refreshVersion++;
  $('commit-change').disabled = true; $('cancel-change').disabled = true; $('dialog-close').disabled = true; message('confirm-error', '');
  const input = { requestId: pending.requestId, kind: pending.kind, bags: pending.bags, note: pending.note, ...(pending.reversalOf ? { reversalOf: pending.reversalOf } : {}) };
  try {
    const result = await api('adjust', input), change = result.adjustment;
    clearPending(); $('confirm-dialog').close(); $('adjust-form').reset();
    renderSummary({ ...result.summary, updatedAt: result.updatedAt });
    message('status', `${result.duplicate ? '登録済みであることを確認しました。二重の変更はしていません。' : '登録しました。'} ${labels[change.kind]} ${change.delta > 0 ? '＋' : '−'}${format(change.bags)}袋。`, 'success');
    try { await loadStockHistory(); } catch { message('status', '在庫の変更は登録済みです。履歴を取得できなかったため「最新の在庫に更新」を押してください。', 'success'); }
  } catch (error) {
    // Only a definitive rejection permits editing. A lost response keeps the same request ID.
    if (!error.uncertain && error.code !== 'authentication_required') {
      uncertain = false; remember(); $('cancel-change').disabled = false; $('dialog-close').disabled = false;
    }
    message('confirm-error', error.message + (uncertain ? '\n同じ登録番号で再確認するので、二重には減りません。' : ''));
    $('commit-change').textContent = uncertain ? '登録結果を確認' : '再試行';
  } finally {
    busy = false; $('commit-change').disabled = false;
    if (summary) renderSummary(summary);
  }
});
$('load-more').addEventListener('click', async () => { $('load-more').disabled = true; try { await loadStockHistory(true); } catch (error) { message('status', error.message); } finally { $('load-more').disabled = false; } });
if (document.body.dataset.environment === 'test') {
  $('environment').textContent = 'テスト環境'; $('environment').classList.add('test');
  $('stock-stripe').href = 'https://dashboard.stripe.com/acct_1ThYmB2KjzkCozaC/test/payments';
}
else $('environment').textContent = '本番';
setInterval(() => { if (loggedIn && !busy && !pending && !document.hidden) refresh(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && loggedIn && !busy && !pending) refresh(); });

// Fulfillment and stock share authentication, but keep independent, audited records.
const statusLabels = { unshipped: '未発送', shipped: '発送済み', contacted: '連絡済み' };
const day = seconds => new Date((seconds + 9 * 3600) * 1000).toISOString().slice(0, 10);
let activeTab = location.hash === '#orders' ? 'orders' : 'inventory';
let orderFilter = 'unshipped', ordersNext = null, ordersVersion = 0, detailVersion = 0, activeOrderId = null, orderDetail = null, orderPending = null;
try { orderPending = JSON.parse(sessionStorage.getItem('bmc-fulfillment-pending') || 'null'); } catch {}
function rememberOrder() {
  try { if (orderPending) sessionStorage.setItem('bmc-fulfillment-pending', JSON.stringify(orderPending)); else sessionStorage.removeItem('bmc-fulfillment-pending'); } catch {}
}
function clearOrderView() {
  ordersVersion++; detailVersion++; orderDetail = null; activeOrderId = null;
  $('order-dialog').close(); $('order-content').hidden = true; $('orders-list').replaceChildren();
  for (const id of ['order-recipient', 'order-contact', 'order-audit', 'order-summary', 'order-id', 'shipment-summary']) $(id).replaceChildren();
  $('order-stripe').removeAttribute('href');
}
function switchTab(tab) {
  if (busy) return;
  activeTab = tab; $('inventory-panel').hidden = tab !== 'inventory'; $('orders-panel').hidden = tab !== 'orders';
  for (const name of ['inventory', 'orders']) { if (name === tab) $(name + '-tab').setAttribute('aria-current', 'page'); else $(name + '-tab').removeAttribute('aria-current'); }
  if (tab === 'orders' && loggedIn) refreshOrders().catch(error => message('orders-message', error.message));
}
$('inventory-tab').addEventListener('click', () => { historyReplace('#inventory'); switchTab('inventory'); });
$('orders-tab').addEventListener('click', () => { historyReplace('#orders'); switchTab('orders'); });
function historyReplace(hash) { window.history.replaceState(null, '', hash); }
window.addEventListener('hashchange', () => switchTab(location.hash === '#orders' ? 'orders' : 'inventory'));
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
function badge(status) { return element('span', statusLabels[status], 'order-status ' + status); }
async function refreshOrders(append = false) {
  const version = ++ordersVersion;
  const data = await api(`orders?status=${orderFilter}${append && ordersNext ? '&after=' + ordersNext : ''}`);
  if (version !== ordersVersion || !loggedIn) return;
  const list = $('orders-list'); if (!append) list.replaceChildren();
  for (const [key, count] of Object.entries(data.counts)) $('count-' + key).textContent = format(count);
  if (!data.items.length && !append) list.append(element('p', orderFilter === 'all' ? '支払い済みの注文はまだありません。' : `${statusLabels[orderFilter]}の注文はありません。`, 'empty'));
  for (const row of data.items) {
    const article = document.createElement('article'); article.className = 'order-row';
    const content = document.createElement('div'), top = document.createElement('div'); top.className = 'order-row-top';
    top.append(badge(row.status), element('span', date(row.created), 'small'));
    content.append(top, element('h3', `${row.name}　¥${format(row.amount)}`), element('p', `注文番号 ${row.id.slice(0, 8)} · ${row.bags}袋`, 'small'));
    if (row.status !== 'unshipped') content.append(element('p', `${row.shipped_date} 発送 · ${row.carrier} · ${row.tracking}`, 'order-tracking'));
    const button = element('button', row.status === 'unshipped' ? '確認・発送する →' : row.status === 'shipped' ? '発送連絡をする →' : '詳細を見る →', 'secondary');
    button.addEventListener('click', () => openOrder(orderPending?.id || row.id));
    article.append(content, button); list.append(article);
  }
  ordersNext = data.next; $('orders-more').hidden = !ordersNext;
}
for (const button of document.querySelectorAll('[data-order-filter]')) button.addEventListener('click', async () => {
  if (busy) return; orderFilter = button.dataset.orderFilter;
  for (const other of document.querySelectorAll('[data-order-filter]')) other.setAttribute('aria-pressed', String(other === button));
  message('orders-message', '');
  try { await refreshOrders(); } catch (error) { message('orders-message', error.message); }
});
for (const id of ['orders-refresh', 'orders-more']) $(id).addEventListener('click', async () => {
  if (busy) return; $(id).disabled = true; message('orders-message', '');
  try { await refreshOrders(id === 'orders-more'); } catch (error) { message('orders-message', error.message); } finally { $(id).disabled = false; }
});
async function openOrder(id) {
  if (busy || !loggedIn) return;
  const version = ++detailVersion; activeOrderId = id; orderDetail = null;
  $('order-content').hidden = true; $('order-title').textContent = '注文を読み込んでいます…';
  message('order-error', ''); $('order-reload').hidden = true; $('order-retry-box').hidden = !orderPending;
  if (!$('order-dialog').open) $('order-dialog').showModal();
  try {
    const detail = await api('order?id=' + encodeURIComponent(id));
    if (!loggedIn || version !== detailVersion) return;
    orderDetail = detail; renderOrder();
  } catch (error) {
    if (!loggedIn || version !== detailVersion) return;
    $('order-title').textContent = '注文を取得できません'; message('order-error', error.message); $('order-reload').hidden = false;
  }
}
function renderOrder() {
  const { order: row, recipient, history: events } = orderDetail;
  $('order-title').textContent = row.name; $('order-content').hidden = false;
  $('order-summary').replaceChildren(badge(row.status), element('strong', `¥${format(row.amount)} · ${row.bags}袋`), element('span', date(row.created), 'small'));
  $('order-id').textContent = '注文番号 ' + row.id;
  const address = recipient.address;
  $('order-recipient').textContent = address ? [recipient.name, '〒' + (address.postal_code || ''), [address.state, address.city, address.line1].filter(Boolean).join(''), address.line2].filter(Boolean).join('\n') : '配送先を取得できません。Stripeで必ず確認してください。';
  $('order-contact').textContent = [recipient.email, recipient.phone].filter(Boolean).join('\n');
  $('order-stripe').href = orderDetail.stripeUrl;
  $('shipment-summary').hidden = row.status === 'unshipped';
  $('shipment-summary').textContent = row.status === 'unshipped' ? '' : `発送日 ${row.shipped_date}\n${row.carrier} · 追跡番号 ${row.tracking}`;
  $('shipment-form').hidden = row.status !== 'unshipped'; $('shipment-form').reset();
  $('shipped-date').value = day(Date.now() / 1000); $('shipped-date').max = day(Date.now() / 1000); $('shipped-date').min = day(row.created);
  $('contact-section').hidden = row.status !== 'shipped'; $('contact-form').reset(); $('copy-result').textContent = '';
  $('copy-email').disabled = !recipient.email;
  $('contact-complete').hidden = row.status !== 'contacted';
  $('contact-complete').textContent = row.contacted_at ? `${date(row.contacted_at)} に発送連絡を記録しました。` : '';
  $('order-correction').hidden = row.status === 'unshipped'; $('order-correction').open = false; $('order-undo-form').reset();
  $('order-undo').textContent = row.status === 'contacted' ? '発送済みに戻す' : '未発送に戻す';
  $('order-audit').replaceChildren();
  if (!events.length) $('order-audit').append(element('p', '発送の操作はまだありません。', 'small'));
  for (const event of events) {
    const item = element('p', `${date(event.created)} · ${statusLabels[event.before.status]} → ${statusLabels[event.after.status]}\n${event.reason || (event.action === 'ship' ? `${event.after.carrier} ${event.after.tracking}（発送日 ${event.after.shipped_date}）` : 'お客様への発送連絡を記録')}`, 'audit-item');
    $('order-audit').append(item);
  }
  setOrderDisabled(Boolean(orderPending));
}
function setOrderDisabled(value) {
  $('shipment-fields').disabled = value; $('contact-fields').disabled = value; $('order-undo').disabled = value;
  $('order-retry-box').hidden = !orderPending; $('order-retry').disabled = busy;
  $('order-close').disabled = busy;
}
async function saveOrder(input) {
  if (busy) return;
  orderPending = input; rememberOrder(); busy = true; setOrderDisabled(true); message('order-error', ''); $('order-reload').hidden = true;
  let succeeded = false;
  try {
    const result = await api('fulfillment', input);
    orderPending = null; rememberOrder(); succeeded = true;
    message('orders-message', `${result.duplicate ? '登録済みであることを確認しました。' : '登録しました。'} 注文 ${result.order.id.slice(0, 8)}：${statusLabels[result.order.status]}`, 'success');
  } catch (error) {
    if (!error.uncertain && error.code !== 'authentication_required') { orderPending = null; rememberOrder(); $('order-reload').hidden = false; }
    message('order-error', error.message);
  } finally { busy = false; setOrderDisabled(Boolean(orderPending)); }
  if (succeeded && loggedIn) {
    await openOrder(input.id);
    try { await refreshOrders(); } catch { message('orders-message', '登録済みです。一覧を更新できなかったため「最新の注文に更新」を押してください。', 'success'); }
  }
}
function orderInput(action) { return { operationId: crypto.randomUUID(), id: orderDetail.order.id, version: orderDetail.order.version, action }; }
$('shipment-form').addEventListener('submit', event => {
  event.preventDefault(); if (!orderDetail || orderPending || busy) return;
  saveOrder({ ...orderInput('ship'), shippedDate: $('shipped-date').value, carrier: $('shipping-carrier').value, tracking: $('shipping-tracking').value.trim(), confirmed: $('shipping-confirm').checked });
});
$('contact-form').addEventListener('submit', event => {
  event.preventDefault(); if (!orderDetail || orderPending || busy) return;
  saveOrder({ ...orderInput('contact'), confirmed: $('contact-confirm').checked });
});
$('order-undo-form').addEventListener('submit', event => {
  event.preventDefault(); if (!orderDetail || orderPending || busy) return;
  saveOrder({ ...orderInput('undo'), reason: $('order-undo-reason').value.trim() });
});
$('order-retry').addEventListener('click', () => { if (orderPending) saveOrder(orderPending); });
$('order-reload').addEventListener('click', () => { if (activeOrderId) openOrder(activeOrderId); });
function closeOrder() { if (busy) return; detailVersion++; $('order-dialog').close(); orderDetail = null; $('order-content').hidden = true; }
$('order-close').addEventListener('click', closeOrder);
$('order-dialog').addEventListener('cancel', event => { event.preventDefault(); closeOrder(); });
async function copyOrderText(text) {
  try { await navigator.clipboard.writeText(text); $('copy-result').textContent = 'コピーしました。メールに貼り付け、内容を確認して送信してください。'; }
  catch { $('copy-result').textContent = 'コピーできませんでした。ブラウザのクリップボード許可を確認してください。'; }
}
$('copy-email').addEventListener('click', () => { if (orderDetail) copyOrderText(orderDetail.recipient.email); });
$('copy-shipping-mail').addEventListener('click', () => {
  if (!orderDetail) return;
  const { order: row, recipient } = orderDetail;
  copyOrderText(`件名：【BODY-MAKE CHIPS】商品を発送しました\n\n${recipient.name ? recipient.name + ' 様\n\n' : ''}このたびはBODY-MAKE CHIPSをご注文いただき、ありがとうございます。\nご注文の商品を発送いたしました。\n\nご注文：${row.name}\n注文番号：${row.id}\n発送日：${row.shipped_date}\n配送会社：${row.carrier}\n追跡番号：${row.tracking}\n\n配送状況は配送会社の追跡サービスでご確認いただけます。追跡情報の反映には時間がかかる場合がございます。\n商品のお届けまで、もうしばらくお待ちください。\n\nBODY-MAKE BASE\nhttps://body-make-chips.jp/`);
});
switchTab(activeTab);
refresh(true);
