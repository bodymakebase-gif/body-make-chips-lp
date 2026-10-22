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
};
let summary = null, nextCursor = null, busy = false, loggedIn = false, pending = null, uncertain = false, refreshVersion = 0;
try { pending = JSON.parse(sessionStorage.getItem('bmc-stock-pending') || 'null'); if (pending) uncertain = true; } catch {}
const remember = () => { try { if (pending) sessionStorage.setItem('bmc-stock-pending', JSON.stringify(pending)); else sessionStorage.removeItem('bmc-stock-pending'); } catch {} };
function message(id, text, type = 'error') { $(id).textContent = text; $(id).className = 'message ' + type; }
function requireLogin() {
  loggedIn = false; summary = null; refreshVersion++;
  $('dashboard').hidden = true; $('logout').hidden = true; $('login-panel').hidden = false;
  if ($('confirm-dialog').open) $('confirm-dialog').close();
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
async function history(append = false) {
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
    if (withHistory) await history();
    if (pending && !$('confirm-dialog').open) showConfirm();
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
    try { await history(); } catch { message('status', '在庫の変更は登録済みです。履歴を取得できなかったため「最新の在庫に更新」を押してください。', 'success'); }
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
$('load-more').addEventListener('click', async () => { $('load-more').disabled = true; try { await history(true); } catch (error) { message('status', error.message); } finally { $('load-more').disabled = false; } });
if (document.body.dataset.environment === 'test') { $('environment').textContent = 'テスト環境'; $('environment').classList.add('test'); }
else $('environment').textContent = '本番';
setInterval(() => { if (loggedIn && !busy && !pending && !document.hidden) refresh(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && loggedIn && !busy && !pending) refresh(); });
refresh(true);
