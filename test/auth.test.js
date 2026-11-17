// Comptes, sessions, verrouillage, contrôle d'origine, droits d'applications, invités.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.js';

let s, admin;
before(async () => {
  s = await startServer();
  admin = s.client();
});
after(() => s.close());

test('premier compte = admin, puis inscription fermée par défaut', async () => {
  assert.deepEqual((await s.client().get('/api/auth/config')).data, { setup: true, signupOpen: false, guestEnabled: false, sso: { dashy: false } });
  const r = await admin.post('/api/auth/register', { username: 'admin', password: 'motdepasse1' });
  assert.equal(r.status, 201);
  assert.equal((await admin.get('/api/me')).data.user.role, 'admin');
  const other = s.client();
  other.ip = '198.51.100.1';
  assert.equal((await other.post('/api/auth/register', { username: 'bob', password: 'motdepasse1' })).status, 403);
});

test('inscription ouverte par l\'admin : rôle utilisateur', async () => {
  await admin.patch('/api/admin/settings', { signup_open: true });
  const u = s.client(); u.ip = '198.51.100.2';
  assert.equal((await u.post('/api/auth/register', { username: 'carole', password: 'motdepasse1' })).status, 201);
  assert.equal((await u.get('/api/me')).data.user.role, 'user');
  assert.equal((await u.get('/api/admin/users')).status, 404, 'un utilisateur ne voit pas l\'administration');
  await admin.patch('/api/admin/settings', { signup_open: false });
});

test('jetons de session : seule leur empreinte SHA-256 est en base', async () => {
  const token = admin.cookie.split('=')[1];
  const rows = s.db.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(rows.length > 0);
  assert.ok(!rows.some((r) => r.token_hash === token));
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  s.db.pragma('wal_checkpoint(FULL)');
  const dump = ['craft.db', 'craft.db-wal'].map((f) => { try { return readFileSync(join(s.root, 'data', f)).toString('latin1'); } catch { return ''; } }).join('');
  assert.ok(dump.includes(rows[0].token_hash), 'contrôle : les empreintes sont bien lisibles dans le fichier');
  assert.ok(!dump.includes(token), 'le jeton brut ne doit pas apparaître dans le fichier de base');
});

