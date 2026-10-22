import { cleanLocation, ecommerceItem } from './tracking/analytics-core.mjs';
// Only allowlisted event data is sent. No checkout session tokens, names, addresses or emails.
let settings, active = false;
const CHOICE_KEY = 'bmc-analytics-choice';
const INTERNAL_KEY = 'bmc-analytics-internal';
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const pageType = /(?:^\/$|\/index\.html$)/.test(location.pathname) ? 'lp' :
  location.pathname.endsWith('/order-complete.html') ? 'order_confirmation' : 'other';
const query = new URLSearchParams(location.search);
if (query.get('analytics_internal') === '1') write(INTERNAL_KEY, '1');
if (query.get('analytics_internal') === '0') write(INTERNAL_KEY, '0');

const pageLocation = cleanLocation(location.href);
let pageReferrer = '';
try { pageReferrer = document.referrer ? new URL(document.referrer).origin + '/' : ''; } catch {}

function emit(name, params = {}) {
  if (!active || read(CHOICE_KEY) === 'denied' || read(INTERNAL_KEY) === '1' || navigator.globalPrivacyControl === true) return;
  window.gtag('event', name, { page_location: pageLocation, page_referrer: pageReferrer,
    page_type: pageType, ...params });
}
function observeContent() {
  const lineup = document.querySelector('#lineup');
  if (lineup && typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      emit('view_item_list', { item_list_id: 'lp_sets', item_list_name: 'セット一覧', items: settings.sets.map(ecommerceItem) });
      observer.disconnect();
    }, { threshold: 0.15 });
    observer.observe(lineup);
  }
  const milestones = new Set();
  let scheduled = false;
  function measure() {
    scheduled = false;
    const scrollable = document.documentElement.scrollHeight - innerHeight;
    if (scrollable <= 0) return;
    const percent = Math.floor(scrollY / scrollable * 100);
    for (const point of [25, 50, 75, 90]) if (percent >= point && !milestones.has(point)) {
      milestones.add(point); emit('scroll_depth', { percent_scrolled: point });
    }
  }
  addEventListener('scroll', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(measure); } }, { passive: true });
  measure();
}

export const analyticsReady = (async () => {
  try {
    settings = await fetch('./analytics-settings.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(); return r.json(); });
    if (!/^G-[A-Z0-9]+$/.test(settings.measurementId || '') || !settings.hosts.includes(location.hostname) ||
        read(INTERNAL_KEY) === '1' || read(CHOICE_KEY) === 'denied' || navigator.globalPrivacyControl === true) return false;
    if (read(CHOICE_KEY) !== 'granted') {
      const policy = await fetch(`${settings.apiOrigin}/measurement-policy`, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(2500) }).then(r => r.json());
      if (!policy.defaultAllowed) return false;
    }
    if (pageType === 'other') return false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    window.gtag('js', new Date());
    window.gtag('config', settings.measurementId, { send_page_view: false,
      allow_google_signals: false, allow_ad_personalization_signals: false,
      ignore_referrer: pageType === 'order_confirmation',
      page_location: pageLocation, page_referrer: pageReferrer,
      ...(settings.debug ? { debug_mode: true } : {}) });
    const script = document.createElement('script');
    script.async = true; script.src = `https://www.googletagmanager.com/gtag/js?id=${settings.measurementId}`;
    const loaded = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 4000);
      script.onload = () => { clearTimeout(timeout); resolve(true); };
      script.onerror = () => { clearTimeout(timeout); resolve(false); };
      document.head.append(script);
    });
    if (!loaded) return false;
    active = true;
    emit('page_view', { page_title: document.title });
    if (pageType === 'lp') { emit('lp_view'); observeContent(); }
    return true;
  } catch { return false; }
})();

export async function trackSetSelection(set) {
  if (await analyticsReady) emit('select_item', { item_list_id: 'lp_sets', item_list_name: 'セット一覧', items: [ecommerceItem(set)] });
}
export async function getAnalyticsContext() {
  if (read(CHOICE_KEY) === 'denied' || read(INTERNAL_KEY) === '1' || navigator.globalPrivacyControl === true) return null;
  // Analytics never blocks the customer's purchase for more than this small bounded wait.
  return Promise.race([(async () => {
    if (!(await analyticsReady)) return null;
    const get = field => new Promise(resolve => window.gtag('get', settings.measurementId, field, resolve));
    const [clientId, sessionId] = await Promise.all([get('client_id'), get('session_id')]);
    if (!/^\d{1,20}\.\d{1,20}$/.test(clientId || '') || !/^\d{1,15}$/.test(String(sessionId || ''))) return null;
    return { clientId, sessionId: Number(sessionId), consent: 'granted' };
  })(), new Promise(resolve => setTimeout(() => resolve(null), 900))]);
}
export async function trackCheckoutStart(set, requestId) {
  if (!active) return;
  const key = `bmc-ga-checkout-${requestId}`;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch {}
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 500);
    emit('begin_checkout', { currency: 'JPY', value: set.price, items: [ecommerceItem(set)],
      event_callback() { clearTimeout(timeout); resolve(); }, event_timeout: 450 });
  });
}

// Privacy controls are explicit and available without loading Google Analytics on this page.
function refreshControls() {
  const status = document.querySelector('[data-analytics-choice-status]');
  if (status) status.textContent = read(CHOICE_KEY) === 'denied' ? 'このブラウザーではアクセス解析を停止しています。' :
    read(CHOICE_KEY) === 'granted' ? 'このブラウザーではアクセス解析を許可しています。' : '標準設定です。同意が必要な地域では、許可するまで計測しません。';
}
for (const button of document.querySelectorAll('[data-analytics-choice]')) button.addEventListener('click', () => {
  const choice = button.dataset.analyticsChoice;
  if (!['granted', 'denied'].includes(choice)) return;
  write(CHOICE_KEY, choice);
  if (choice === 'denied') {
    active = false;
    window.gtag?.('consent', 'update', { analytics_storage: 'denied' });
    for (const cookie of document.cookie.split(';')) {
      const name = cookie.split('=')[0].trim();
      if (!/^_ga(?:_|$)/.test(name)) continue;
      for (const domain of ['', `;domain=${location.hostname}`, `;domain=.${location.hostname}`]) {
        document.cookie = `${name}=;max-age=0;path=/${domain};SameSite=Lax;Secure`;
      }
    }
  }
  refreshControls();
});
refreshControls();
