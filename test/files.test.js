// Espace fichiers : propriétaire, versions, quota, signature, dossiers, noms.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, PDF } from './helpers.js';

let s, a, b;
const blobCount = () => {
  const dir = join(s.root, 'data', 'blobs');
  return readdirSync(dir).reduce((n, d) => n + readdirSync(join(dir, d)).length, 0);
};
before(async () => {
  s = await startServer();
  a = s.client(); b = s.client();
  await a.post('/api/auth/register', { username: 'alice', password: 'motdepasse1' });
  await a.patch('/api/admin/settings', { signup_open: true });
  b.ip = '198.51.100.5';
  await b.post('/api/auth/register', { username: 'bruno', password: 'motdepasse1' });
});
after(() => s.close());

test('envoi, lecture : octets intacts, jamais servis comme une page', async () => {
  const up = await a.upload('Rapport.pdf', PDF('un'));
  assert.equal(up.status, 201);
  assert.equal(up.data.name, 'Rapport.pdf');
  assert.equal(up.data.versions, 1);
  const r = await a.get(`/api/files/${up.data.id}/content`);
  assert.deepEqual(r.buf, PDF('un'));
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''Rapport\.pdf$/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('fichier d\'un autre compte : 404 partout, jamais 403', async () => {
  const up = await a.upload('Secret.pdf', PDF('secret'));
  const id = up.data.id;
  for (const r of [await b.get(`/api/files/${id}`), await b.get(`/api/files/${id}/content`), await b.put(id, PDF('x')),
    await b.patch(`/api/files/${id}`, { name: 'x.pdf' }), await b.del(`/api/files/${id}`), await b.get(`/api/files/${id}/versions`)]) {
    assert.equal(r.status, 404);
  }
  const folder = await a.post('/api/folders', { name: 'Privé' });
  assert.equal((await b.get(`/api/fs?folder=${folder.data.id}`)).status, 404);
  assert.equal((await b.upload('x.pdf', PDF(), folder.data.id)).status, 404);
  assert.equal((await b.del(`/api/folders/${folder.data.id}`)).status, 404);
  assert.equal((await a.get(`/api/files/${id}/content`)).status, 200);
});

test('signature contrôlée : un .pdf qui n\'en est pas un est refusé', async () => {
  const r = await a.upload('faux.pdf', Buffer.from('<html><script>alert(1)</script>'));
  assert.equal(r.status, 415);
  assert.equal((await a.upload('note.txt', Buffer.from('texte libre'))).status, 201);
});

test('noms : pas de chemin, conflit → « nom (2) », renommage en conflit → 409', async () => {
  for (const bad of ['../x.pdf', 'a/b.pdf', '..', '', 'a\\b.pdf']) assert.equal((await a.upload(bad, PDF())).status, 400, bad);
  const one = await a.upload('Double.pdf', PDF('1'));
  const two = await a.upload('Double.pdf', PDF('2'));
  assert.equal(two.data.name, 'Double (2).pdf');
  assert.equal((await a.patch(`/api/files/${two.data.id}`, { name: 'double.pdf' })).status, 409);
  assert.equal((await a.patch(`/api/files/${one.data.id}`, { name: 'Simple.pdf' })).status, 200);
});

test('versions : chaque enregistrement en crée une, élagage au-delà de max_versions, restauration', async () => {
  await a.patch('/api/admin/settings', { max_versions: 3 });
  const up = await a.upload('Versions.pdf', PDF('v1'));
  const before = blobCount();
  for (let i = 2; i <= 5; i++) assert.equal((await a.put(up.data.id, PDF(`v${i}`), 'demo')).status, 200);
  const vs = (await a.get(`/api/files/${up.data.id}/versions`)).data;
  assert.deepEqual(vs.map((v) => v.n), [5, 4, 3]);
  assert.equal(vs[0].current, true);
  assert.equal(vs[0].app, 'demo');
  assert.equal(blobCount(), before + 2, 'les octets des versions élaguées sont effacés du disque');
  const old = vs.find((v) => v.n === 3);
  assert.deepEqual((await a.get(`/api/files/${up.data.id}/content?version=${old.id}`)).buf, PDF('v3'));
  assert.equal((await a.post(`/api/files/${up.data.id}/versions/${old.id}/restore`)).status, 200);
  assert.deepEqual((await a.get(`/api/files/${up.data.id}/content`)).buf, PDF('v3'));
  assert.deepEqual((await a.get(`/api/files/${up.data.id}/versions`)).data.map((v) => v.n), [6, 5, 4]);
  await a.patch('/api/admin/settings', { max_versions: 10 });
});

test('?replace=1 : même nom dans le dossier → nouvelle version au lieu d\'un nouveau fichier', async () => {
  const up = await a.upload('Export.pdf', PDF('1'));
  const again = await a.upload('Export.pdf', PDF('2'), 'root', '&replace=1');
  assert.equal(again.status, 200);
  assert.equal(again.data.id, up.data.id);
  assert.equal(again.data.versions, 2);
});

test('quota : refus 507 sans rien écrire, versions comprises', async () => {
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'bruno'").get().id;
  await a.patch(`/api/admin/users/${id}`, { quota: 100 });
  const up = await b.upload('Petit.pdf', PDF('x'.repeat(50)));
  assert.equal(up.status, 201);
  const n = blobCount();
  assert.equal((await b.put(up.data.id, PDF('y'.repeat(60)))).status, 507);
  assert.equal(blobCount(), n);
  assert.equal(readdirSync(join(s.root, 'data', 'tmp')).length, 0, 'pas de fichier temporaire oublié');
  assert.equal((await b.get('/api/usage')).data.quota, 100);
  await a.patch(`/api/admin/users/${id}`, { quota: null });
});

test('taille maximale par fichier : 413', async () => {
  await a.patch('/api/admin/settings', { max_file_size: 1000 });
  assert.equal((await a.upload('Gros.pdf', PDF('z'.repeat(2000)))).status, 413);
  await a.patch('/api/admin/settings', { max_file_size: 512 * 1024 * 1024 });
});

test('dossiers : arborescence, déplacement, pas de cycle, suppression récursive avec les octets', async () => {
  const top = (await a.post('/api/folders', { name: 'Projets' })).data;
  const sub = (await a.post('/api/folders', { name: '2026', parentId: top.id })).data;
  const f = (await a.upload('Plan.pdf', PDF('plan'), sub.id)).data;
  const listing = (await a.get(`/api/fs?folder=${sub.id}`)).data;
  assert.deepEqual(listing.path.map((p) => p.name), ['Projets', '2026']);
  assert.deepEqual(listing.files.map((x) => x.name), ['Plan.pdf']);
  assert.equal((await a.patch(`/api/folders/${top.id}`, { parentId: sub.id })).status, 400, 'cycle refusé');
  assert.equal((await a.patch(`/api/folders/${top.id}`, { parentId: top.id })).status, 400);
  assert.equal((await a.post('/api/folders', { name: 'Projets' })).status, 409);
  assert.equal((await a.patch(`/api/files/${f.id}`, { folderId: top.id })).status, 200);
  assert.deepEqual((await a.get(`/api/fs?folder=${top.id}`)).data.files.map((x) => x.name), ['Plan.pdf']);
  const n = blobCount();
  assert.equal((await a.del(`/api/folders/${top.id}`)).status, 204);
  assert.equal((await a.get(`/api/files/${f.id}`)).status, 404);
  assert.equal(blobCount(), n - 1);
});

test('dernière application utilisée, mémorisée par fichier', async () => {
  const f = (await a.upload('Lettre.pdf', PDF())).data;
  assert.equal(f.lastApp, null);
  assert.equal((await a.patch(`/api/files/${f.id}`, { lastApp: 'other' })).data.lastApp, 'other');
  assert.equal((await a.patch(`/api/files/${f.id}`, { lastApp: '../x' })).status, 400);
});

test('suppression d\'un compte : fichiers et octets effacés', async () => {
  const c = s.client(); c.ip = '198.51.100.9';
  await c.post('/api/auth/register', { username: 'temp', password: 'motdepasse1' });
  await c.upload('a.pdf', PDF('a')); await c.upload('b.pdf', PDF('b'));
  const n = blobCount();
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'temp'").get().id;
  assert.equal((await a.del(`/api/admin/users/${id}`)).status, 204);
  assert.equal(blobCount(), n - 2);
  assert.equal((await c.get('/api/fs')).status, 401);
});
