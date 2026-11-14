// Réglages des applications par compte : clés déclarées seulement, isolation, limites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s, a, b;
before(async () => {
  s = await startServer();
  a = s.client(); b = s.client();
  await a.post('/api/auth/register', { username: 'alice', password: 'motdepasse1' });
  await a.patch('/api/admin/settings', { signup_open: true });
  b.ip = '198.51.100.8';
  await b.post('/api/auth/register', { username: 'bruno', password: 'motdepasse1' });
});
after(() => s.close());

test('/api/me expose les clés de réglages de chaque application', async () => {
  const apps = (await a.get('/api/me')).data.apps;
  assert.deepEqual(apps.find((x) => x.slug === 'demo').prefKeys, ['demo.ui', 'shared']);
});

test('enregistrer, relire, effacer ; chaque compte a ses propres valeurs', async () => {
  assert.equal((await a.req('PUT', '/api/prefs', { json: { values: { 'demo.ui': '{"theme":"dark"}', shared: 'A' } } })).status, 200);
  assert.equal((await b.req('PUT', '/api/prefs', { json: { values: { shared: 'B' } } })).status, 200);
  assert.deepEqual((await a.get('/api/prefs?keys=demo.ui,shared,inconnue')).data.values, { 'demo.ui': '{"theme":"dark"}', shared: 'A' });
  assert.deepEqual((await b.get('/api/prefs?keys=demo.ui,shared')).data.values, { 'demo.ui': null, shared: 'B' });
  assert.equal((await a.req('PUT', '/api/prefs', { json: { values: { 'demo.ui': null } } })).status, 200);
  assert.equal((await a.get('/api/prefs?keys=demo.ui')).data.values['demo.ui'], null);
});

test('clé non déclarée, ou d\'une application non attribuée : refusée', async () => {
  assert.equal((await a.req('PUT', '/api/prefs', { json: { values: { 'auth.token': 'x' } } })).status, 404);
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'bruno'").get().id;
  await a.patch(`/api/admin/users/${id}`, { allApps: false, apps: ['demo'] });
  assert.equal((await b.req('PUT', '/api/prefs', { json: { values: { 'other.ui': 'x' } } })).status, 404);
  assert.deepEqual((await b.get('/api/prefs?keys=other.ui,demo.ui')).data.values, { 'demo.ui': null });
});

test('limites : valeur trop grosse, format invalide, origine, invité', async () => {
  assert.equal((await a.req('PUT', '/api/prefs', { json: { values: { shared: 'x'.repeat(600 * 1024) } } })).status, 413);
  assert.equal((await a.req('PUT', '/api/prefs', { json: { values: { shared: 42 } } })).status, 413);
  assert.equal((await a.req('PUT', '/api/prefs', { json: { values: [] } })).status, 400);
  assert.equal((await a.req('PUT', '/api/prefs', { json: { values: { shared: 'x' } }, origin: false })).status, 403);
  await a.patch('/api/admin/settings', { guest_enabled: true });
  const g = s.client(); g.ip = '198.51.100.99';
  await g.post('/api/auth/guest');
  assert.equal((await g.get('/api/prefs?keys=shared')).status, 401);
});
