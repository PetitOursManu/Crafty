// Espace fichiers par compte : dossiers, fichiers, versions, quotas.
// Règles (CLAUDE.md) : octets sur disque sous un UUID (le nom affiché vit en base), propriétaire vérifié à chaque
// appel (404, jamais 403), écriture atomique (fichier temporaire puis renommage), versions conservées dans la
// limite du réglage max_versions, quota par compte (anciennes versions comprises).
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { rename, rm, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';

const NAME_MAX = 255;
// Signature attendue pour les formats qui en ont une : un .pdf qui ne commence pas par %PDF- est refusé.
const MAGIC = { pdf: [Buffer.from('%PDF-')], docx: [Buffer.from('PK\x03\x04')], odt: [Buffer.from('PK\x03\x04')],
  xlsx: [Buffer.from('PK\x03\x04')], pptx: [Buffer.from('PK\x03\x04')], zip: [Buffer.from('PK\x03\x04')],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47])], jpg: [Buffer.from([0xff, 0xd8, 0xff])], jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
  rtf: [Buffer.from('{\\rtf')] };

export function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!n || n.length > NAME_MAX || /[\\/]/.test(n) || n === '.' || n === '..') return null;
  return n;
}
export const extOf = (name) => extname(name).slice(1).toLowerCase();
const err = (status, error) => Object.assign(new Error(error), { status, expose: true });

