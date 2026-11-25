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
  invalid_tracking: '追跡番号を半角英数字とハイフンで入力するか、「なし」を選んでください。',
  invalid_fulfillment_input: '入力内容を確認してください。配送会社・追跡番号・訂正理由などに不備があります。',
  shipment_confirmation_required: '実際に発送したことを確認してください。',
  fulfillment_action_removed: '発送後の連絡工程は廃止されました。最新の内容を読み直してください。',
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
  clearReviewView();
  clearCouponView();
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
  $('calculation').textContent = `開始時 ${format(data.initial)}袋 ＋ 手動の増減 ${data.adjustments >= 0 ? '+' : '−'}${format(Math.abs(data.adjustments))}袋 − 購入手続き中 ${format(data.held)}袋 − 注文確定 ${format(data.paid)}袋${data.review ? ` − 要確認 ${format(data.review)}袋` : ''}`;
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
    if (activeTab === 'reviews') await refreshReviews().catch(error => message('reviews-message', error.message));
    if (activeTab === 'coupons') await refreshCoupons().catch(error => message('coupons-message', error.message));
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
  if (busy || reviewSaving || reviewImageProcessing || couponSaving) return;
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
setInterval(() => { if (loggedIn && !busy && !pending && !reviewSaving && !reviewPending && !couponSaving && !couponPending && !document.hidden) refresh(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && loggedIn && !busy && !pending && !reviewSaving && !reviewPending && !couponSaving && !couponPending) refresh(); });

