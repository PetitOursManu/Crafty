// Double authentification (TOTP + codes de secours) : mise en place, connexion en deux étapes, protections, admin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { codeAt, stepOf, verifyCode, base32Decode, base32Encode } from '../src/totp.js';

let s, a, secret, recovery;
let ipN = 0;
const freshIp = () => `203.0.113.${++ipN}`;
before(async () => {
  s = await startServer({ twoFactorOptions: { secret: 'secret-de-test' } });
  a = s.client();
  assert.equal((await a.post('/api/auth/register', { username: 'alice', password: 'motdepasse1' })).status, 201);
});
after(() => s.close());

async function login(c, password = 'motdepasse1') {
  c.ip = freshIp();
  return c.post('/api/auth/login', { username: 'alice', password });
}

test('TOTP : vecteur de la RFC 6238 (SHA-1) et base32', () => {
  // RFC 6238, annexe B : clé ASCII « 12345678901234567890 », T = 59 s → 94287082 (8 chiffres) ; sur 6 chiffres : 287082.
  const key = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(key).toString(), '12345678901234567890');
  assert.equal(codeAt(key, 1), '287082');
  assert.equal(codeAt(key, Math.floor(1111111109 / 30)), '081804');
  assert.equal(verifyCode(key, '287082', { now: 59_000 }), 1);
  assert.equal(verifyCode(key, '287082', { now: 59_000, lastStep: 1 }), null, 'code déjà utilisé');
  assert.equal(verifyCode(key, '12345', { now: 59_000 }), null);
});

test('mise en place : mot de passe exigé, QR code, premier code juste, 10 codes de secours ; secret chiffré en base', async () => {
  assert.deepEqual((await a.get('/api/me/2fa')).data, { enabled: false, recoveryLeft: 0, available: true, encrypted: true });
  assert.equal((await a.post('/api/me/2fa/setup', { password: 'faux-mot-de-passe' })).status, 400);
  const r = await a.post('/api/me/2fa/setup', { password: 'motdepasse1' });
  assert.equal(r.status, 200);
  secret = r.data.secret;
  assert.match(r.data.uri, /^otpauth:\/\/totp\/Crafty:alice\?secret=[A-Z2-7]+&issuer=Crafty/);
  const qr = await a.get('/api/me/2fa/qr.svg');
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(qr.buf.toString(), /^<svg/);
  assert.equal(qr.headers.get('cache-control'), 'no-store');
  assert.equal((await a.post('/api/me/2fa/enable', { code: '000000' })).status, 400);
  const ok = await a.post('/api/me/2fa/enable', { code: codeAt(secret, stepOf()) });
  assert.equal(ok.status, 200);
  recovery = ok.data.recoveryCodes;
  assert.equal(recovery.length, 10);
  assert.match(recovery[0], /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  const row = s.db.prepare("SELECT totp_secret, totp_pending FROM users WHERE username = 'alice'").get();
  assert.match(row.totp_secret, /^v1:/);
  assert.ok(!row.totp_secret.includes(secret));
  assert.equal(row.totp_pending, null);
  assert.equal((await a.get('/api/me')).data.user.twoFactor, true);
});

test('connexion en deux étapes : pas de session avant le code, code faux refusé, code juste accepté une seule fois', async () => {
  const c = s.client();
  const r = await login(c);
  assert.equal(r.data.twoFactor, true);
  assert.ok(r.data.ticket);
  assert.equal((await c.get('/api/me')).status, 401, 'aucune session après le mot de passe seul');
  const bad = await c.post('/api/auth/2fa', { ticket: r.data.ticket, code: '000000' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, 'Code incorrect.');
  // Le code de l'étape suivante est valide (fenêtre ±1) et plus récent que celui de l'activation.
  const code = codeAt(secret, stepOf() + 1);
  const ok = await c.post('/api/auth/2fa', { ticket: r.data.ticket, code });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/me')).data.user.username, 'alice');
  // Même code, nouvelle connexion : refusé (pas de réutilisation).
  const c2 = s.client();
  const r2 = await login(c2);
  assert.equal((await c2.post('/api/auth/2fa', { ticket: r2.data.ticket, code })).status, 401);
  // Ticket inconnu ou réutilisé.
  assert.equal((await c2.post('/api/auth/2fa', { ticket: r.data.ticket, code })).data.expired, true);
});

test('codes de secours : un seul usage ; journal fail2ban pour les codes faux', async () => {
  const c = s.client();
  const r = await login(c);
  const ok = await c.post('/api/auth/2fa', { ticket: r.data.ticket, code: recovery[0].toUpperCase() });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.recoveryLeft, 9);
  const c2 = s.client();
  const r2 = await login(c2);
  assert.equal((await c2.post('/api/auth/2fa', { ticket: r2.data.ticket, code: recovery[0] })).status, 401);
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const logText = readFileSync(join(s.root, 'data', 'logs', 'auth.log'), 'utf8');
  assert.match(logText, /craft-host AUTH_FAIL ip=203\.0\.113\.\d+ user="alice" reason=totp/);
  assert.match(logText, /craft-host AUTH_PASSWORD_OK ip=/);
});

test('5 codes faux : ticket perdu ; un bon mot de passe ne remet pas le compteur à zéro → verrouillage à 10', async () => {
  s.db.prepare("UPDATE users SET failed_count = 0, locked_until = 0 WHERE username = 'alice'").run();
  const c = s.client();
  let r = await login(c);
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/auth/2fa', { ticket: r.data.ticket, code: '111111' })).data.expired, undefined);
  assert.equal((await c.post('/api/auth/2fa', { ticket: r.data.ticket, code: '111111' })).data.expired, true);
  r = await login(c); // bon mot de passe : 5 échecs restent comptés
  for (let i = 0; i < 4; i++) { c.ip = freshIp(); await c.post('/api/auth/2fa', { ticket: r.data.ticket, code: '111111' }); }
  assert.equal(s.db.prepare("SELECT failed_count n FROM users WHERE username = 'alice'").get().n, 9);
  c.ip = freshIp();
  await c.post('/api/auth/2fa', { ticket: r.data.ticket, code: '111111' });
  assert.equal((await login(c)).status, 423, 'compte verrouillé, même avec le bon mot de passe');
  s.db.prepare("UPDATE users SET failed_count = 0, locked_until = 0 WHERE username = 'alice'").run();
});

test('désactivation (mot de passe + code), puis remise à zéro par un administrateur', async () => {
  assert.equal((await a.post('/api/me/2fa/disable', { password: 'motdepasse1', code: '000000' })).status, 400);
  assert.equal((await a.post('/api/me/2fa/disable', { password: 'motdepasse1', code: recovery[1] })).status, 200);
  assert.equal((await a.get('/api/me/2fa')).data.enabled, false);
  const c = s.client();
  assert.equal((await login(c)).data.ok, true, 'connexion directe sans code');
  // Réactivée puis retirée par l'administrateur (alice est admin : premier compte).
  const setup = await a.post('/api/me/2fa/setup', { password: 'motdepasse1' });
  await a.post('/api/me/2fa/enable', { code: codeAt(setup.data.secret, stepOf()) });
  const id = (await a.get('/api/me')).data.user.id;
  const u = (await a.patch(`/api/admin/users/${id}`, { reset2fa: true })).data;
  assert.equal(u.twoFactor, false);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recovery_codes WHERE user_id = ?').get(id).n, 0);
});