test('contrôle d\'origine sur toute écriture', async () => {
  const noOrigin = await admin.req('POST', '/api/folders', { json: { name: 'x' }, origin: false });
  assert.equal(noOrigin.status, 403);
  const cross = await admin.req('POST', '/api/folders', { json: { name: 'x' }, origin: false, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const site = await admin.req('POST', '/api/folders', { json: { name: 'x' }, origin: false, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(site.status, 403);
  assert.equal((await admin.post('/api/folders', { name: 'x' })).status, 201);
});

test('échec de connexion : message identique, journal fail2ban, verrouillage après 10 échecs', async () => {
  const u = s.client();
  u.ip = '203.0.113.9';
  const unknown = await u.post('/api/auth/login', { username: 'personne', password: 'mauvais-mot' });
  const wrong = await u.post('/api/auth/login', { username: 'carole', password: 'mauvais-mot' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.data.error, wrong.data.error);
  const logText = readFileSync(join(s.root, 'data', 'logs', 'auth.log'), 'utf8');
  assert.match(logText, /^\S+ craft-host AUTH_FAIL ip=203\.0\.113\.9 user="carole" reason=password$/m);
  // 10 échecs depuis des IP différentes (la limite par IP est de 8 par minute) → compte verrouillé.
  for (let i = 0; i < 9; i++) { u.ip = `203.0.113.${20 + i}`; await u.post('/api/auth/login', { username: 'carole', password: 'mauvais-mot' }); }
  u.ip = '203.0.113.50';
  const locked = await u.post('/api/auth/login', { username: 'carole', password: 'motdepasse1' });
  assert.equal(locked.status, 423);
  // L'admin déverrouille
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'carole'").get().id;
  await admin.patch(`/api/admin/users/${id}`, { unlock: true });
  assert.equal((await u.post('/api/auth/login', { username: 'carole', password: 'motdepasse1' })).status, 200);
});

test('limite de 8 tentatives par minute et par IP (IP vue via trust proxy)', async () => {
  const u = s.client();
  u.ip = '192.0.2.77';
  const codes = [];
  for (let i = 0; i < 9; i++) codes.push((await u.post('/api/auth/login', { username: 'x', password: 'y' })).status);
  assert.deepEqual(codes.slice(0, 8), Array(8).fill(401));
  assert.equal(codes[8], 429);
});

test('compte créé par l\'admin : mot de passe provisoire à changer, applications choisies', async () => {
  const r = await admin.post('/api/admin/users', { username: 'marie', password: 'provisoire1', allApps: false, apps: ['other'] });
  assert.equal(r.status, 201);
  const m = s.client(); m.ip = '198.51.100.30';
  const login = await m.post('/api/auth/login', { username: 'marie', password: 'provisoire1' });
  assert.equal(login.data.mustChange, true);
  assert.equal((await m.get('/api/fs')).status, 403);
  assert.equal((await m.get('/apps/other/')).status, 404, 'aucune application avant le changement');
  assert.equal((await m.get('/')).status, 302);
  assert.equal((await m.post('/api/auth/password', { current: 'provisoire1', password: 'provisoire1' })).status, 400);
  assert.equal((await m.post('/api/auth/password', { current: 'provisoire1', password: 'nouveau-mdp' })).status, 200);
  assert.equal((await m.get('/api/fs')).status, 200);
  assert.deepEqual((await m.get('/api/me')).data.apps.map((a) => a.slug), ['other']);
  assert.equal((await m.get('/apps/other/')).status, 200);
  assert.equal((await m.get('/apps/demo/')).status, 404, 'application non attribuée');
});

test('changement de mot de passe : les autres sessions sont fermées', async () => {
  const a = s.client(); a.ip = '198.51.100.40';
  const b = s.client(); b.ip = '198.51.100.41';
  await a.post('/api/auth/login', { username: 'marie', password: 'nouveau-mdp' });
  await b.post('/api/auth/login', { username: 'marie', password: 'nouveau-mdp' });
  assert.equal((await a.post('/api/auth/password', { current: 'nouveau-mdp', password: 'encore-un-mdp' })).status, 200);
  assert.equal((await a.get('/api/fs')).status, 200);
  assert.equal((await b.get('/api/fs')).status, 401);
});

test('compte désactivé : session fermée immédiatement', async () => {
  const m = s.client(); m.ip = '198.51.100.50';
  await m.post('/api/auth/login', { username: 'marie', password: 'encore-un-mdp' });
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'marie'").get().id;
  await admin.patch(`/api/admin/users/${id}`, { disabled: true });
  assert.equal((await m.get('/api/fs')).status, 401);
  assert.equal((await m.post('/api/auth/login', { username: 'marie', password: 'encore-un-mdp' })).status, 401);
});

test('il reste toujours un administrateur', async () => {
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  assert.equal((await admin.patch(`/api/admin/users/${id}`, { role: 'user' })).status, 400);
  assert.equal((await admin.del(`/api/admin/users/${id}`)).status, 400);
});

test('mode invité : désactivé par défaut, puis sans stockage et limité aux applications choisies', async () => {
  const g = s.client(); g.ip = '198.51.100.60';
  assert.equal((await g.post('/api/auth/guest')).status, 403);
  await admin.patch('/api/admin/settings', { guest_enabled: true, guest_apps: ['demo'] });
  assert.equal((await g.post('/api/auth/guest')).status, 200);
  const me = await g.get('/api/me');
  assert.equal(me.data.guest, true);
  assert.deepEqual(me.data.apps.map((a) => a.slug), ['demo']);
  assert.equal((await g.get('/api/fs')).status, 401, 'pas de stockage pour un invité');
  assert.equal((await g.upload('a.pdf', Buffer.from('%PDF-'))).status, 401);
  assert.equal((await g.get('/apps/demo/')).status, 200);
  assert.equal((await g.get('/apps/other/')).status, 404);
  assert.equal((await g.get('/admin.html')).status, 302);
});

test('déconnexion : la session est supprimée', async () => {
  const u = s.client(); u.ip = '198.51.100.70';
  await u.post('/api/auth/login', { username: 'carole', password: 'motdepasse1' });
  const before = s.db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  const saved = u.cookie;
  await u.post('/api/auth/logout');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, before - 1);
  u.cookie = saved;
  assert.equal((await u.get('/api/fs')).status, 401, 'l\'ancien cookie ne marche plus');
});
