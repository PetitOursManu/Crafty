// Données des applications par compte : un instantané par compte et par application, isolé, compté dans le quota.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s, a, b;
const snap = (txt) => ({ body: Buffer.from(txt), headers: { 'content-type': 'application/octet-stream' } });
before(async () => {
  s = await startServer();
  a = s.client(); b = s.client();
  await a.post('/api/auth/register', { username: 'alice', password: 'motdepasse1' });
  await a.patch('/api/admin/settings', { signup_open: true });
  b.ip = '198.51.100.9';
  await b.post('/api/auth/register', { username: 'bruno', password: 'motdepasse1' });
});
after(() => s.close());

test('/api/me expose les données déclarées ; application sans données : 404', async () => {
  const apps = (await a.get('/api/me')).data.apps;
  assert.deepEqual(apps.find((x) => x.slug === 'demo').data, { local: ['demo.data'], opfs: ['demo/'] });
  assert.equal(apps.find((x) => x.slug === 'other').data, null);
  assert.equal((await a.get('/api/appdata/other')).status, 404);
  assert.equal((await a.req('PUT', '/api/appdata/other', snap('x'))).status, 404);
  assert.equal((await a.get('/api/appdata/inconnue')).status, 404);
});

test('enregistrer, relire, remplacer ; chaque compte a ses propres données', async () => {
  assert.equal((await a.get('/api/appdata/demo')).status, 204);
  const r = await a.req('PUT', '/api/appdata/demo', snap('instantané A'));
  assert.equal(r.status, 200);
  assert.equal(r.data.size, 'instantané A'.length + 1); // « é » sur deux octets
  assert.equal((await b.req('PUT', '/api/appdata/demo', snap('instantané B'))).status, 200);
  const ga = await a.get('/api/appdata/demo');
  assert.equal(ga.status, 200);
  assert.equal(ga.buf.toString(), 'instantané A');
  assert.equal(ga.headers.get('etag'), `"${r.data.sha256}"`);
  assert.equal((await b.get('/api/appdata/demo')).buf.toString(), 'instantané B');
  await a.req('PUT', '/api/appdata/demo', snap('A, version 2'));
  assert.equal((await a.get('/api/appdata/demo')).buf.toString(), 'A, version 2');
});

test('compté dans le quota ; refusé quand le quota est plein', async () => {
  const before = (await a.get('/api/usage')).data.used;
  await a.req('PUT', '/api/appdata/demo', snap('x'.repeat(1000)));
  assert.equal((await a.get('/api/usage')).data.used, before - 'A, version 2'.length + 1000);
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
  await a.patch(`/api/admin/users/${id}`, { quota: 1500 });
  assert.equal((await a.req('PUT', '/api/appdata/demo', snap('y'.repeat(1400)))).status, 200); // remplace les 1000 octets
  assert.equal((await a.req('PUT', '/api/appdata/demo', snap('z'.repeat(1600)))).status, 507);
  assert.equal((await a.get('/api/appdata/demo')).buf.length, 1400, 'l\'instantané précédent reste intact');
  await a.patch(`/api/admin/users/${id}`, { quota: null });
});

test('effacer ; application retirée au compte : 404 ; origine, invité, vide', async () => {
  assert.equal((await b.req('DELETE', '/api/appdata/demo')).status, 200);
  assert.equal((await b.get('/api/appdata/demo')).status, 204);
  assert.equal((await a.req('PUT', '/api/appdata/demo', { ...snap('x'), origin: false })).status, 403);
  assert.equal((await a.req('PUT', '/api/appdata/demo', snap(''))).status, 400);
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'bruno'").get().id;
  await a.patch(`/api/admin/users/${id}`, { allApps: false, apps: ['other'] });
  assert.equal((await b.req('PUT', '/api/appdata/demo', snap('x'))).status, 404);
  await a.patch('/api/admin/settings', { guest_enabled: true });
  const g = s.client(); g.ip = '198.51.100.98';
  await g.post('/api/auth/guest');
  assert.equal((await g.get('/api/appdata/demo')).status, 401);
});