export function createFiles({ db, dataDir, log, settings }) {
  const blobDir = join(dataDir, 'blobs'), tmpDir = join(dataDir, 'tmp');
  mkdirSync(blobDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const blobPath = (vid) => join(blobDir, vid.slice(0, 2), vid);

  const q = {
    folder: db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?'),
    folders: db.prepare("SELECT * FROM folders WHERE user_id = ? AND IFNULL(parent_id, '') = IFNULL(?, '') ORDER BY name COLLATE NOCASE"),
    file: db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM versions v WHERE v.file_id = f.id) versions
      FROM files f WHERE f.id = ? AND f.user_id = ?`),
    files: db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM versions v WHERE v.file_id = f.id) versions
      FROM files f WHERE f.user_id = ? AND IFNULL(f.folder_id, '') = IFNULL(?, '') ORDER BY f.name COLLATE NOCASE`),
    fileByName: db.prepare("SELECT * FROM files WHERE user_id = ? AND IFNULL(folder_id, '') = IFNULL(?, '') AND name = ? COLLATE NOCASE"),
    folderByName: db.prepare("SELECT * FROM folders WHERE user_id = ? AND IFNULL(parent_id, '') = IFNULL(?, '') AND name = ? COLLATE NOCASE"),
    // Versions des fichiers + données des applications (appdata.js) : tout compte dans le quota.
    used: db.prepare(`SELECT (SELECT IFNULL(SUM(size), 0) FROM versions WHERE user_id = @id)
      + (SELECT IFNULL(SUM(size), 0) FROM app_data WHERE user_id = @id) n`),
    insertFolder: db.prepare('INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    insertFile: db.prepare('INSERT INTO files (id, user_id, folder_id, name, size, last_app, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'),
    maxN: db.prepare('SELECT IFNULL(MAX(n), 0) n FROM versions WHERE file_id = ?'),
    insertVersion: db.prepare('INSERT INTO versions (id, file_id, user_id, n, size, sha256, app, created_at, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    versionRow: db.prepare('SELECT * FROM versions WHERE id = ?'),
    setCurrent: db.prepare('UPDATE files SET size = ?, version_id = ?, updated_at = ?, last_app = IFNULL(?, last_app) WHERE id = ?'),
    old: db.prepare('SELECT id FROM versions WHERE file_id = ? ORDER BY n DESC LIMIT -1 OFFSET ?'),
    delVersion: db.prepare('DELETE FROM versions WHERE id = ?'),
    versions: db.prepare('SELECT id, n, size, sha256, app, created_at, auto FROM versions WHERE file_id = ? ORDER BY n DESC'),
    version: db.prepare('SELECT * FROM versions WHERE id = ? AND file_id = ?'),
    // Toutes les versions sous un dossier (récursif), pour effacer les octets avant la suppression en cascade.
    blobsUnder: db.prepare(`WITH RECURSIVE t(id) AS (SELECT id FROM folders WHERE id = ? AND user_id = ?
        UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)
      SELECT v.id FROM versions v JOIN files fi ON fi.id = v.file_id WHERE fi.folder_id IN (SELECT id FROM t)`),
    isUnder: db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)
      SELECT 1 FROM t WHERE id = ?`),
    userBlobs: db.prepare('SELECT id FROM versions WHERE user_id = ?'),
  };

  const usage = (user) => ({ used: q.used.get({ id: user.id }).n, quota: user.quota ?? settings().default_quota });
  const folderOf = (user, id) => {
    if (id == null || id === '' || id === 'root') return null;
    const f = q.folder.get(String(id), user.id);
    if (!f) throw err(404, 'Dossier introuvable.');
    return f;
  };
  const fileOf = (user, id) => {
    const f = q.file.get(String(id), user.id);
    if (!f) throw err(404, 'Fichier introuvable.');
    return f;
  };
  const pathOf = (user, folder) => {
    const out = [];
    for (let f = folder; f; f = f.parent_id ? q.folder.get(f.parent_id, user.id) : null) out.unshift({ id: f.id, name: f.name });
    return out;
  };
  const fileJson = (f) => ({ id: f.id, name: f.name, folderId: f.folder_id, size: f.size, lastApp: f.last_app,
    versions: f.versions ?? undefined, createdAt: f.created_at, updatedAt: f.updated_at });
  const folderJson = (f) => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: f.created_at, updatedAt: f.updated_at });

  function freeName(exists, name) {
    if (!exists(name)) return name;
    const ext = extname(name), base = name.slice(0, name.length - ext.length);
    for (let i = 2; i < 1000; i++) { const n = `${base} (${i})${ext}`; if (!exists(n)) return n; }
    throw err(409, 'Trop de fichiers portant ce nom.');
  }

  // Reçoit le corps en flux vers data/tmp : taille limitée, quota vérifié, SHA-256 calculé, signature contrôlée.
  async function receive(req, user, name, replacingSize = 0) {
    const { max_file_size: max } = settings();
    const { used, quota } = usage(user);
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > max) throw err(413, 'Fichier trop gros.');
    if (used + declared > quota) throw err(507, 'Espace de stockage plein.');
    const tmp = join(tmpDir, randomUUID());
    const hash = createHash('sha256');
    let size = 0, head = Buffer.alloc(0);
    const out = createWriteStream(tmp, { flags: 'wx' });
    try {
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          size += chunk.length;
          if (head.length < 8) head = Buffer.concat([head, chunk.subarray(0, 8)]);
          if (size > max) { req.destroy(); return reject(err(413, 'Fichier trop gros.')); }
          if (used + size > quota) { req.destroy(); return reject(err(507, 'Espace de stockage plein.')); }
          hash.update(chunk);
          if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
        });
        req.on('end', resolve);
        req.on('error', reject);
        req.on('aborted', () => reject(err(400, 'Envoi interrompu.')));
      });
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      const magic = MAGIC[extOf(name)];
      if (magic && size > 0 && !magic.some((m) => head.subarray(0, m.length).equals(m)))
        throw err(415, `Le contenu ne correspond pas à un fichier .${extOf(name)}.`);
      return { tmp, size, sha256: hash.digest('hex') };
    } catch (e) {
      out.destroy();
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  // Ajoute une version (renommage atomique du fichier temporaire), puis élague au-delà de max_versions.
  // Sauvegarde automatique (auto) : si la version courante est elle-même automatique, elle est remplacée
  // (même numéro) au lieu d'en créer une nouvelle ; seuls les enregistrements explicites font l'historique.
  async function addVersion(user, file, body, app, { auto = false } = {}) {
    // Contenu identique à la version courante (enregistrement sans modification) : pas de nouvelle version.
    const current = file.version_id ? q.versionRow.get(file.version_id) : null;
    if (current && current.sha256 === body.sha256) { await unlink(body.tmp).catch(() => {}); return current.id; }
    const vid = randomUUID();
    mkdirSync(join(blobDir, vid.slice(0, 2)), { recursive: true });
    await rename(body.tmp, blobPath(vid));
    const now = Date.now();
    let pruned = [];
    db.transaction(() => {
      const cur = file.version_id ? q.versionRow.get(file.version_id) : null;
      const merge = auto && cur?.auto;
      q.insertVersion.run(vid, file.id, user.id, merge ? cur.n : q.maxN.get(file.id).n + 1, body.size, body.sha256, app ?? null, now, auto ? 1 : 0);
      q.setCurrent.run(body.size, vid, now, app ?? null, file.id);
      if (merge) { q.delVersion.run(cur.id); pruned.push(cur.id); }
      const old = q.old.all(file.id, Math.max(1, settings().max_versions)).map((r) => r.id);
      for (const id of old) q.delVersion.run(id);
      pruned.push(...old);
    })();
    await Promise.all(pruned.map((id) => unlink(blobPath(id)).catch(() => {})));
    return vid;
  }

  const removeBlobs = (ids) => Promise.all(ids.map((id) => unlink(blobPath(id)).catch(() => {})));
  const appHeader = (req) => (/^[a-z0-9-]{1,40}$/.test(req.headers['x-app'] || '') ? req.headers['x-app'] : null);
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e.expose) return res.status(e.status).json({ error: e.message });
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Un élément porte déjà ce nom ici.' });
      console.error(e);
      res.status(500).json({ error: 'Erreur interne.' });
    }
  };

  function routes(app, requireUser, json) {
    app.get('/api/fs', requireUser, wrap((req, res) => {
      const folder = folderOf(req.user, req.query.folder);
      const fid = folder?.id ?? null;
      res.set('Cache-Control', 'no-store').json({
        folder: folder ? folderJson(folder) : null, path: pathOf(req.user, folder),
        folders: q.folders.all(req.user.id, fid).map(folderJson), files: q.files.all(req.user.id, fid).map(fileJson),
        usage: usage(req.user),
      });
    }));
    app.get('/api/usage', requireUser, (req, res) => res.set('Cache-Control', 'no-store').json(usage(req.user)));

    app.post('/api/folders', requireUser, json, wrap((req, res) => {
      const parent = folderOf(req.user, req.body?.parentId);
      const name = cleanName(req.body?.name);
      if (!name) throw err(400, 'Nom de dossier invalide.');
      const id = randomUUID(), now = Date.now();
      q.insertFolder.run(id, req.user.id, parent?.id ?? null, name, now, now);
      log.audit(req, 'folder.create', id, { name });
      res.status(201).json(folderJson(q.folder.get(id, req.user.id)));
    }));
    app.patch('/api/folders/:id', requireUser, json, wrap((req, res) => {
      const f = folderOf(req.user, req.params.id);
      if (!f) throw err(404, 'Dossier introuvable.');
      const sets = {};
      if (req.body?.name !== undefined) { sets.name = cleanName(req.body.name); if (!sets.name) throw err(400, 'Nom de dossier invalide.'); }
      if (req.body?.parentId !== undefined) {
        const target = folderOf(req.user, req.body.parentId);
        if (target && q.isUnder.get(f.id, target.id)) throw err(400, 'Impossible de déplacer un dossier dans lui-même.');
        sets.parent_id = target?.id ?? null;
      }
      const keys = Object.keys(sets);
      if (keys.length) db.prepare(`UPDATE folders SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`)
        .run({ ...sets, now: Date.now(), id: f.id });
      log.audit(req, 'folder.update', f.id, sets);
      res.json(folderJson(q.folder.get(f.id, req.user.id)));
    }));
    app.delete('/api/folders/:id', requireUser, wrap(async (req, res) => {
      const f = folderOf(req.user, req.params.id);
      if (!f) throw err(404, 'Dossier introuvable.');
      const blobs = q.blobsUnder.all(f.id, req.user.id).map((r) => r.id);
      db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(f.id, req.user.id);
      await removeBlobs(blobs);
      log.audit(req, 'folder.delete', f.id, { name: f.name, versions: blobs.length });
      res.status(204).end();
    }));

    // Envoi d'un nouveau fichier. ?replace=1 : si le nom existe déjà dans le dossier, nouvelle version de ce fichier.
    app.post('/api/files', requireUser, wrap(async (req, res) => {
      const folder = folderOf(req.user, req.query.folder);
      let name;
      try { name = cleanName(decodeURIComponent(String(req.headers['x-file-name'] || ''))); } catch { name = null; }
      if (!name) throw err(400, 'Nom de fichier invalide.');
      const fid = folder?.id ?? null;
      const existing = req.query.replace ? q.fileByName.get(req.user.id, fid, name) : null;
      const body = await receive(req, req.user, name);
      let file = existing;
      if (!file) {
        name = freeName((n) => q.fileByName.get(req.user.id, fid, n) || q.folderByName.get(req.user.id, fid, n), name);
        const id = randomUUID(), now = Date.now();
        q.insertFile.run(id, req.user.id, fid, name, appHeader(req), now, now);
        file = { id };
      }
      await addVersion(req.user, file, body, appHeader(req));
      log.audit(req, existing ? 'file.save' : 'file.upload', file.id, { name, size: body.size });
      res.status(existing ? 200 : 201).json(fileJson(fileOf(req.user, file.id)));
    }));
    app.get('/api/files/:id', requireUser, wrap((req, res) => {
      const f = fileOf(req.user, req.params.id);
      res.set('Cache-Control', 'no-store').json({ ...fileJson(f), path: pathOf(req.user, folderOf(req.user, f.folder_id)) });
    }));
    // Octets : toujours en application/octet-stream + attachment (un fichier de l'utilisateur n'est jamais rendu
    // comme une page de notre origine).
    app.get('/api/files/:id/content', requireUser, wrap((req, res) => {
      const f = fileOf(req.user, req.params.id);
      const v = req.query.version ? q.version.get(String(req.query.version), f.id) : { id: f.version_id };
      if (!v?.id) throw err(404, 'Version introuvable.');
      res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` });
      res.sendFile(blobPath(v.id), (e) => { if (e && !res.headersSent) res.status(404).json({ error: 'Contenu introuvable.' }); });
    }));
    app.put('/api/files/:id/content', requireUser, wrap(async (req, res) => {
      const f = fileOf(req.user, req.params.id);
      const body = await receive(req, req.user, f.name);
      const auto = req.headers['x-autosave'] === '1';
      await addVersion(req.user, f, body, appHeader(req), { auto });
      log.audit(req, auto ? 'file.autosave' : 'file.save', f.id, { size: body.size, app: appHeader(req) });
      res.json(fileJson(fileOf(req.user, f.id)));
    }));
    app.patch('/api/files/:id', requireUser, json, wrap((req, res) => {
      const f = fileOf(req.user, req.params.id);
      const sets = {};
      if (req.body?.name !== undefined) { sets.name = cleanName(req.body.name); if (!sets.name) throw err(400, 'Nom de fichier invalide.'); }
      if (req.body?.folderId !== undefined) sets.folder_id = folderOf(req.user, req.body.folderId)?.id ?? null;
      if (req.body?.lastApp !== undefined) {
        if (!/^[a-z0-9-]{1,40}$/.test(String(req.body.lastApp))) throw err(400, 'Application invalide.');
        sets.last_app = req.body.lastApp;
      }
      const keys = Object.keys(sets);
      if (keys.length) db.prepare(`UPDATE files SET ${keys.map((k) => `${k} = @${k}`).join(', ')}${sets.name || 'folder_id' in sets ? ', updated_at = @now' : ''} WHERE id = @id`)
        .run({ ...sets, now: Date.now(), id: f.id });
      if (sets.name || 'folder_id' in sets) log.audit(req, 'file.update', f.id, sets);
      res.json(fileJson(fileOf(req.user, f.id)));
    }));
    app.delete('/api/files/:id', requireUser, wrap(async (req, res) => {
      const f = fileOf(req.user, req.params.id);
      const blobs = q.versions.all(f.id).map((v) => v.id);
      db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(f.id, req.user.id);
      await removeBlobs(blobs);
      log.audit(req, 'file.delete', f.id, { name: f.name });
      res.status(204).end();
    }));
    app.get('/api/files/:id/versions', requireUser, wrap((req, res) => {
      const f = fileOf(req.user, req.params.id);
      res.set('Cache-Control', 'no-store').json(q.versions.all(f.id).map((v) => ({ id: v.id, n: v.n, size: v.size, sha256: v.sha256,
        app: v.app, createdAt: v.created_at, current: v.id === f.version_id, auto: !!v.auto })));
    }));
    // Restaurer = copier l'ancienne version en nouvelle version courante (l'historique est conservé).
    app.post('/api/files/:id/versions/:vid/restore', requireUser, wrap(async (req, res) => {
      const f = fileOf(req.user, req.params.id);
      const v = q.version.get(req.params.vid, f.id);
      if (!v) throw err(404, 'Version introuvable.');
      const { used, quota } = usage(req.user);
      if (used + v.size > quota) throw err(507, 'Espace de stockage plein.');
      const tmp = join(tmpDir, randomUUID());
      const { copyFile } = await import('node:fs/promises');
      await copyFile(blobPath(v.id), tmp);
      await addVersion(req.user, f, { tmp, size: v.size, sha256: v.sha256 }, v.app);
      log.audit(req, 'file.restore', f.id, { from: v.n });
      res.json(fileJson(fileOf(req.user, f.id)));
    }));
  }

  // Suppression d'un compte : les lignes partent en cascade, les octets sont effacés ici.
  async function purgeUser(userId) {
    const blobs = q.userBlobs.all(userId).map((r) => r.id);
    await removeBlobs(blobs);
    return blobs.length;
  }
  const cleanTmp = () => rm(tmpDir, { recursive: true, force: true }).then(() => mkdirSync(tmpDir, { recursive: true }));

  return { routes, usage, purgeUser, cleanTmp };
}