// Fulfillment and stock share authentication, but keep independent, audited records.
const statusLabels = { unshipped: '未発送', shipped: '発送済み', contacted: '発送済み' };
const trackingLabel = row => row.tracking ? `追跡番号 ${row.tracking}` : '追跡番号なし';
const day = seconds => new Date((seconds + 9 * 3600) * 1000).toISOString().slice(0, 10);
let activeTab = ['#orders', '#reviews', '#coupons'].includes(location.hash) ? location.hash.slice(1) : 'inventory';
let orderFilter = 'unshipped', ordersNext = null, ordersVersion = 0, detailVersion = 0, activeOrderId = null, orderDetail = null, orderPending = null;
try { orderPending = JSON.parse(sessionStorage.getItem('bmc-fulfillment-pending') || 'null'); } catch {}
function rememberOrder() {
  try { if (orderPending) sessionStorage.setItem('bmc-fulfillment-pending', JSON.stringify(orderPending)); else sessionStorage.removeItem('bmc-fulfillment-pending'); } catch {}
}
function clearOrderView() {
  ordersVersion++; detailVersion++; orderDetail = null; activeOrderId = null;
  $('order-dialog').close(); $('order-content').hidden = true; $('orders-list').replaceChildren();
  for (const id of ['order-recipient', 'order-contact', 'order-audit', 'order-summary', 'order-id', 'shipment-summary', 'order-reviewer-note']) $(id).replaceChildren();
  $('order-reviewer-note').hidden = true;
  $('shipping-confirm-label').textContent = 'Stripeで返金・キャンセルがないことを確認し、実際に発送しました。';
  $('order-stripe').removeAttribute('href');
}
function switchTab(tab) {
  if (busy || reviewSaving || reviewImageProcessing || couponSaving) return;
  activeTab = tab;
  for (const name of ['inventory', 'orders', 'reviews', 'coupons']) { $(name + '-panel').hidden = tab !== name; if (name === tab) $(name + '-tab').setAttribute('aria-current', 'page'); else $(name + '-tab').removeAttribute('aria-current'); }
  if (tab === 'orders' && loggedIn) refreshOrders().catch(error => message('orders-message', error.message));
  if (tab === 'reviews' && loggedIn) refreshReviews().catch(error => message('reviews-message', error.message));
  if (tab === 'coupons' && loggedIn) refreshCoupons().catch(error => message('coupons-message', error.message));
}
$('inventory-tab').addEventListener('click', () => { historyReplace('#inventory'); switchTab('inventory'); });
$('orders-tab').addEventListener('click', () => { historyReplace('#orders'); switchTab('orders'); });
$('reviews-tab').addEventListener('click', () => { historyReplace('#reviews'); switchTab('reviews'); });
$('coupons-tab').addEventListener('click', () => { historyReplace('#coupons'); switchTab('coupons'); });
function historyReplace(hash) { window.history.replaceState(null, '', hash); }
window.addEventListener('hashchange', () => switchTab(['#orders', '#reviews', '#coupons'].includes(location.hash) ? location.hash.slice(1) : 'inventory'));
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
function badge(status) { return element('span', statusLabels[status], 'order-status ' + status); }
function orderCharge(row) { return row.amount_total ?? row.amount; }
function orderReviewerCode(row) { return typeof row.reviewer_code === 'string' ? row.reviewer_code.trim() : ''; }
function orderQuestionnaire(row) { return typeof row.questionnaire === 'string' ? row.questionnaire.trim() : ''; }
function orderPurposeLabel(row) { return orderReviewerCode(row) ? (orderCharge(row) === 0 ? 'レビュワー用・無料' : 'レビュワー用') : ''; }
function orderPriceText(row) {
  const charged = orderCharge(row), gross = row.amount;
  const discount = Math.max(0, Number(row.amount_discount) || 0, Number(gross) - Number(charged));
  return discount > 0 || charged !== gross ? `通常価格 ¥${format(gross)} ／ 割引 −¥${format(discount)}` : '';
}
function renderOrderPackingNote(row) {
  const code = orderReviewerCode(row), questionnaire = orderQuestionnaire(row), note = $('order-reviewer-note');
  note.replaceChildren(); note.hidden = !code && !questionnaire;
  if (code) {
    note.append(element('strong', orderPurposeLabel(row)));
    const pricing = orderPriceText(row); if (pricing) note.append(element('p', pricing));
    note.append(element('p', `クーポン：${code}`));
  }
  if (questionnaire) note.append(element('p', `「${questionnaire}」を同梱`, 'reviewer-order-note__survey'));
  $('shipping-confirm-label').textContent = questionnaire
    ? `Stripeでキャンセルされていない注文であることを確認し、「${questionnaire}」を同梱して実際に発送しました。`
    : code ? 'Stripeでキャンセルされていない注文であることを確認し、実際に発送しました。'
      : 'Stripeで返金・キャンセルがないことを確認し、実際に発送しました。';
}
async function refreshOrders(append = false) {
  const version = ++ordersVersion;
  const data = await api(`orders?status=${orderFilter}${append && ordersNext ? '&after=' + ordersNext : ''}`);
  if (version !== ordersVersion || !loggedIn) return;
  const list = $('orders-list'); if (!append) list.replaceChildren();
  for (const [key, count] of Object.entries(data.counts)) { const counter = $('count-' + key); if (counter) counter.textContent = format(count); }
  if (!data.items.length && !append) list.append(element('p', orderFilter === 'all' ? '支払い済みの注文はまだありません。' : `${statusLabels[orderFilter]}の注文はありません。`, 'empty'));
  for (const row of data.items) {
    const article = document.createElement('article'); article.className = 'order-row';
    const content = document.createElement('div'), top = document.createElement('div'); top.className = 'order-row-top';
    top.append(badge(row.status), element('span', date(row.created), 'small'));
    const purpose = orderPurposeLabel(row); if (purpose) top.append(element('span', purpose, 'order-purpose-badge'));
    content.append(top, element('h3', `${row.name}　¥${format(orderCharge(row))}`), element('p', `注文番号 ${row.id.slice(0, 8)} · ${row.bags}袋`, 'small'));
    const pricing = orderPriceText(row); if (pricing) content.append(element('p', pricing, 'order-price-note'));
    if (orderReviewerCode(row)) content.append(element('p', `クーポン：${orderReviewerCode(row)}`, 'small'));
    const questionnaire = orderQuestionnaire(row); if (questionnaire) content.append(element('p', `「${questionnaire}」を同梱`, 'order-survey-note'));
    if (row.status !== 'unshipped') content.append(element('p', `${row.shipped_date} 発送 · ${row.carrier} · ${trackingLabel(row)}`, 'order-tracking'));
    const button = element('button', row.status === 'unshipped' ? '確認・発送する →' : '詳細を見る →', 'secondary');
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
  $('order-summary').replaceChildren(badge(row.status), element('strong', `¥${format(orderCharge(row))} · ${row.bags}袋`), element('span', date(row.created), 'small'));
  const purpose = orderPurposeLabel(row); if (purpose) $('order-summary').append(element('span', purpose, 'order-purpose-badge'));
  renderOrderPackingNote(row);
  $('order-id').textContent = '注文番号 ' + row.id;
  const address = recipient.address;
  $('order-recipient').textContent = address ? [recipient.name, '〒' + (address.postal_code || ''), [address.state, address.city, address.line1].filter(Boolean).join(''), address.line2].filter(Boolean).join('\n') : '配送先を取得できません。Stripeで必ず確認してください。';
  $('order-contact').textContent = [recipient.email, recipient.phone].filter(Boolean).join('\n');
  $('order-stripe').href = orderDetail.stripeUrl;
  $('shipment-summary').hidden = row.status === 'unshipped';
  $('shipment-summary').textContent = row.status === 'unshipped' ? '' : `発送日 ${row.shipped_date}\n${row.carrier} · ${trackingLabel(row)}`;
  $('shipment-form').hidden = row.status !== 'unshipped'; $('shipment-form').reset();
  updateTrackingInput();
  $('shipped-date').value = day(Date.now() / 1000); $('shipped-date').max = day(Date.now() / 1000); $('shipped-date').min = day(row.created);
  $('order-correction').hidden = row.status === 'unshipped'; $('order-correction').open = false; $('order-undo-form').reset();
  $('order-undo').textContent = '未発送に戻す';
  $('order-audit').replaceChildren();
  if (!events.length) $('order-audit').append(element('p', '発送の操作はまだありません。', 'small'));
  for (const event of events) {
    const item = element('p', `${date(event.created)} · ${statusLabels[event.before.status]} → ${statusLabels[event.after.status]}\n${event.reason || (event.action === 'ship' ? `${event.after.carrier} · ${trackingLabel(event.after)}（発送日 ${event.after.shipped_date}）` : '発送連絡の記録（旧運用）')}`, 'audit-item');
    $('order-audit').append(item);
  }
  setOrderDisabled(Boolean(orderPending));
}
function setOrderDisabled(value) {
  $('shipment-fields').disabled = value; $('order-undo').disabled = value;
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
function updateTrackingInput() {
  const provided = $('shipping-tracking-mode').value === 'provided';
  $('shipping-tracking-field').hidden = !provided;
  $('shipping-tracking').disabled = !provided;
  $('shipping-tracking').required = provided;
}
$('shipping-tracking-mode').addEventListener('change', updateTrackingInput);
$('shipment-form').addEventListener('submit', event => {
  event.preventDefault(); if (!orderDetail || orderPending || busy) return;
  const trackingProvided = $('shipping-tracking-mode').value === 'provided';
  saveOrder({ ...orderInput('ship'), shippedDate: $('shipped-date').value, carrier: $('shipping-carrier').value, trackingProvided, tracking: trackingProvided ? $('shipping-tracking').value.trim() : '', confirmed: $('shipping-confirm').checked });
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
// Reviews use the same authenticated room, with independent editing and retries.
Object.assign(messages, {
  invalid_review: '表示名・星評価・コメントなど、入力内容を確認してください。',
  invalid_rating: '星評価を1〜5から選んでください。',
  invalid_review_image: '画像を読み込めません。JPEG・PNG・WebPの画像を選び直してください。',
  image_too_large: '画像を小さくしてから、もう一度お試しください。',
  too_many_images: '添付できる画像は3枚までです。',
  invalid_source_url: '引用元URLは https:// から入力してください。',
  permission_required: '本文と画像を掲載できる条件を確認し、チェックを入れてください。',
  review_permission_required: '本文と画像を掲載できる条件を確認し、チェックを入れてください。',
  review_changed: '別の画面でレビューが更新されています。一覧を更新して、編集し直してください。',
  review_not_found: 'レビューが見つかりません。一覧を更新してください。',
  request_too_large: '画像の容量が大きいため保存できません。画像を減らしてお試しください。',
});
const reviewStateLabels = { pending: '承認待ち', published: '公開中', hidden: '非公開' };
const reviewSourceLabels = { customer: '利用者の感想', monitor: '商品提供モニター', quoted: '外部レビューの引用', owner: '管理者の感想' };
const reviewRows = new Map();
let reviewFilter = 'pending', reviewPage = 1, reviewsVersion = 0, reviewsHaveMore = false;
let reviewEditing = null, reviewImages = [], reviewSaving = false, reviewImageProcessing = false;
let reviewSubmissionId = crypto.randomUUID(), reviewPending = null, reviewDeleteTarget = null;

function reviewDisplayDate(value) {
  if (!value) return '';
  try {
    if (typeof value === 'number') return date(value > 1e12 ? value / 1000 : value);
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00+09:00' : value);
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium' }).format(parsed);
  } catch { return ''; }
}
function reviewImageUrl(reviewId, imageId) {
  const valid = /^[a-f0-9-]{36}$/i;
  return valid.test(reviewId || '') && valid.test(imageId || '') ? `/admin/api/review-images/${encodeURIComponent(reviewId)}/${encodeURIComponent(imageId)}` : '';
}
function reviewSafeSourceUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
function discardReviewImages() {
  for (const image of reviewImages) if (image.preview?.startsWith('blob:')) URL.revokeObjectURL(image.preview);
  reviewImages = [];
}
function clearReviewView() {
  reviewsVersion++; reviewRows.clear(); reviewEditing = null; reviewPending = null; reviewDeleteTarget = null;
  discardReviewImages(); $('reviews-list').replaceChildren(); $('review-admin-previews').replaceChildren();
  $('review-editor').hidden = true; $('review-admin-form').reset(); $('review-admin-retry-box').hidden = true;
  if ($('review-delete-dialog').open) $('review-delete-dialog').close();
}
function setReviewDisabled() {
  const blocked = reviewSaving || reviewImageProcessing || Boolean(reviewPending);
  $('review-admin-fields').disabled = blocked;
  for (const id of ['review-new', 'review-editor-close', 'review-editor-cancel']) $(id).disabled = blocked;
  $('review-admin-save').textContent = reviewImageProcessing ? '画像を準備しています…' : reviewSaving ? '保存しています…' : reviewEditing ? '変更を保存する →' : 'レビューを保存する →';
  $('review-admin-retry-box').hidden = !reviewPending || reviewPending.kind !== 'editor';
  $('review-admin-retry').disabled = reviewSaving;
  $('reviews-refresh').disabled = reviewSaving;
  $('review-delete-confirm').disabled = reviewSaving;
  $('review-delete-close').disabled = reviewSaving || Boolean(reviewPending?.kind === 'delete');
  $('review-delete-cancel').disabled = reviewSaving || Boolean(reviewPending?.kind === 'delete');
  for (const button of document.querySelectorAll('[data-review-action]')) button.disabled = reviewSaving || Boolean(reviewPending);
}
function updateReviewSourceFields() {
  const imported = ['monitor', 'quoted'].includes($('review-admin-source-type').value);
  $('review-admin-source-name').required = imported;
  $('review-source-required').textContent = imported ? '必須' : '任意';
}
function renderReviewPreviews() {
  $('review-admin-previews').replaceChildren();
  reviewImages.forEach((image, index) => {
    const figure = element('figure', '', 'review-image-preview'), img = document.createElement('img');
    img.src = image.preview; img.alt = `添付画像 ${index + 1}`;
    const remove = element('button', '×', 'review-image-remove'); remove.type = 'button'; remove.setAttribute('aria-label', `画像${index + 1}を削除`);
    remove.disabled = reviewSaving || reviewImageProcessing || Boolean(reviewPending);
    remove.addEventListener('click', () => {
      if (reviewSaving || reviewImageProcessing || reviewPending) return;
      if (image.preview.startsWith('blob:')) URL.revokeObjectURL(image.preview);
      reviewImages.splice(index, 1); renderReviewPreviews();
    });
    figure.append(img, remove, element('figcaption', image.id ? '掲載済みの画像' : '追加する画像')); $('review-admin-previews').append(figure);
  });
}
function openReviewEditor(row = null) {
  if (busy || reviewSaving || reviewImageProcessing || reviewPending) return;
  reviewEditing = row ? { ...row } : null; discardReviewImages(); reviewSubmissionId = crypto.randomUUID();
  $('review-admin-form').reset();
  $('review-admin-name').value = row?.name || ''; $('review-admin-rating').value = row?.rating ? String(row.rating) : '';
  $('review-admin-comment').value = row?.comment || ''; $('review-admin-source-type').value = row?.sourceType || '';
  $('review-admin-source-name').value = row?.sourceName || ''; $('review-admin-source-url').value = row?.sourceUrl || '';
  $('review-admin-date').value = row?.reviewedAt || ''; $('review-admin-date').max = day(Date.now() / 1000);
  $('review-admin-status').value = row?.status || 'published'; $('review-admin-permission').checked = false;
  $('review-admin-comment-count').textContent = format($('review-admin-comment').value.length);
  $('review-editor-title').textContent = row ? 'レビューを編集' : 'レビューを追加';
  for (const image of row?.images || []) { const preview = reviewImageUrl(row.id, image.id); if (preview) reviewImages.push({ id: image.id, preview }); }
  updateReviewSourceFields(); renderReviewPreviews(); message('review-admin-error', ''); message('review-admin-image-message', '');
  $('review-admin-retry-box').hidden = true; $('review-editor').hidden = false; setReviewDisabled();
  $('review-editor').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  $('review-admin-name').focus({ preventScroll: true });
}
function closeReviewEditor() {
  if (reviewSaving || reviewImageProcessing || reviewPending) return;
  $('review-editor').hidden = true; reviewEditing = null; discardReviewImages(); renderReviewPreviews(); $('review-admin-form').reset();
}
async function refreshReviews(append = false) {
  const version = ++reviewsVersion, requestedPage = append ? reviewPage + 1 : 1;
  const result = await api(`reviews?status=${encodeURIComponent(reviewFilter)}&page=${requestedPage}`);
  if (version !== reviewsVersion || !loggedIn) return;
  if (!append) { reviewRows.clear(); $('reviews-list').replaceChildren(); }
  for (const status of ['pending', 'published', 'hidden']) {
    const count = result.counts?.[status]; $('review-count-' + status).textContent = Number.isFinite(count) ? format(count) : '—';
  }
  const total = Number(result.summary?.count || 0), average = Number(result.summary?.average || 0);
  $('review-public-summary').textContent = total ? `LPに公開中：${format(total)}件 · 平均 ${average.toFixed(1)} / 5（モニター・引用を含む）` : '公開されたレビューが平均評価に反映されます。';
  if (!result.items?.length && !append) $('reviews-list').append(element('p', reviewFilter === 'pending' ? '承認待ちのレビューはありません。' : 'この状態のレビューはまだありません。', 'empty'));
  for (const row of result.items || []) {
    if (reviewRows.has(row.id)) continue;
    reviewRows.set(row.id, row); $('reviews-list').append(renderAdminReview(row));
  }
  reviewPage = requestedPage; reviewsHaveMore = Boolean(result.hasMore); $('reviews-more').hidden = !reviewsHaveMore; setReviewDisabled();
}
function renderAdminReview(row) {
  const card = element('article', '', 'review-admin-card'), top = element('div', '', 'review-admin-card__top'), identity = element('div', '', 'review-admin-card__identity');
  identity.append(element('h3', row.name), element('span', reviewStateLabels[row.status] || row.status, 'review-publish-state ' + row.status));
  top.append(identity, element('span', reviewDisplayDate(row.createdAt), 'small'));
  const rating = Math.min(5, Math.max(1, Number(row.rating) || 1)), stars = element('p', '★'.repeat(rating) + '☆'.repeat(5 - rating), 'review-admin-card__stars'); stars.setAttribute('aria-label', `5点中${rating}点`);
  const source = element('p', [reviewSourceLabels[row.sourceType] || '利用者の感想', row.adminPosted ? '管理者掲載' : 'LPから投稿', row.sourceName, row.reviewedAt ? '元の投稿日 ' + reviewDisplayDate(row.reviewedAt) : ''].filter(Boolean).join(' · '), 'review-admin-card__source');
  const sourceUrl = reviewSafeSourceUrl(row.sourceUrl); if (sourceUrl) { source.append(document.createTextNode(' · ')); const link = element('a', '掲載元を見る ↗'); link.href = sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; source.append(link); }
  card.append(top, stars, source, element('p', row.comment, 'review-admin-card__comment'));
  if (row.images?.length) {
    const images = element('div', '', 'review-admin-card__images');
    for (const [index, image] of row.images.entries()) {
      const src = reviewImageUrl(row.id, image.id); if (!src) continue;
      const link = element('a', ''); link.href = src; link.target = '_blank'; link.rel = 'noopener noreferrer';
      const img = document.createElement('img'); img.src = src; img.alt = `${row.name}さんの添付画像 ${index + 1}`; img.loading = 'lazy'; link.append(img); images.append(link);
    }
    card.append(images);
  }
  const footer = element('div', '', 'review-admin-card__footer'), actions = element('div', '', 'review-admin-actions');
  footer.append(element('p', `参考になりました ${format(row.helpfulCount || 0)}件`, 'small'));
  function action(text, handler, className = 'secondary') { const button = element('button', text, className); button.type = 'button'; button.dataset.reviewAction = row.id; button.addEventListener('click', handler); actions.append(button); }
  action('編集', () => openReviewEditor(reviewRows.get(row.id) || row));
  if (row.status !== 'published') action('公開する', () => changeReviewStatus(row, 'published'), 'primary');
  if (row.status !== 'hidden') action('非公開にする', () => changeReviewStatus(row, 'hidden'));
  action('削除', () => openReviewDelete(row), 'review-delete-link'); footer.append(actions); card.append(footer); return card;
}
function adminReviewPayload() {
  const payload = {
    submissionId: reviewSubmissionId, operationId: crypto.randomUUID(), name: $('review-admin-name').value.trim(),
    rating: Number($('review-admin-rating').value), comment: $('review-admin-comment').value.trim(),
    sourceType: $('review-admin-source-type').value, sourceName: $('review-admin-source-name').value.trim(),
    sourceUrl: $('review-admin-source-url').value.trim(), reviewedAt: $('review-admin-date').value,
    status: $('review-admin-status').value, permissionConfirmed: $('review-admin-permission').checked,
    images: reviewImages.filter(image => !image.id).map(({ mime, data }) => ({ mime, data })),
  };
  if (reviewEditing) { payload.keepImageIds = reviewImages.filter(image => image.id).map(image => image.id); if (Number.isInteger(reviewEditing.version)) payload.version = reviewEditing.version; }
  return payload;
}
async function submitAdminReview(operation) {
  if (reviewSaving || reviewImageProcessing || !loggedIn) return;
  reviewSaving = true; reviewPending = operation; setReviewDisabled(); message('review-admin-error', ''); message('reviews-message', '');
  if (operation.kind === 'delete') { message('review-delete-message', ''); $('review-delete-confirm').textContent = '削除しています…'; }
  let completed = false;
  try {
    await api(operation.path, operation.payload); completed = true; reviewPending = null;
    message('reviews-message', operation.kind === 'delete' ? 'レビューと添付画像を削除しました。' : operation.kind === 'status' ? '掲載状態を変更しました。' : reviewEditing ? 'レビューの変更を保存しました。' : 'レビューを登録しました。続けて別のレビューを追加できます。', 'success');
  } catch (error) {
    if (error.code === 'authentication_required') { reviewPending = null; return; }
    if (!error.uncertain) reviewPending = null;
    const suffix = error.uncertain ? '\n通信が途切れています。同じ登録番号で結果を確認してください。' : '';
    if (operation.kind === 'delete') { message('review-delete-message', error.message + suffix); $('review-delete-confirm').textContent = error.uncertain ? '削除結果を確認する' : '削除する'; }
    else if (operation.kind === 'editor') message('review-admin-error', error.message + suffix);
    else {
      message('reviews-message', error.message + suffix);
      if (error.uncertain) {
        const retry = element('button', '変更結果を確認する', 'secondary'); retry.type = 'button'; retry.addEventListener('click', () => submitAdminReview(operation)); $('reviews-message').append(document.createElement('br'), retry);
      }
    }
  } finally { reviewSaving = false; setReviewDisabled(); }
  if (completed && loggedIn) {
    if (operation.kind === 'editor') closeReviewEditor();
    if (operation.kind === 'delete') { $('review-delete-dialog').close(); reviewDeleteTarget = null; if (reviewEditing?.id === operation.id) closeReviewEditor(); }
    try { await refreshReviews(); } catch { message('reviews-message', '保存済みです。一覧を取得できなかったため「一覧を更新」を押してください。', 'success'); }
  }
}
function changeReviewStatus(row, status) {
  if (busy || reviewSaving || reviewPending) return;
  const payload = { operationId: crypto.randomUUID(), status }; if (Number.isInteger(row.version)) payload.version = row.version;
  submitAdminReview({ kind: 'status', path: 'reviews/' + encodeURIComponent(row.id), payload });
}
function openReviewDelete(row) {
  if (busy || reviewSaving || reviewPending) return;
  reviewDeleteTarget = row; $('review-delete-summary').textContent = `${row.name}さん · ${row.rating}点\n${row.comment.slice(0, 120)}${row.comment.length > 120 ? '…' : ''}`;
  message('review-delete-message', ''); $('review-delete-confirm').textContent = '削除する'; $('review-delete-dialog').showModal(); setReviewDisabled();
}
function closeReviewDelete() { if (!reviewSaving && reviewPending?.kind !== 'delete') { $('review-delete-dialog').close(); reviewDeleteTarget = null; } }
async function compressAdminReviewImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('JPEG・PNG・WebPの画像を選んでください。');
  if (file.size > 10 * 1024 * 1024) throw new Error('元の画像は1枚10MBまでです。小さくしてから選んでください。');
  let bitmap, temporaryUrl;
  try {
    if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(file);
    else {
      temporaryUrl = URL.createObjectURL(file); bitmap = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = temporaryUrl; });
    }
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80_000_000) throw new Error('画像の解像度が大きすぎます。小さくしてから選んでください。');
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); if (!context) throw new Error('画像を処理できません。このブラウザーで別の画像をお試しください。');
    let edge = Math.min(1600, Math.max(bitmap.width, bitmap.height)), blob;
    for (let sizeAttempt = 0; sizeAttempt < 4; sizeAttempt++) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height)); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.74, 0.62, 0.5]) {
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= 300 * 1024) break;
      }
      if (blob && blob.size <= 300 * 1024) break; edge = Math.floor(edge * 0.75);
    }
    if (!blob || blob.size > 300 * 1024) throw new Error('画像を小さくできませんでした。別の画像を選んでください。');
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
    return { mime: 'image/jpeg', data, preview: URL.createObjectURL(blob) };
  } catch (error) { throw new Error(error instanceof Error && error.message ? error.message : '画像を読み込めませんでした。別の画像を選んでください。'); }
  finally { bitmap?.close?.(); if (temporaryUrl) URL.revokeObjectURL(temporaryUrl); }
}
async function addAdminReviewImages(files) {
  if (reviewSaving || reviewPending || reviewImageProcessing || !loggedIn) return;
  const selected = Array.from(files || []); if (!selected.length) return;
  if (reviewImages.length + selected.length > 3) { message('review-admin-image-message', '画像は合計3枚までです。不要な画像を外してから追加してください。'); return; }
  reviewImageProcessing = true; setReviewDisabled(); message('review-admin-image-message', '画像を準備しています…', 'success');
  try {
    for (const file of selected) { const image = await compressAdminReviewImage(file); if (!loggedIn) { URL.revokeObjectURL(image.preview); break; } reviewImages.push(image); }
    if (loggedIn) message('review-admin-image-message', `${reviewImages.length}枚の画像を添付します。`, 'success');
  } catch (error) { if (loggedIn) message('review-admin-image-message', error.message); }
  finally { reviewImageProcessing = false; $('review-admin-images').value = ''; renderReviewPreviews(); setReviewDisabled(); }
}
$('review-new').addEventListener('click', () => openReviewEditor());
$('review-editor-close').addEventListener('click', closeReviewEditor); $('review-editor-cancel').addEventListener('click', closeReviewEditor);
$('review-admin-source-type').addEventListener('change', updateReviewSourceFields);
$('review-admin-comment').addEventListener('input', () => { $('review-admin-comment-count').textContent = format($('review-admin-comment').value.length); });
$('review-admin-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || reviewSaving || reviewImageProcessing || reviewPending || !$('review-admin-form').reportValidity()) return;
  const payload = adminReviewPayload();
  if (!payload.name || !payload.comment) { message('review-admin-error', '表示名とコメントを入力してください。'); return; }
  submitAdminReview({ kind: 'editor', path: reviewEditing ? 'reviews/' + encodeURIComponent(reviewEditing.id) : 'reviews', payload });
});
$('review-admin-retry').addEventListener('click', () => { if (reviewPending?.kind === 'editor') submitAdminReview(reviewPending); });
$('review-admin-images').addEventListener('change', event => addAdminReviewImages(event.target.files));
$('review-admin-form').addEventListener('paste', event => {
  const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); addAdminReviewImages(files); }
});
for (const eventName of ['dragover', 'dragenter']) $('review-admin-drop').addEventListener(eventName, event => { event.preventDefault(); if (!reviewSaving && !reviewPending) $('review-admin-drop').classList.add('is-dragging'); });
for (const eventName of ['dragleave', 'drop']) $('review-admin-drop').addEventListener(eventName, event => { event.preventDefault(); $('review-admin-drop').classList.remove('is-dragging'); if (eventName === 'drop') addAdminReviewImages(event.dataTransfer?.files); });
for (const button of document.querySelectorAll('[data-review-filter]')) button.addEventListener('click', async () => {
  if (reviewSaving || reviewPending) return; reviewFilter = button.dataset.reviewFilter;
  for (const other of document.querySelectorAll('[data-review-filter]')) other.setAttribute('aria-pressed', String(other === button));
  try { await refreshReviews(); } catch (error) { message('reviews-message', error.message); }
});
$('reviews-refresh').addEventListener('click', async () => { if (reviewSaving || reviewPending) return; message('reviews-message', ''); try { await refreshReviews(); } catch (error) { message('reviews-message', error.message); } });
$('reviews-more').addEventListener('click', async () => { if (reviewSaving || !reviewsHaveMore) return; $('reviews-more').disabled = true; try { await refreshReviews(true); } catch (error) { message('reviews-message', error.message); } finally { $('reviews-more').disabled = false; } });
$('review-delete-close').addEventListener('click', closeReviewDelete); $('review-delete-cancel').addEventListener('click', closeReviewDelete);
$('review-delete-dialog').addEventListener('cancel', event => { event.preventDefault(); closeReviewDelete(); });
$('review-delete-confirm').addEventListener('click', () => {
  if (reviewSaving || !reviewDeleteTarget) return;
  if (reviewPending?.kind === 'delete') { submitAdminReview(reviewPending); return; }
  const payload = { operationId: crypto.randomUUID(), confirmed: true }; if (Number.isInteger(reviewDeleteTarget.version)) payload.version = reviewDeleteTarget.version;
  submitAdminReview({ kind: 'delete', id: reviewDeleteTarget.id, path: 'reviews/' + encodeURIComponent(reviewDeleteTarget.id) + '/delete', payload });
});
// Reviewer coupons have their own retry record; they never change stock here.
Object.assign(messages, {
  reviewer_coupon_invalid: 'コード・アンケート名・利用上限を確認してください。',
  invalid_coupon_code: 'Reviewerに続けて、半角英数字2〜50文字を入力してください。',
  invalid_questionnaire: '同梱するアンケート名を80文字以内で入力してください。改行や制御文字は使えません。',
  invalid_max_redemptions: '利用上限は1〜10,000の整数で入力してください。',
  reviewer_coupon_conflict: 'このコードまたは登録番号はすでに使われています。停止済みのコードも再利用できません。別のコードを入力してください。',
  reviewer_coupon_not_found: 'クーポンが見つかりません。一覧を更新してください。',
  reviewer_coupon_not_ready: 'クーポンの設定を確認できません。時間をおいてお試しください。',
});
const couponRows = new Map();
let couponsVersion = 0, couponsNext = null, couponSaving = false, couponPending = null, couponUncertain = false, couponStopTarget = null;
try {
  const saved = JSON.parse(sessionStorage.getItem('bmc-reviewer-coupon-pending') || 'null');
  const operation = saved?.payload?.operationId;
  const validOperation = typeof operation === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operation);
  const validCreate = saved?.kind === 'create' && saved.path === 'reviewer-coupons';
  const validStop = saved?.kind === 'stop' && typeof saved.id === 'string' && /^promo_[a-z0-9]{1,200}$/i.test(saved.id) && saved.path === 'reviewer-coupons/' + encodeURIComponent(saved.id) && saved.payload.active === false;
  if (validOperation && (validCreate || validStop)) { couponPending = saved; couponUncertain = true; }
} catch {}
function rememberCoupon() {
  try { if (couponPending) sessionStorage.setItem('bmc-reviewer-coupon-pending', JSON.stringify(couponPending)); else sessionStorage.removeItem('bmc-reviewer-coupon-pending'); } catch {}
}
function clearCouponView() {
  couponsVersion++; couponsNext = null; couponRows.clear(); $('coupons-list').replaceChildren();
  $('coupon-form').reset(); couponStopTarget = null;
  if ($('coupon-stop-dialog').open) $('coupon-stop-dialog').close();
}
function setCouponDisabled() {
  const blocked = couponSaving || Boolean(couponPending);
  $('coupon-fields').disabled = blocked;
  $('coupon-create-button').textContent = couponSaving && couponPending?.kind === 'create' ? '発行しています…' : 'クーポンを発行する';
  $('coupons-refresh').disabled = blocked; $('coupons-more').disabled = blocked;
  $('coupon-retry-box').hidden = !(couponUncertain && couponPending?.kind === 'create'); $('coupon-retry').disabled = couponSaving;
  const uncertainStop = couponUncertain && couponPending?.kind === 'stop';
  $('coupon-stop-confirm').disabled = couponSaving;
  $('coupon-stop-confirm').textContent = couponSaving ? '確認しています…' : uncertainStop ? '停止結果を確認する' : '停止する';
  $('coupon-stop-close').disabled = couponSaving || uncertainStop; $('coupon-stop-cancel').disabled = couponSaving || uncertainStop;
  for (const button of document.querySelectorAll('[data-coupon-action]')) button.disabled = blocked;
}
function showCouponPending() {
  if (!couponPending || !loggedIn || activeTab !== 'coupons') return;
  if (couponPending.kind === 'create') {
    $('coupon-code').value = couponPending.payload.code || '';
    $('coupon-questionnaire').value = couponPending.payload.questionnaire || '';
    $('coupon-max-redemptions').value = couponPending.payload.maxRedemptions || '';
    if (couponUncertain) message('coupons-message', '前回の発行結果を確認できていません。「発行結果を確認する」を押してください。');
  } else if (couponUncertain) {
    couponStopTarget = { id: couponPending.id, code: couponPending.code, questionnaire: couponPending.questionnaire };
    $('coupon-stop-summary').textContent = [couponPending.code, couponPending.questionnaire ? `同梱：${couponPending.questionnaire}` : ''].filter(Boolean).join('\n');
    message('coupon-stop-message', '前回の停止結果を確認できていません。同じ登録番号で確認します。');
    if (!$('coupon-stop-dialog').open) $('coupon-stop-dialog').showModal();
  }
  setCouponDisabled();
}
function couponAvailability(coupon) {
  if (Number(coupon.maxRedemptions) > 0 && Number(coupon.timesRedeemed) >= Number(coupon.maxRedemptions)) return { label: '上限に到達', className: 'exhausted' };
  const expires = coupon.expiresAt;
  const expiry = typeof expires === 'number' ? expires * (expires < 1e12 ? 1000 : 1) : expires ? Date.parse(expires) : NaN;
  if (Number.isFinite(expiry) && expiry <= Date.now()) return { label: '期限切れ', className: 'exhausted' };
  if (!coupon.active) return { label: '停止中', className: 'stopped' };
  return { label: '利用可', className: '' };
}
function renderCouponCard(coupon) {
  const card = element('article', '', 'coupon-card'), top = element('div', '', 'coupon-card__top');
  const state = couponAvailability(coupon);
  top.append(element('code', coupon.code, 'coupon-card__code'), element('span', state.label, 'coupon-state ' + state.className));
  const used = Math.max(0, Number(coupon.timesRedeemed) || 0), maximum = Math.max(0, Number(coupon.maxRedemptions) || 0);
  card.append(top, element('p', `「${coupon.questionnaire}」を同梱`, 'coupon-card__questionnaire'), element('p', `利用 ${format(used)} / ${format(maximum)}回`, 'coupon-card__usage'));
  const footer = element('div', '', 'coupon-card__footer'), actions = element('div', '', 'coupon-card__actions');
  footer.append(element('p', 'お試し3袋・無料', 'small'));
  const copy = element('button', 'コードをコピー', 'secondary'); copy.type = 'button'; copy.dataset.couponAction = coupon.id;
  copy.addEventListener('click', async () => {
    if (couponSaving || couponPending) return;
    try { await navigator.clipboard.writeText(coupon.code); message('coupons-message', `${coupon.code}をコピーしました。`, 'success'); }
    catch { message('coupons-message', 'コピーできませんでした。表示されているコードを選択してコピーしてください。'); }
  });
  actions.append(copy);
  if (coupon.active) {
    const stop = element('button', '停止する', 'secondary'); stop.type = 'button'; stop.dataset.couponAction = coupon.id;
    stop.addEventListener('click', () => openCouponStop(couponRows.get(coupon.id) || coupon)); actions.append(stop);
  }
  footer.append(actions); card.append(footer); return card;
}
async function refreshCoupons(append = false) {
  showCouponPending();
  const version = ++couponsVersion;
  const result = await api('reviewer-coupons' + (append && couponsNext ? '?after=' + encodeURIComponent(couponsNext) : ''));
  if (version !== couponsVersion || !loggedIn) return;
  if (!Array.isArray(result.items) || (result.next != null && typeof result.next !== 'string')) throw new Error('クーポン一覧を確認できませんでした。もう一度更新してください。');
  const list = $('coupons-list'); if (!append) { couponRows.clear(); list.replaceChildren(); }
  if (!result.items.length && !append) list.append(element('p', result.next ? 'このページには表示するクーポンがありません。「次のクーポンを表示」で続きを確認できます。' : '発行済みのクーポンはまだありません。', 'empty'));
  for (const coupon of result.items) {
    if (!coupon || typeof coupon.id !== 'string' || typeof coupon.code !== 'string' || couponRows.has(coupon.id)) continue;
    if (!couponRows.size) list.replaceChildren();
    couponRows.set(coupon.id, coupon); list.append(renderCouponCard(coupon));
  }
  if (!couponRows.size && !result.next) list.replaceChildren(element('p', '発行済みのクーポンはまだありません。', 'empty'));
  couponsNext = result.next || null; $('coupons-more').hidden = !couponsNext; setCouponDisabled(); showCouponPending();
}
function openCouponStop(coupon) {
  if (busy || couponSaving || couponPending || !loggedIn || !coupon.active) return;
  couponStopTarget = coupon;
  $('coupon-stop-summary').textContent = [coupon.code, `同梱：${coupon.questionnaire}`, `利用 ${format(coupon.timesRedeemed)} / ${format(coupon.maxRedemptions)}回`].join('\n');
  message('coupon-stop-message', ''); setCouponDisabled(); $('coupon-stop-dialog').showModal();
}
function closeCouponStop() {
  if (couponSaving || (couponUncertain && couponPending?.kind === 'stop')) return;
  $('coupon-stop-dialog').close(); couponStopTarget = null;
}
async function saveCoupon(operation) {
  if (busy || couponSaving || !loggedIn) return;
  couponPending = operation; rememberCoupon(); couponSaving = true; couponsVersion++; setCouponDisabled();
  message('coupons-message', ''); if (operation.kind === 'stop') message('coupon-stop-message', '');
  let completed = false;
  try {
    const result = await api(operation.path, operation.payload);
    if (operation.kind === 'create' && (!result.coupon || typeof result.coupon.id !== 'string' || typeof result.coupon.code !== 'string' || result.coupon.code.toLowerCase() !== operation.payload.code.toLowerCase())) throw Object.assign(new Error('発行結果を読み取れませんでした。同じ登録番号で確認してください。'), { uncertain: true });
    couponPending = null; couponUncertain = false; rememberCoupon(); completed = true;
    message('coupons-message', operation.kind === 'create' ? `${result.coupon.code}を発行しました。同梱：${result.coupon.questionnaire}。` : `${operation.code}を停止しました。`, 'success');
    if (operation.kind === 'create') $('coupon-form').reset();
    else { $('coupon-stop-dialog').close(); couponStopTarget = null; }
  } catch (error) {
    if (error.code === 'authentication_required') { couponUncertain = true; rememberCoupon(); return; }
    couponUncertain = Boolean(error.uncertain);
    if (!couponUncertain) { couponPending = null; rememberCoupon(); }
    const suffix = couponUncertain ? '\n同じ登録番号で結果を確認するので、二重には処理しません。' : '';
    message(operation.kind === 'stop' ? 'coupon-stop-message' : 'coupons-message', error.message + suffix);
  } finally { couponSaving = false; setCouponDisabled(); }
  if (completed && loggedIn) {
    try { await refreshCoupons(); }
    catch { message('coupons-message', `${operation.kind === 'create' ? operation.payload.code + 'は発行済み' : operation.code + 'は停止済み'}です。一覧を更新できなかったため「一覧を更新」を押してください。`, 'success'); }
  }
}
$('coupon-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || couponSaving || couponPending || !$('coupon-form').reportValidity()) return;
  const code = $('coupon-code').value.trim(), questionnaire = $('coupon-questionnaire').value.trim(), maximum = Number($('coupon-max-redemptions').value);
  if (!/^Reviewer[a-z0-9]{2,50}$/i.test(code)) { message('coupons-message', messages.invalid_coupon_code); return; }
  if (!questionnaire || questionnaire.length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(questionnaire)) { message('coupons-message', messages.invalid_questionnaire); return; }
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10000) { message('coupons-message', messages.invalid_max_redemptions); return; }
  saveCoupon({ kind: 'create', path: 'reviewer-coupons', payload: { operationId: crypto.randomUUID(), code, questionnaire, maxRedemptions: maximum } });
});
$('coupon-retry').addEventListener('click', () => { if (couponPending?.kind === 'create') saveCoupon(couponPending); });
$('coupons-refresh').addEventListener('click', async () => { if (couponSaving || couponPending) return; $('coupons-refresh').disabled = true; message('coupons-message', ''); try { await refreshCoupons(); } catch (error) { message('coupons-message', error.message); } finally { setCouponDisabled(); } });
$('coupons-more').addEventListener('click', async () => { if (couponSaving || couponPending || !couponsNext) return; $('coupons-more').disabled = true; try { await refreshCoupons(true); } catch (error) { message('coupons-message', error.message); } finally { setCouponDisabled(); } });
$('coupon-stop-close').addEventListener('click', closeCouponStop); $('coupon-stop-cancel').addEventListener('click', closeCouponStop);
$('coupon-stop-dialog').addEventListener('cancel', event => { event.preventDefault(); closeCouponStop(); });
$('coupon-stop-confirm').addEventListener('click', () => {
  if (couponSaving || !couponStopTarget) return;
  if (couponPending?.kind === 'stop') { saveCoupon(couponPending); return; }
  const coupon = couponStopTarget;
  saveCoupon({ kind: 'stop', id: coupon.id, code: coupon.code, questionnaire: coupon.questionnaire,
    path: 'reviewer-coupons/' + encodeURIComponent(coupon.id), payload: { operationId: crypto.randomUUID(), active: false } });
});
setCouponDisabled();
switchTab(activeTab);
refresh(true);
