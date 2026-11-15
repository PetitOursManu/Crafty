// Liens de partage : création, accès sans compte, expiration, révocation, corbeille, désactivation, en-têtes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, PDF } from './helpers.js';

let s, a, b, anon, f;
before(async () => {
  s = await startServer();
  a = s.client(); b = s.client(); anon = s.client();
  await a.post('/api/auth/register', { username: 'alice', password: 'motdepasse1' });
  await a.patch('/api/admin/settings', { signup_open: true });
  b.ip = '198.51.100.40';
  await b.post('/api/auth/register', { username: 'bruno', password: 'motdepasse1' });
  f = (await a.upload('Contrat.pdf', PDF('contrat'))).data;
});
after(() => s.close());
const token = (url) => url.split('/').pop();

test('créer un lien : jeton montré une fois, empreinte seule en base', async () => {
  const r = await a.post(`/api/files/${f.id}/shares`, { expires: '7d' });
  assert.equal(r.status, 201);
  assert.match(r.data.url, /^\/s\/[A-Za-z0-9_-]{43}$/);
  assert.ok(r.data.expiresAt > Date.now() + 6 * 86_400_000);
  const row = s.db.prepare('SELECT token_hash FROM shares WHERE id = ?').get(r.data.id);
  assert.notEqual(row.token_hash, token(r.data.url));
  const list = (await a.get(`/api/files/${f.id}/shares`)).data;
  assert.equal(list.shares.length, 1);
  assert.ok(!JSON.stringify(list).includes(token(r.data.url)), 'jeton réaffiché');
  assert.equal((await b.post(`/api/files/${f.id}/shares`, {})).status, 404, 'fichier d\'autrui');
  assert.equal((await a.post(`/api/files/${f.id}/shares`, { expires: '99y' })).status, 400);
});

test('accès sans compte : métadonnées, aperçu PDF en ligne, téléchargement compté ; en-têtes', async () => {
  const t = token((await a.post(`/api/files/${f.id}/shares`, { expires: 'never' })).data.url);
  const page = await anon.get(`/s/${t}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const meta = await anon.get(`/api/s/${t}`);
  assert.deepEqual([meta.status, meta.data.name, meta.data.sharedBy, meta.data.preview, meta.data.expiresAt], [200, 'Contrat.pdf', 'alice', 'pdf', null]);
  const view = await anon.get(`/api/s/${t}/content`);
  assert.equal(view.headers.get('content-type'), 'application/pdf');
  assert.match(view.headers.get('content-disposition'), /^inline/);
  assert.equal(view.buf.toString(), '%PDF-1.7 contrat');
  const dl = await anon.get(`/api/s/${t}/content?dl=1`);
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.equal(dl.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await a.get(`/api/files/${f.id}/shares`)).data.shares.find((x) => x.expiresAt === null).downloads, 1);
  assert.equal((await anon.get('/api/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 404);
});

test('HTML ou SVG jamais rendus en ligne', async () => {
  const g = (await a.upload('page.html', Buffer.from('<script>alert(1)</script>'))).data;
  const t = token((await a.post(`/api/files/${g.id}/shares`, {})).data.url);
  assert.equal((await anon.get(`/api/s/${t}`)).data.preview, null);
  const r = await anon.get(`/api/s/${t}/content`);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
});

test('révocation, expiration, corbeille, partage coupé par l\'admin', async () => {
  const r = (await a.post(`/api/files/${f.id}/shares`, { expires: '1h' })).data, t = token(r.url);
  assert.equal((await anon.get(`/api/s/${t}`)).status, 200);
  assert.equal((await b.del(`/api/shares/${r.id}`)).status, 404, 'lien d\'autrui');
  assert.equal((await a.del(`/api/shares/${r.id}`)).status, 204);
  assert.equal((await anon.get(`/api/s/${t}`)).status, 404);
  const r2 = (await a.post(`/api/files/${f.id}/shares`, { expires: '1h' })).data;
  s.db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1, r2.id);
  assert.equal((await anon.get(`/api/s/${token(r2.url)}`)).status, 404, 'expiré');
  const t3 = token((await a.post(`/api/files/${f.id}/shares`, {})).data.url);
  await a.patch('/api/admin/settings', { sharing_enabled: false });
  assert.equal((await anon.get(`/api/s/${t3}`)).status, 404);
  assert.equal((await a.post(`/api/files/${f.id}/shares`, {})).status, 403);
  await a.patch('/api/admin/settings', { sharing_enabled: true });
  assert.equal((await anon.get(`/api/s/${t3}`)).status, 200);
  await a.del(`/api/files/${f.id}`); // corbeille
  assert.equal((await anon.get(`/api/s/${t3}`)).status, 404);
  await a.post('/api/trash/restore', { items: [{ type: 'file', id: f.id }] });
  assert.equal((await anon.get(`/api/s/${t3}`)).status, 200, 'restauré : le lien revit');
});
