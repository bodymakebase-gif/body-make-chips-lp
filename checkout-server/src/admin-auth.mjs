import { CheckoutError } from './catalog.mjs';

export const SESSION_SECONDS = 8 * 60 * 60;
export const COOKIE_NAME = '__Host-bmc_inventory';
const encoder = new TextEncoder();
export async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function equal(a, b) { let diff = a.length ^ b.length; for (let i = 0; i < 64; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
export function cookieToken(request) {
  const found = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  const value = found?.slice(COOKIE_NAME.length + 1) || '';
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}
export function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export class AdminAuthStore {
  constructor(storage) {
    this.storage = storage; this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY, key_hash TEXT NOT NULL, actor TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_login_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);`);
  }
  limit(ipHash, now) {
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM admin_login_limits WHERE reset_at<=?', now);
      for (const [bucket, seconds, maximum] of [[ipHash, 900, 8], ['global', 60, 60]]) {
        const row = this.sql.exec('SELECT attempts FROM admin_login_limits WHERE bucket=?', bucket).toArray()[0];
        if (row && row.attempts >= maximum) throw new CheckoutError('too_many_attempts', 429);
        this.sql.exec(`INSERT INTO admin_login_limits(bucket,attempts,reset_at) VALUES(?,1,?)
          ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1`, bucket, now + seconds);
      }
    });
  }
  async login(key, keyHash, ip, now) {
    if (!/^[a-f0-9]{64}$/.test(keyHash || '')) throw new CheckoutError('admin_not_configured', 503);
    const ipHash = await digest(ip || 'unknown');
    this.limit(ipHash, now);
    if (typeof key !== 'string' || key.length > 200 || !equal(await digest(key), keyHash)) throw new CheckoutError('invalid_admin_key', 401);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const tokenHash = await digest(token);
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM admin_login_limits WHERE bucket=?', ipHash);
      this.sql.exec('DELETE FROM admin_sessions WHERE expires<=? OR key_hash<>?', now, keyHash);
      this.sql.exec('INSERT INTO admin_sessions(token_hash,key_hash,actor,expires) VALUES(?,?,?,?)', tokenHash, keyHash, '管理者', now + SESSION_SECONDS);
    });
    return token;
  }
  async authenticate(token, keyHash, now) {
    if (!token || !keyHash) throw new CheckoutError('authentication_required', 401);
    const row = this.sql.exec('SELECT * FROM admin_sessions WHERE token_hash=?', await digest(token)).toArray()[0];
    if (!row || row.expires <= now || row.key_hash !== keyHash) throw new CheckoutError('authentication_required', 401);
    return row;
  }
  async logout(token) { if (token) this.sql.exec('DELETE FROM admin_sessions WHERE token_hash=?', await digest(token)); }
}
