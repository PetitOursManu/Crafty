// Corbeille, miniatures, favoris et récents.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, PDF } from './helpers.js';

let s, a, b;
const blobCount = () => readdirSync(join(s.root, 'data', 'blobs'), { recursive: true }).filter((f) => !String(f).match(/^[0-9a-f]{2}$/)).length;
before(async () => {
  s = await startServer();
  a = s.client(); b = s.client();
  await a.post('/api/auth/register', { username: 'alice', password: 'motdepasse1' });
  await a.patch('/api/admin/settings', { signup_open: true });
  b.ip = '198.51.100.30';
  await b.post('/api/auth/register', { username: 'bruno', password: 'motdepasse1' });
});
after(() => s.close());
const names = async (folder = 'root') => (await a.get(`/api/fs?folder=${folder}`)).data;

test('supprimer met à la corbeille : invisible, nom libéré, octets gardés, restaurable', async () => {
  const f = (await a.upload('Devis.pdf', PDF('v1'))).data;
  const n = blobCount();
  assert.equal((await a.del(`/api/files/${f.id}`)).status, 204);
  assert.deepEqual((await names()).files.map((x) => x.name), []);
  assert.equal((await names()).trash.count, 1);
  assert.equal((await a.get(`/api/files/${f.id}`)).status, 404, 'inaccessible depuis la corbeille');
  assert.equal(blobCount(), n, 'octets gardés');
  const t = (await a.get('/api/trash')).data;
  assert.equal(t.days, 30);
  assert.deepEqual(t.items.map((x) => [x.type, x.name, x.from]), [['file', 'Devis.pdf', 'Mes fichiers']]);
  assert.ok(t.items[0].purgeAt > Date.now() + 29 * 86_400_000);
  // Le nom est libre ; à la restauration, l'ancien prend un autre nom.
  const g = (await a.upload('Devis.pdf', PDF('autre'))).data;
  assert.equal(g.name, 'Devis.pdf');
  const r = await a.post('/api/trash/restore', { items: [{ type: 'file', id: f.id }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.restored[0].name, 'Devis (2).pdf');
  assert.deepEqual((await names()).files.map((x) => x.name).sort(), ['Devis (2).pdf', 'Devis.pdf']);
  assert.equal((await b.post('/api/trash/restore', { items: [{ type: 'file', id: f.id }] })).status, 404, 'corbeille d\'autrui');
});

test('dossier : son contenu part et revient avec lui ; parent disparu → racine', async () => {
  const top = (await a.post('/api/folders', { name: 'Projets' })).data;
  const sub = (await a.post('/api/folders', { name: 'Sous', parentId: top.id })).data;
  const p = (await a.upload('Plan.pdf', PDF(), sub.id)).data;
  const lone = (await a.upload('Seul.pdf', PDF(), sub.id)).data;
  await a.del(`/api/files/${lone.id}`); // supprimé avant, à part
  await a.del(`/api/folders/${top.id}`);
  const items = (await a.get('/api/trash')).data.items;
  assert.deepEqual(items.map((x) => x.name).sort(), ['Projets', 'Seul.pdf']);
  assert.equal(items.find((x) => x.name === 'Projets').files, 2, 'taille du dossier : ses fichiers, même déjà supprimés');
  await a.post('/api/trash/restore', { items: [{ type: 'folder', id: top.id }] });
  assert.deepEqual((await names(sub.id)).files.map((x) => x.name), ['Plan.pdf'], 'Seul.pdf reste dans la corbeille');
  // Supprimer de nouveau le dossier, puis restaurer Seul.pdf : son dossier n'existe plus → racine.
  await a.del(`/api/folders/${top.id}`);
  const r = (await a.post('/api/trash/restore', { items: [{ type: 'file', id: lone.id }] })).data.restored[0];
  assert.equal(r.folderId, null);
  assert.ok((await names()).files.some((x) => x.name === 'Seul.pdf'));
  assert.equal((await a.get(`/api/files/${p.id}`)).status, 404);
});

test('lots distincts même à la même milliseconde : un fichier supprimé avant son dossier ne revient pas avec lui', async () => {
  const d = (await a.post('/api/folders', { name: 'Lot' })).data;
  const keep = (await a.upload('Garde.pdf', PDF(), d.id)).data, alone = (await a.upload('Part.pdf', PDF(), d.id)).data;
  await a.del(`/api/files/${alone.id}`);
  await a.del(`/api/folders/${d.id}`);
  s.db.prepare('UPDATE files SET deleted_at = 1000 WHERE id IN (?, ?)').run(keep.id, alone.id);
  s.db.prepare('UPDATE folders SET deleted_at = 1000 WHERE id = ?').run(d.id);
  await a.post('/api/trash/restore', { items: [{ type: 'folder', id: d.id }] });
  assert.deepEqual((await names(d.id)).files.map((x) => x.name), ['Garde.pdf']);
  await a.post('/api/trash/delete', { all: true });
});

test('effacement définitif : à la main, toute la corbeille, puis automatique après trash_days', async () => {
  const f = (await a.upload('Vieux.pdf', PDF('x'))).data;
  await a.del(`/api/files/${f.id}`);
  const n = blobCount();
  assert.equal((await a.post('/api/trash/delete', { items: [{ type: 'file', id: f.id }] })).data.deleted, 1);
  assert.equal(blobCount(), n - 1);
  assert.equal((await a.post('/api/trash/delete', { all: true })).status, 200);
  assert.equal((await a.get('/api/trash')).data.items.length, 0);
  // Automatique : un élément supprimé il y a 31 jours.
  const g = (await a.upload('Ancien.pdf', PDF('y'))).data;
  await a.del(`/api/files/${g.id}`);
  s.db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').run(Date.now() - 31 * 86_400_000, g.id);
  const h = (await a.upload('Recent.pdf', PDF('z'))).data;
  await a.del(`/api/files/${h.id}`);
  assert.equal(await s.app.locals.files.purgeTrash(), 1);
  assert.deepEqual((await a.get('/api/trash')).data.items.map((x) => x.name), ['Recent.pdf']);
  // Corbeille désactivée : suppression immédiate.
  await a.patch('/api/admin/settings', { trash_days: 0 });
  const k = (await a.upload('Direct.pdf', PDF('d'))).data;
  await a.del(`/api/files/${k.id}`);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM files WHERE id = ?').get(k.id).n, 0);
  await a.patch('/api/admin/settings', { trash_days: 30 });
});

test('miniatures : pour la version courante seulement, petites images', async () => {
  const f = (await a.upload('Image.pdf', PDF('img'))).data;
  assert.equal(f.thumb, null);
  const webp = Buffer.from('RIFF0000WEBPVP8 test');
  const put = (version, body = webp, type = 'image/webp') => a.req('PUT', `/api/files/${f.id}/thumb`, { body, headers: { 'content-type': type, 'x-version': version } });
  assert.equal((await put('autre')).status, 409);
  assert.equal((await put(f.versionId, webp, 'text/html')).status, 415);
  assert.equal((await put(f.versionId, Buffer.alloc(400 * 1024))).status, 413);
  assert.equal((await put(f.versionId)).status, 204);
  const listed = (await names()).files.find((x) => x.id === f.id);
  assert.equal(listed.thumb, f.versionId);
  const g = await a.get(`/api/files/${f.id}/thumb`);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'image/webp');
  assert.equal((await b.get(`/api/files/${f.id}/thumb`)).status, 404);
  // Nouvelle version : la miniature ne vaut plus.
  await a.put(f.id, PDF('img v2'));
  assert.equal((await names()).files.find((x) => x.id === f.id).thumb, null);
  assert.equal((await a.get(`/api/files/${f.id}/thumb`)).status, 404);
});

test('favoris et récents : par compte, hors corbeille', async () => {
  const d = (await a.post('/api/folders', { name: 'Favori' })).data;
  const f = (await a.upload('Rapport.pdf', PDF('r'))).data;
  assert.equal((await a.req('PUT', '/api/favorites', { json: { type: 'folder', id: d.id, on: true } })).status, 200);
  await a.req('PUT', '/api/favorites', { json: { type: 'file', id: f.id, on: true } });
  assert.equal((await b.req('PUT', '/api/favorites', { json: { type: 'file', id: f.id, on: true } })).status, 404, 'fichier d\'autrui');
  assert.equal((await names()).folders.find((x) => x.id === d.id).favorite, true);
  assert.equal((await a.post('/api/recents', { fileId: f.id, app: 'demo' })).status, 204);
  let q = (await a.get('/api/quick')).data;
  assert.deepEqual(q.favorites.map((x) => x.name).sort(), ['Favori', 'Rapport.pdf']);
  assert.deepEqual(q.recents.map((x) => [x.name, x.openedWith]), [['Rapport.pdf', 'demo']]);
  assert.deepEqual((await b.get('/api/quick')).data, { recents: [], favorites: [] });
  await a.del(`/api/files/${f.id}`);
  q = (await a.get('/api/quick')).data;
  assert.deepEqual([q.recents.length, q.favorites.map((x) => x.name)], [0, ['Favori']]);
  await a.req('PUT', '/api/favorites', { json: { type: 'folder', id: d.id, on: false } });
  assert.equal((await a.get('/api/quick')).data.favorites.length, 0);
});

