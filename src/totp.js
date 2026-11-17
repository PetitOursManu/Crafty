// TOTP (RFC 6238 : HMAC-SHA1, 6 chiffres, pas de 30 s), compatible avec les applications d'authentification courantes.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32 invalide');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20)); // 160 bits, longueur recommandée par la RFC 4226
export const STEP = 30;
export const stepOf = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

export function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// Code valide dans la fenêtre ±window pas et postérieur au dernier pas accepté (pas de réutilisation) : renvoie le pas, sinon null.
export function verifyCode(secret, code, { lastStep = 0, window = 1, now = Date.now() } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepOf(now);
  for (let s = cur - window; s <= cur + window; s++) {
    if (s <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

export const otpauthUri = ({ secret, account, issuer = 'Crafty' }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
