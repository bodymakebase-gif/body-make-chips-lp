// Public reviews stay on the LP. Names, comments and images never enter analytics.
const section = document.querySelector('#reviews');
if (section) await startReviews();

async function startReviews() {
  const $ = id => document.getElementById(id);
  const list = $('reviews-list');
  const listStatus = $('reviews-status');
  const summaryNode = $('reviews-summary');
  const sort = $('reviews-sort');
  const more = $('reviews-more');
  const form = $('review-form');
  const fields = $('review-form-fields');
  const panel = $('reviews-form-panel');
  const submit = $('review-submit');
  const submitStatus = $('review-submit-status');
  const fileInput = $('review-images');
  const drop = $('review-image-drop');
  const imageStatus = $('review-image-status');
  const previews = $('review-image-previews');
  let config;
  try {
    const embedded = document.querySelector('#sale-config, #site-config');
    const value = embedded ? JSON.parse(embedded.textContent) : null;
    config = value?.checkout || value?.reviews || value;
    if (!config?.apiOrigin) config = await fetch('./checkout-settings.json', { cache: 'no-store' }).then(r => r.json());
    const origin = new URL(config.apiOrigin);
    if ((origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) || origin.username || origin.password) throw new Error('invalid_config');
    config.apiOrigin = origin.origin;
    if (!config.turnstileSiteKey) throw new Error('invalid_config');
  } catch {
    showListStatus('ただいまレビューをご利用いただけません。時間をおいて、このページを読み直してください。');
    sort.disabled = true; submit.disabled = true;
    submitStatus.textContent = 'ただいま投稿を受け付けられません。時間をおいてお試しください。';
    return;
  }

  const uuid = () => crypto.randomUUID();
  let visitorId;
  try { visitorId = localStorage.getItem('bmc_review_visitor'); } catch {}
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitorId || '')) {
    visitorId = uuid();
    try { localStorage.setItem('bmc_review_visitor', visitorId); } catch {}
  }
  let submissionId = uuid(), submitting = false, processingImages = false, voting = false;
  let page = 0, generation = 0, loading = false, sortValue = 'helpful';
  let attachments = [], uncertainPayload = null;
  const voteButtons = new Set();
  const renderedIds = new Set();
  const commentLayouts = new Map();
  const commentObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    for (const { target } of entries) commentLayouts.get(target)?.();
  }) : null;
  const widgetIds = new WeakMap();
  const MAX_ORIGINAL = 10 * 1024 * 1024, MAX_IMAGE = 300 * 1024;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function integer(value) { return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0; }
  function showListStatus(message, retry) {
    listStatus.replaceChildren(element('p', '', message));
    listStatus.hidden = false;
    if (retry) {
      const button = element('button', 'reviews-button', 'もう一度読み込む');
      button.type = 'button'; button.addEventListener('click', retry, { once: true });
      listStatus.append(button);
    }
  }
  function messageFor(error) {
    if (error?.name === 'AbortError' || error?.code === 'timeout') return '接続に時間がかかっています。通信環境を確認して、もう一度お試しください。';
    if (error?.httpStatus === 429 || ['rate_limited', 'review_rate_limited', 'too_many_requests'].includes(error?.code)) return '短い時間に操作が集中しています。少し時間をおいて、もう一度お試しください。';
    const messages = {
      verification_failed: '接続確認の有効期限が切れました。もう一度お試しください。',
      verification_unavailable: '接続を確認できませんでした。少し時間をおいて、もう一度お試しください。',
      verification_timeout: '接続確認に時間がかかっています。表示された確認欄を操作するか、もう一度お試しください。',
      invalid_review: '入力内容をご確認ください。お名前・評価・5文字以上の感想・公開への同意が必要です。',
      invalid_input: '入力内容をご確認ください。お名前・評価・感想・公開への同意が必要です。',
      invalid_image: '読み取れない写真があります。写真を削除して、JPEG・PNG・WebPの画像を選び直してください。',
      invalid_review_images: '読み取れない写真があります。写真を削除して、JPEG・PNG・WebPの画像を選び直してください。',
      invalid_review_rating: '評価を1〜5点から選んでください。',
      review_consent_required: '公開される内容をご確認のうえ、公開への同意にチェックを入れてください。',
      image_too_large: '写真の容量が大きすぎます。写真を削除して、別の画像を選び直してください。',
      too_many_images: '写真は3枚まで追加できます。',
      review_not_found: 'このレビューは現在表示できません。一覧を読み直してください。',
      not_found: 'このレビューは現在表示できません。一覧を読み直してください。',
      submission_conflict: '送信内容を確認できませんでした。時間をおいて、同じ内容でもう一度お試しください。',
      request_conflict: '同じ投稿の内容に変更があるため、送信を確定できませんでした。時間をおいてお試しください。',
      reviews_unavailable: 'ただいまレビューをご利用いただけません。少し時間をおいて、もう一度お試しください。',
    };
    return messages[error?.code] || '通信できませんでした。インターネット接続を確認して、もう一度お試しください。';
  }
  async function api(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`${config.apiOrigin}${path}`, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'omit' });
      let data;
      try { data = await response.json(); } catch { throw Object.assign(new Error('invalid_response'), { httpStatus: response.status }); }
      if (!response.ok) throw Object.assign(new Error('reviews_api_error'), { code: data?.error, httpStatus: response.status });
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_response');
      return data;
    } finally { clearTimeout(timer); }
  }

  function stars(value) {
    const rating = Math.max(0, Math.min(5, Number(value) || 0));
    const node = element('span', 'review-stars');
    node.setAttribute('role', 'img'); node.setAttribute('aria-label', `5点満点中${rating.toFixed(1)}点`);
    const empty = element('span', '', '★★★★★'); empty.setAttribute('aria-hidden', 'true');
    const fill = element('span', 'review-stars__fill', '★★★★★'); fill.setAttribute('aria-hidden', 'true'); fill.style.width = `${rating / 5 * 100}%`;
    node.append(empty, fill); return node;
  }
  function renderSummary(summary) {
    const count = integer(summary?.count);
    const average = count ? Math.max(0, Math.min(5, Number(summary?.average) || 0)) : 0;
    const scoreGroup = element('div', 'reviews-summary__rating');
    const score = element('div', 'reviews-summary__score');
    score.append(element('strong', '', count ? average.toFixed(1) : '—'), element('span', '', '/ 5'));
    scoreGroup.append(score, stars(average), element('p', 'reviews-summary__count', count ? `${count.toLocaleString('ja-JP')}件の公開レビュー` : '最初のレビューをお待ちしています'));
    const bars = element('div', 'reviews-summary__bars');
    for (let rating = 5; rating >= 1; rating--) {
      const value = integer(summary?.distribution?.[String(rating)]);
      const row = element('div', 'reviews-summary__bar');
      row.setAttribute('aria-label', `${rating}点：${value}件`);
      const track = element('span', 'reviews-summary__track'); track.setAttribute('aria-hidden', 'true');
      const fill = element('i'); fill.style.width = `${count ? Math.min(100, value / count * 100) : 0}%`; track.append(fill);
      row.append(element('span', '', `${rating} ★`), track, element('span', '', `${value}件`)); bars.append(row);
    }
    summaryNode.replaceChildren(scoreGroup, bars); summaryNode.hidden = false;
    $('reviews-count').textContent = `みなさまのレビュー（${count.toLocaleString('ja-JP')}件）`;
  }
  function imageUrl(value, reviewId) {
    try {
      const url = new URL(value, config.apiOrigin);
      if (url.origin !== config.apiOrigin || url.username || url.password || url.search || url.hash) return null;
      if (!/^\/review-images\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)) return null;
      if (url.pathname.split('/')[2] !== String(reviewId)) return null;
      return url.href;
    } catch { return null; }
  }
  function dateOf(value) {
    const parsed = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  function reviewBody(item) {
    const body = element('div', 'review-card__body');
    const comment = element('p', 'review-card__comment is-collapsed', String(item.comment || ''));
    comment.id = `review-comment-${item.id}`;
    const toggle = element('button', 'review-card__read-more', '続きを読む');
    toggle.type = 'button'; toggle.hidden = true;
    toggle.setAttribute('aria-controls', comment.id);
    let expanded = false;
    const update = () => {
      if (!comment.isConnected || !comment.clientWidth) return;
      // Measure rendered lines so the same review also folds correctly on mobile.
      const lineHeight = parseFloat(getComputedStyle(comment).lineHeight);
      const overflows = comment.scrollHeight > lineHeight * 3 + 1;
      toggle.hidden = !overflows;
      comment.classList.toggle('is-collapsed', overflows && !expanded);
      toggle.setAttribute('aria-expanded', String(overflows && expanded));
      toggle.textContent = expanded ? '閉じる' : '続きを読む';
    };
    toggle.addEventListener('click', () => { expanded = !expanded; update(); });
    body.append(comment, toggle);
    commentLayouts.set(comment, update); commentObserver?.observe(comment);
    return body;
  }
  const updateComments = () => { for (const update of commentLayouts.values()) update(); };
  window.addEventListener('resize', () => requestAnimationFrame(updateComments));
  document.fonts?.ready.then(updateComments);
  const lightbox = element('dialog', 'review-lightbox');
  lightbox.setAttribute('aria-label', 'レビューの写真');
  const lightboxClose = element('button', 'review-lightbox__close', '閉じる ×'); lightboxClose.type = 'button';
  const lightboxImage = element('img'); lightboxImage.alt = 'レビューに添えられた写真';
  lightbox.append(lightboxClose, lightboxImage); document.body.append(lightbox);
  lightboxClose.addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('click', event => { if (event.target === lightbox) lightbox.close(); });
  lightbox.addEventListener('close', () => lightboxImage.removeAttribute('src'));

  function renderReview(item) {
    if (!item || !/^[A-Za-z0-9_-]+$/.test(String(item.id || ''))) return null;
    const article = element('article', 'review-card'); article.dataset.reviewId = item.id;
    article.setAttribute('aria-label', `${String(item.name || '匿名')}さんのレビュー`);
    const head = element('div', 'review-card__head');
    const identity = element('div', 'review-card__identity');
    identity.append(element('span', 'review-card__name', `${String(item.name || '匿名')} さん`), stars(item.rating));
    const date = dateOf(item.reviewedAt || item.createdAt);
    head.append(identity);
    if (date) { const time = element('time', 'review-card__date', date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tokyo' })); time.dateTime = date.toISOString(); head.append(time); }
    article.append(head, reviewBody(item));
    const images = element('div', 'review-card__images');
    for (const [index, photo] of (Array.isArray(item.images) ? item.images.slice(0, 3) : []).entries()) {
      const url = imageUrl(photo?.url, item.id); if (!url) continue;
      const button = element('button', 'review-card__image-button'); button.type = 'button'; button.setAttribute('aria-label', `${String(item.name || '投稿者')}さんの写真${index + 1}を大きく見る`);
      const image = element('img'); image.src = url; image.alt = `${String(item.name || '投稿者')}さんのレビュー写真 ${index + 1}`; image.loading = 'lazy'; image.width = 104; image.height = 104;
      button.append(image); button.addEventListener('click', () => { lightboxImage.src = url; lightbox.showModal(); }); images.append(button);
    }
    if (images.childElementCount) article.append(images);
    const vote = element('button', 'review-card__helpful'); vote.type = 'button'; vote.disabled = voting;
    let voted = Boolean(item.helpfulVoted), count = integer(item.helpfulCount);
    const setVote = () => {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('width', '16'); icon.setAttribute('height', '16');
      icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.7');
      icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', 'M7 10v11H3V10h4Zm0 0 5-7c2 0 2 2 1 6h6a2 2 0 0 1 2 2l-2 8a2 2 0 0 1-2 2H7');
      icon.append(shape);
      vote.replaceChildren(icon, element('span', '', String(count)));
      vote.setAttribute('aria-pressed', String(voted));
      vote.setAttribute('aria-label', `${voted ? '参考票を取り消す' : 'このレビューが参考になった'}（${count}件）`);
    };
    setVote(); voteButtons.add(vote);
    const voteStatus = element('p', 'review-card__vote-status'); voteStatus.setAttribute('role', 'status');
    const verification = element('div', 'review-card__verification');
    vote.addEventListener('click', async () => {
      if (voting) return;
      voting = true; for (const button of voteButtons) button.disabled = true;
      voteStatus.textContent = '接続を確認しています…';
      try {
        const token = await verificationToken('review_helpful', verification);
        const data = await api(`/reviews/${encodeURIComponent(item.id)}/helpful`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId, helpful: !voted, turnstileToken: token }) });
        voted = Boolean(data.helpfulVoted); count = integer(data.helpfulCount); setVote();
        voteStatus.textContent = voted ? '投票しました。もう一度押すと取り消せます。' : '投票を取り消しました。';
      } catch (error) { voteStatus.textContent = messageFor(error); }
      finally { voting = false; clearWidget(verification); for (const button of voteButtons) button.disabled = false; }
    });
    article.append(vote, verification, voteStatus); return article;
  }
  async function loadReviews(nextPage = 1) {
    const current = ++generation;
    loading = true; sort.disabled = true; more.disabled = true; list.setAttribute('aria-busy', 'true');
    if (nextPage === 1) showListStatus('レビューを読み込んでいます。');
    try {
      const params = new URLSearchParams({ sort: sortValue, page: String(nextPage), visitorId });
      const data = await api(`/reviews?${params}`);
      if (current !== generation) return;
      if (!Array.isArray(data.items) || !data.summary || !Number.isInteger(data.page)) throw new Error('invalid_response');
      if (nextPage === 1) { commentObserver?.disconnect(); commentLayouts.clear(); list.replaceChildren(); voteButtons.clear(); renderedIds.clear(); }
      renderSummary(data.summary);
      for (const item of data.items) {
        if (renderedIds.has(item?.id)) continue;
        const article = renderReview(item);
        if (article) { renderedIds.add(item.id); list.append(article); }
      }
      requestAnimationFrame(updateComments);
      page = data.page; more.hidden = !data.hasMore;
      listStatus.hidden = true;
      if (!list.childElementCount) showListStatus('公開されているレビューはまだありません。最初の感想をお待ちしています。');
    } catch (error) {
      if (current !== generation) return;
      showListStatus(`${nextPage > 1 ? '続きのレビューを読み込めませんでした。' : 'レビューを読み込めませんでした。'} ${messageFor(error)}`, () => loadReviews(nextPage));
    } finally {
      if (current === generation) { loading = false; sort.disabled = false; more.disabled = false; list.removeAttribute('aria-busy'); }
    }
  }
  sort.addEventListener('change', () => { sortValue = sort.value === 'newest' ? 'newest' : 'helpful'; more.hidden = true; void loadReviews(1); });
  more.addEventListener('click', () => { if (!loading) void loadReviews(page + 1); });

  function loadTurnstile() {
    if (window.turnstile?.render) return Promise.resolve();
    if (window.__bmcTurnstileReady) return window.__bmcTurnstileReady;
    window.__bmcTurnstileReady = new Promise((resolve, reject) => {
      let script = [...document.scripts].find(node => node.src.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js'));
      const ownScript = !script;
      if (!script) { script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; }
      let settled = false;
      const finish = success => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearInterval(poll);
        script.removeEventListener('load', onLoad); script.removeEventListener('error', onError);
        if (success) resolve();
        else { if (ownScript) script.remove(); window.__bmcTurnstileReady = null; reject(Object.assign(new Error('verification_unavailable'), { code: 'verification_unavailable' })); }
      };
      const onLoad = () => finish(Boolean(window.turnstile?.render));
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), 20000);
      const poll = setInterval(() => { if (window.turnstile?.render) finish(true); }, 100);
      script.addEventListener('load', onLoad); script.addEventListener('error', onError);
      if (ownScript) document.head.append(script);
    });
    return window.__bmcTurnstileReady;
  }
  function clearWidget(container) {
    const id = widgetIds.get(container);
    if (id !== undefined) { try { window.turnstile?.remove(id); } catch {} widgetIds.delete(container); }
    container.replaceChildren();
  }
  async function verificationToken(action, container) {
    await loadTurnstile(); clearWidget(container);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(null, 'verification_timeout'), 60000);
      const finish = (token, code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (token) resolve(token); else reject(Object.assign(new Error(code || 'verification_unavailable'), { code: code || 'verification_unavailable' }));
      };
      try {
        const id = window.turnstile.render(container, { sitekey: config.turnstileSiteKey, action, theme: 'light', size: window.innerWidth < 380 ? 'compact' : 'normal', appearance: 'interaction-only',
          callback: token => { if (typeof token === 'string' && token) finish(token); },
          'error-callback': () => { finish(null, 'verification_unavailable'); return true; },
          'expired-callback': () => finish(null, 'verification_failed'),
          'timeout-callback': () => finish(null, 'verification_timeout'),
          'unsupported-callback': () => finish(null, 'verification_unavailable'),
        });
        widgetIds.set(container, id);
      } catch { finish(null, 'verification_unavailable'); }
    });
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const image = new Image();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); reject(new Error('画像の読み込みに時間がかかりました。別の写真をお試しください。')); }, 15000);
      image.onload = () => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); reject(new Error('写真を読み取れませんでした。JPEG・PNG・WebPの画像を選び直してください。')); };
      image.src = url;
    });
  }
  async function prepareImage(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('写真はJPEG・PNG・WebP形式を選んでください。HEICの場合はJPEGに変換してお試しください。');
    if (!file.size || file.size > MAX_ORIGINAL) throw new Error('元の写真は1枚10MBまでです。容量を小さくしてから選び直してください。');
    const image = await readImage(file);
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 100000000) throw new Error('写真の大きさを読み取れません。小さめの画像を選び直してください。');
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('写真を準備できませんでした。写真なしで投稿するか、別のブラウザーでお試しください。');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob;
    for (let pass = 0; pass < 4; pass++) {
      for (const quality of [.86, .74, .62, .5]) {
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= MAX_IMAGE) break;
      }
      if (blob && blob.size <= MAX_IMAGE) break;
      const smaller = document.createElement('canvas'); smaller.width = Math.max(1, Math.round(canvas.width * .75)); smaller.height = Math.max(1, Math.round(canvas.height * .75));
      const smallContext = smaller.getContext('2d'); if (!smallContext) break;
      smallContext.drawImage(canvas, 0, 0, smaller.width, smaller.height); canvas.width = smaller.width; canvas.height = smaller.height; context.drawImage(smaller, 0, 0);
    }
    if (!blob || blob.size > MAX_IMAGE) throw new Error('この写真の容量を十分に小さくできませんでした。別の写真を選んでください。');
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('写真を準備できませんでした。選び直してください。')); reader.readAsDataURL(blob); });
    return { key: uuid(), mime: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl, name: file.name || '貼り付けた写真' };
  }
  function renderPreviews() {
    previews.replaceChildren();
    for (const photo of attachments) {
      const figure = element('figure', 'review-image-preview');
      const image = element('img'); image.src = photo.preview; image.alt = '投稿する写真のプレビュー';
      const caption = element('figcaption', '', photo.name);
      const remove = element('button', '', 'この写真を削除'); remove.type = 'button'; remove.disabled = submitting || processingImages;
      remove.setAttribute('aria-label', `${photo.name}を削除`);
      remove.addEventListener('click', () => { if (submitting || processingImages) return; attachments = attachments.filter(item => item.key !== photo.key); renderPreviews(); imageStatus.textContent = `写真${attachments.length}枚を追加しています。`; });
      figure.append(image, caption, remove); previews.append(figure);
    }
  }
  async function addImages(files) {
    if (submitting || processingImages || uncertainPayload) return;
    const selected = Array.from(files || []); if (!selected.length) return;
    if (selected.length + attachments.length > 3) { imageStatus.textContent = '写真は3枚までです。追加する写真を減らすか、追加済みの写真を削除してください。'; return; }
    processingImages = true; submit.disabled = true; fileInput.disabled = true;
    imageStatus.textContent = '写真を準備しています…'; renderPreviews();
    const prepared = [], failures = [];
    try {
      for (const file of selected) { try { prepared.push(await prepareImage(file)); } catch (error) { failures.push(error.message); } }
      attachments.push(...prepared);
      imageStatus.textContent = failures.length ? failures.join('\n') : `写真${attachments.length}枚を追加しました。送信前にプレビューをご確認ください。`;
    } finally { processingImages = false; submit.disabled = false; fileInput.disabled = false; fileInput.value = ''; renderPreviews(); }
  }
  fileInput.addEventListener('change', () => void addImages(fileInput.files));
  form.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); void addImages(files); }
  });
  drop.addEventListener('keydown', event => { if (event.target === drop && ['Enter', ' '].includes(event.key)) { event.preventDefault(); fileInput.click(); } });
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, event => { event.preventDefault(); if (!submitting && !processingImages && !uncertainPayload) drop.classList.add('is-dragging'); });
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('is-dragging'); });
  drop.addEventListener('drop', event => void addImages(event.dataTransfer?.files));
  // Avoid a dropped image navigating away from a partly written review.
  section.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
  section.addEventListener('drop', event => { if (event.dataTransfer?.files?.length) event.preventDefault(); });
  const openReviewButton = section.querySelector('[data-review-open]');
  openReviewButton.setAttribute('aria-expanded', String(panel.open));
  panel.addEventListener('toggle', () => {
    openReviewButton.setAttribute('aria-expanded', String(panel.open));
    if (!panel.open) openReviewButton.focus();
  });
  openReviewButton.addEventListener('click', event => {
    event.preventDefault(); panel.open = true; openReviewButton.setAttribute('aria-expanded', 'true'); panel.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    setTimeout(() => form.querySelector('input[name=rating]')?.focus({ preventScroll: true }), 150);
  });
  function showSubmissionResult(result) {
    const messages = {
      published: 'レビューを公開しました。ありがとうございます。',
      pending: 'レビューは受付済みです。現在は確認待ちです。\n公開されるまで、一覧や平均評価には反映されません。',
      received: 'このレビューは受付済みです。現在は公開一覧に表示されていません。',
    };
    submitStatus.textContent = messages[result.status];
    submitStatus.classList.add('is-success'); submitStatus.focus({ preventScroll: true });
    if (result.status === 'published') {
      // A failed list read must never turn a confirmed write into another POST.
      void loadReviews(1).catch(() => showListStatus('レビューは公開済みです。一覧を更新できなかったため、もう一度読み込んでください。', () => loadReviews(1)));
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submitting || processingImages) return;
    let payload = uncertainPayload;
    if (!payload) {
      if (!form.reportValidity()) return;
      const values = new FormData(form);
      const name = String(values.get('name') || '').trim(), comment = String(values.get('comment') || '').trim();
      if (!name || comment.length < 5) { submitStatus.textContent = 'お名前と、5文字以上の感想を入力してください。'; (name ? $('review-comment') : $('review-name')).focus(); return; }
      payload = { submissionId, visitorId, name, rating: Number(values.get('rating')), comment, consent: values.get('consent') === 'on', website: String(values.get('website') || ''), images: attachments.map(({ mime, data }) => ({ mime, data })) };
    }
    submitting = true; fields.disabled = true; submit.disabled = true; submitStatus.classList.remove('is-success');
    submit.textContent = '接続を確認しています…'; submitStatus.textContent = '接続を確認しています。確認欄が表示された場合は操作してください。';
    let sent = false, accepted = false;
    try {
      const token = await verificationToken('review_submit', $('review-verification'));
      submit.textContent = '送信しています…'; submitStatus.textContent = 'レビューを送信しています。このままお待ちください。';
      sent = true;
      const result = await api('/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, turnstileToken: token }) });
      if (result.id !== payload.submissionId || !['published', 'pending', 'received'].includes(result.status)) throw new Error('invalid_response');
      accepted = true;
      uncertainPayload = null; submissionId = uuid(); attachments = []; form.reset(); renderPreviews(); imageStatus.textContent = '';
      showSubmissionResult(result);
    } catch (error) {
      // A lost response may have followed a successful write. Retry the exact
      // payload and submissionId, keeping the entered content visible and intact.
      if (accepted) {
        uncertainPayload = null;
        submitStatus.textContent = 'レビューの送信は完了しました。表示を更新できなかったため、時間をおいて一覧をご確認ください。';
        submitStatus.classList.add('is-success');
      } else {
        if (sent && (!error.httpStatus || error.httpStatus < 400 || error.httpStatus >= 500)) uncertainPayload = payload;
        else if (error.httpStatus >= 400 && error.httpStatus < 500) uncertainPayload = null;
        submitStatus.textContent = `${messageFor(error)}${uncertainPayload ? '\n送信結果を確認できていません。入力内容を保ったまま、同じレビューを再確認できます。' : ''}`;
      }
    } finally {
      submitting = false; fields.disabled = Boolean(uncertainPayload); submit.disabled = false;
      submit.textContent = uncertainPayload ? '同じ内容で送信を再確認する →' : 'レビューを送信する →'; clearWidget($('review-verification'));
    }
  });
  void loadReviews(1);
}
