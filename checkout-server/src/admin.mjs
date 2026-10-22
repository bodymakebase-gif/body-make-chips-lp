import { CheckoutError } from './catalog.mjs';
import { cookieToken, sessionCookie } from './admin-auth.mjs';
import html from './admin/index.html';
import css from './admin/admin.css';
import js from './admin/admin.js';

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
export const adminJson = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
export function adminAsset(path, mode) {
  const asset = { '/admin': [html, 'text/html'], '/admin/': [html, 'text/html'],
    '/admin/admin.css': [css, 'text/css'], '/admin/admin.js': [js, 'text/javascript'] }[path];
  return asset ? new Response(asset[0].replace('__ENVIRONMENT__', mode === 'live' ? 'live' : 'test'), { headers: { ...headers, 'Content-Type': asset[1] + '; charset=utf-8' } }) : null;
}

// Admin APIs are same-origin only; no LP CORS policy or sales toggle applies here.
export function validateAdminRequest(request, mode) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !(mode === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new CheckoutError('https_required', 403);
  const origin = request.headers.get('origin');
  if ((origin && origin !== url.origin) || (request.headers.get('sec-fetch-site') === 'cross-site')) throw new CheckoutError('origin_not_allowed', 403);
  if (request.method === 'POST' && (origin !== url.origin || request.headers.get('x-bmc-admin') !== '1')) throw new CheckoutError('origin_not_allowed', 403);
  if (!['GET', 'POST'].includes(request.method)) throw new CheckoutError('method_not_allowed', 405);
}

export async function adminApi(request, store, auth, keyHash, readJson, now = Math.floor(Date.now() / 1000)) {
  const url = new URL(request.url);
  const token = cookieToken(request);
  if (url.pathname === '/admin/api/login' && request.method === 'POST') {
    const input = await readJson(request);
    const session = await auth.login(input.key, keyHash, request.headers.get('cf-connecting-ip'), now);
    return adminJson({ ok: true }, 200, { 'Set-Cookie': sessionCookie(session) });
  }
  if (url.pathname === '/admin/api/logout' && request.method === 'POST') {
    await auth.logout(token);
    return adminJson({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }
  const actor = await auth.authenticate(token, keyHash, now);
  if (url.pathname === '/admin/api/summary' && request.method === 'GET') {
    return adminJson({ ...store.summary(), actor: actor.actor, updatedAt: now });
  }
  if (url.pathname === '/admin/api/history' && request.method === 'GET') {
    const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1) throw new CheckoutError('invalid_cursor');
    const rows = store.history(before, 26), more = rows.length > 25;
    return adminJson({ items: rows.slice(0, 25), next: more ? rows[24].seq : null });
  }
  if (url.pathname === '/admin/api/adjust' && request.method === 'POST') {
    const result = store.adjust(await readJson(request), actor.actor, now);
    return adminJson({ ...result, summary: store.summary(), updatedAt: now });
  }
  return adminJson({ error: 'not_found' }, 404);
}
