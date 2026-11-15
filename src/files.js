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
  const blobDir = join(dataDir, 'blobs'), tmpDir = join(dataDir, 'tmp'), thumbDir = join(dataDir, 'thumbs');
  mkdirSync(blobDir, { recursive: true });
  mkdirSync(thumbDir, { recursive: true });
  const thumbPath = (fileId) => join(thumbDir, `${fileId}.img`);
  mkdirSync(tmpDir, { recursive: true });
  const blobPath = (vid) => join(blobDir, vid.slice(0, 2), vid);

  const q = {
    folder: db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL'),
    folders: db.prepare("SELECT * FROM folders WHERE user_id = ? AND IFNULL(parent_id, '') = IFNULL(?, '') AND deleted_at IS NULL ORDER BY name COLLATE NOCASE"),
    file: db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM versions v WHERE v.file_id = f.id) versions
      FROM files f WHERE f.id = ? AND f.user_id = ? AND f.deleted_at IS NULL`),
    files: db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM versions v WHERE v.file_id = f.id) versions
      FROM files f WHERE f.user_id = ? AND IFNULL(f.folder_id, '') = IFNULL(?, '') AND f.deleted_at IS NULL ORDER BY f.name COLLATE NOCASE`),
    fileByName: db.prepare("SELECT * FROM files WHERE user_id = ? AND IFNULL(folder_id, '') = IFNULL(?, '') AND name = ? COLLATE NOCASE AND deleted_at IS NULL"),
    folderByName: db.prepare("SELECT * FROM folders WHERE user_id = ? AND IFNULL(parent_id, '') = IFNULL(?, '') AND name = ? COLLATE NOCASE AND deleted_at IS NULL"),
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
    // Corbeille : éléments supprimés à la main (trash_root), et sous-arbre d'un dossier (qu'il soit supprimé ou non).
    trashFolders: db.prepare('SELECT * FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL AND trash_root = 1 ORDER BY deleted_at DESC'),
    trashFiles: db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM versions v WHERE v.file_id = f.id) versions FROM files f
      WHERE f.user_id = ? AND f.deleted_at IS NOT NULL AND f.trash_root = 1 ORDER BY f.deleted_at DESC`),
    anyFolder: db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?'),
    anyFile: db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?'),
    subtree: db.prepare('WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id) SELECT id FROM t'),
    folderSize: db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)
      SELECT IFNULL(SUM(size), 0) size, COUNT(*) n FROM files WHERE folder_id IN (SELECT id FROM t)`),
    expired: db.prepare(`SELECT 'd' kind, id, user_id FROM folders WHERE trash_root = 1 AND deleted_at < @cut
      UNION ALL SELECT 'f', id, user_id FROM files WHERE trash_root = 1 AND deleted_at < @cut`),
    favorites: db.prepare('SELECT kind, item_id FROM favorites WHERE user_id = ?'),
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
    versions: f.versions ?? undefined, createdAt: f.created_at, updatedAt: f.updated_at, versionId: f.version_id,
    thumb: f.thumb_version && f.thumb_version === f.version_id ? f.version_id : null });
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

  // ---------- Corbeille ----------
  // Supprimer = marquer (deleted_at) : l'élément choisi est une entrée de la corbeille (trash_root = 1) ; pour un dossier, son
  // contenu encore présent reçoit la même date (restauré avec lui). Les octets restent, comptés dans le quota, jusqu'à
  // l'effacement définitif (à la main ou après trash_days jours).
  const trashFolder = db.transaction((f) => {
    const now = Date.now(), batch = randomUUID(), ids = q.subtree.all(f.id).map((r) => r.id);
    const list = ids.map(() => '?').join(',');
    db.prepare(`UPDATE folders SET deleted_at = ?, trash_batch = ?, trash_root = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE id IN (${list}) AND deleted_at IS NULL`).run(now, batch, f.id, ...ids);
    db.prepare(`UPDATE files SET deleted_at = ?, trash_batch = ?, trash_root = 0 WHERE folder_id IN (${list}) AND deleted_at IS NULL`).run(now, batch, ...ids);
  });
  // Restaurer : à sa place si son dossier existe encore, sinon à la racine ; nom changé si un autre l'a pris entre-temps.
  function restoreItem(user, kind, id) {
    const row = kind === 'd' ? q.anyFolder.get(id, user.id) : q.anyFile.get(id, user.id);
    if (!row || row.deleted_at == null || !row.trash_root) throw err(404, 'Élément introuvable dans la corbeille.');
    const parentId = kind === 'd' ? row.parent_id : row.folder_id;
    const target = parentId && q.folder.get(parentId, user.id) ? parentId : null;
    const name = freeName((n) => q.fileByName.get(user.id, target, n) || q.folderByName.get(user.id, target, n), row.name);
    db.transaction(() => {
      if (kind === 'f') {
        db.prepare('UPDATE files SET deleted_at = NULL, trash_root = 0, trash_batch = NULL, folder_id = ?, name = ? WHERE id = ?').run(target, name, id);
        return;
      }
      const ids = q.subtree.all(id).map((r) => r.id), list = ids.map(() => '?').join(',');
      db.prepare(`UPDATE folders SET deleted_at = NULL, trash_root = 0, trash_batch = NULL WHERE id IN (${list}) AND trash_batch = ?`).run(...ids, row.trash_batch);
      db.prepare(`UPDATE files SET deleted_at = NULL, trash_root = 0, trash_batch = NULL WHERE folder_id IN (${list}) AND trash_batch = ?`).run(...ids, row.trash_batch);
      db.prepare('UPDATE folders SET parent_id = ?, name = ? WHERE id = ?').run(target, name, id);
    })();
    return { type: kind === 'd' ? 'folder' : 'file', id, name, folderId: target };
  }
  // Effacement définitif : lignes (en cascade), octets, miniatures, favoris.
  async function destroyFolder(userId, id) {
    const blobs = q.blobsUnder.all(id, userId).map((r) => r.id);
    const ids = q.subtree.all(id).map((r) => r.id), list = ids.map(() => '?').join(',');
    const fileIds = db.prepare(`SELECT id FROM files WHERE folder_id IN (${list})`).all(...ids).map((r) => r.id);
    db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
    db.prepare(`DELETE FROM favorites WHERE user_id = ? AND ((kind = 'd' AND item_id IN (${list})) OR (kind = 'f' AND item_id IN (${fileIds.map(() => '?').join(',') || "''"})))`).run(userId, ...ids, ...fileIds);
    await removeBlobs(blobs);
    for (const f of fileIds) await unlink(thumbPath(f)).catch(() => {});
    return blobs.length;
  }
  async function destroyFile(userId, id) {
    const blobs = q.versions.all(id).map((v) => v.id);
    db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(id, userId);
    db.prepare("DELETE FROM favorites WHERE user_id = ? AND kind = 'f' AND item_id = ?").run(userId, id);
    await removeBlobs(blobs);
    await unlink(thumbPath(id)).catch(() => {});
  }
  // Effacement automatique après trash_days jours (au démarrage puis toutes les heures).
  async function purgeTrash(now = Date.now()) {
    const days = settings().trash_days;
    if (!days) return 0;
    const rows = q.expired.all({ cut: now - days * 86_400_000 });
    for (const r of rows) await (r.kind === 'd' ? destroyFolder(r.user_id, r.id) : destroyFile(r.user_id, r.id));
    return rows.length;
  }
  function trashList(user) {
    const where = (parentId) => {
      if (!parentId) return 'Mes fichiers';
      const p = q.folder.get(parentId, user.id);
      return p ? ['Mes fichiers', ...pathOf(user, p).map((x) => x.name)].join(' / ') : 'dossier supprimé';
    };
    const days = settings().trash_days;
    const purgeAt = (t) => (days ? t + days * 86_400_000 : null);
    return [
      ...q.trashFolders.all(user.id).map((f) => { const sz = q.folderSize.get(f.id); return { type: 'folder', id: f.id, name: f.name, deletedAt: f.deleted_at, purgeAt: purgeAt(f.deleted_at), size: sz.size, files: sz.n, from: where(f.parent_id) }; }),
      ...q.trashFiles.all(user.id).map((f) => ({ type: 'file', id: f.id, name: f.name, deletedAt: f.deleted_at, purgeAt: purgeAt(f.deleted_at), size: f.size, versions: f.versions, from: where(f.folder_id) })),
    ].sort((a, b) => b.deletedAt - a.deletedAt);
  }
  const itemsOf = (b) => {
    const items = b?.items;
    if (!Array.isArray(items) || !items.length || items.length > 1000 || !items.every((it) => ['file', 'folder'].includes(it?.type) && typeof it.id === 'string'))
      throw err(400, 'Liste d\'éléments invalide.');
    return items.map((it) => ({ kind: it.type === 'folder' ? 'd' : 'f', id: it.id }));
  };

  function routes(app, requireUser, json) {
    app.get('/api/fs', requireUser, wrap((req, res) => {
      const folder = folderOf(req.user, req.query.folder);
      const fid = folder?.id ?? null;
      const favs = new Set(q.favorites.all(req.user.id).map((r) => `${r.kind}:${r.item_id}`));
      res.set('Cache-Control', 'no-store').json({
        folder: folder ? folderJson(folder) : null, path: pathOf(req.user, folder),
        folders: q.folders.all(req.user.id, fid).map((x) => ({ ...folderJson(x), favorite: favs.has(`d:${x.id}`) })),
        files: q.files.all(req.user.id, fid).map((x) => ({ ...fileJson(x), favorite: favs.has(`f:${x.id}`) })),
        usage: usage(req.user), trash: { days: settings().trash_days, count: q.trashFolders.all(req.user.id).length + q.trashFiles.all(req.user.id).length },
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
      if (settings().trash_days > 0 && req.query.permanent !== '1') {
        trashFolder(f);
        log.audit(req, 'folder.trash', f.id, { name: f.name });
        return res.status(204).end();
      }
      const n = await destroyFolder(req.user.id, f.id);
      log.audit(req, 'folder.delete', f.id, { name: f.name, versions: n });
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
      if (settings().trash_days > 0 && req.query.permanent !== '1') {
        db.prepare('UPDATE files SET deleted_at = ?, trash_root = 1, trash_batch = ? WHERE id = ?').run(Date.now(), randomUUID(), f.id);
        log.audit(req, 'file.trash', f.id, { name: f.name });
        return res.status(204).end();
      }
      await destroyFile(req.user.id, f.id);
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

    // ---------- Corbeille ----------
    app.get('/api/trash', requireUser, wrap((req, res) => {
      res.set('Cache-Control', 'no-store').json({ days: settings().trash_days, items: trashList(req.user) });
    }));
    app.post('/api/trash/restore', requireUser, json, wrap((req, res) => {
      const out = [];
      for (const it of itemsOf(req.body)) {
        out.push(restoreItem(req.user, it.kind, it.id));
        log.audit(req, it.kind === 'd' ? 'folder.restore' : 'file.untrash', it.id, { name: out.at(-1).name });
      }
      res.json({ restored: out });
    }));
    // Effacement définitif d'éléments de la corbeille ({ items }), ou de toute la corbeille ({ all: true }).
    app.post('/api/trash/delete', requireUser, json, wrap(async (req, res) => {
      const items = req.body?.all === true ? trashList(req.user).map((x) => ({ kind: x.type === 'folder' ? 'd' : 'f', id: x.id })) : itemsOf(req.body);
      let n = 0;
      for (const it of items) {
        const row = it.kind === 'd' ? q.anyFolder.get(it.id, req.user.id) : q.anyFile.get(it.id, req.user.id);
        if (!row || row.deleted_at == null || !row.trash_root) continue;
        await (it.kind === 'd' ? destroyFolder(req.user.id, it.id) : destroyFile(req.user.id, it.id));
        log.audit(req, it.kind === 'd' ? 'folder.delete' : 'file.delete', it.id, { name: row.name, from: 'trash' });
        n++;
      }
      res.json({ deleted: n });
    }));

    // ---------- Miniatures ----------
    // Faites par le navigateur (images : depuis le fichier ; documents : par l'application), pour la version courante.
    app.get('/api/files/:id/thumb', requireUser, wrap((req, res) => {
      const f = fileOf(req.user, req.params.id);
      if (!f.thumb_version || f.thumb_version !== f.version_id) throw err(404, 'Pas de miniature.');
      res.set({ 'Cache-Control': 'private, max-age=86400', 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff' });
      res.sendFile(thumbPath(f.id), (e) => { if (e && !res.headersSent) res.status(404).json({ error: 'Pas de miniature.' }); });
    }));
    app.put('/api/files/:id/thumb', requireUser, wrap(async (req, res) => {
      const f = fileOf(req.user, req.params.id);
      if (req.headers['x-version'] !== f.version_id) throw err(409, 'La miniature ne correspond plus à la version courante.');
      if (!/^image\/(webp|png|jpeg)$/.test(String(req.headers['content-type']))) throw err(415, 'Image WebP, PNG ou JPEG attendue.');
      if (Number(req.headers['content-length'] || 0) > 300 * 1024) throw err(413, 'Miniature trop grosse (300 Kio au plus).');
      const chunks = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > 300 * 1024) throw err(413, 'Miniature trop grosse (300 Kio au plus).'); chunks.push(c); }
      const tmp = join(tmpDir, randomUUID());
      const { writeFile } = await import('node:fs/promises');
      await writeFile(tmp, Buffer.concat(chunks));
      await rename(tmp, thumbPath(f.id));
      db.prepare('UPDATE files SET thumb_version = ? WHERE id = ?').run(f.version_id, f.id);
      res.status(204).end();
    }));

    // ---------- Favoris et récents ----------
    app.put('/api/favorites', requireUser, json, wrap((req, res) => {
      const { type, id, on } = req.body || {};
      if (!['file', 'folder'].includes(type) || typeof id !== 'string') throw err(400, 'Élément invalide.');
      const kind = type === 'folder' ? 'd' : 'f';
      if (kind === 'd') folderOf(req.user, id); else fileOf(req.user, id); // 404 si absent ou à autrui
      if (on) db.prepare('INSERT OR IGNORE INTO favorites (user_id, kind, item_id, created_at) VALUES (?, ?, ?, ?)').run(req.user.id, kind, id, Date.now());
      else db.prepare('DELETE FROM favorites WHERE user_id = ? AND kind = ? AND item_id = ?').run(req.user.id, kind, id);
      res.json({ ok: true, favorite: !!on });
    }));
    app.post('/api/recents', requireUser, json, wrap((req, res) => {
      const f = fileOf(req.user, req.body?.fileId);
      const app2 = req.body?.app;
      if (app2 != null && !/^[a-z0-9-]{1,40}$/.test(String(app2))) throw err(400, 'Application invalide.');
      db.prepare(`INSERT INTO recents (user_id, file_id, app, opened_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, file_id) DO UPDATE SET app = excluded.app, opened_at = excluded.opened_at`).run(req.user.id, f.id, app2 ?? null, Date.now());
      db.prepare(`DELETE FROM recents WHERE user_id = ? AND file_id NOT IN (SELECT file_id FROM recents WHERE user_id = ? ORDER BY opened_at DESC LIMIT 50)`).run(req.user.id, req.user.id);
      res.status(204).end();
    }));
    // Accès rapide de l'accueil : derniers fichiers ouverts et favoris (hors corbeille).
    app.get('/api/quick', requireUser, wrap((req, res) => {
      const recents = db.prepare(`SELECT f.*, r.app open_app, r.opened_at FROM recents r JOIN files f ON f.id = r.file_id
        WHERE r.user_id = ? AND f.deleted_at IS NULL ORDER BY r.opened_at DESC LIMIT 12`).all(req.user.id);
      const favFiles = db.prepare(`SELECT f.*, fv.created_at fav_at FROM favorites fv JOIN files f ON f.id = fv.item_id
        WHERE fv.user_id = ? AND fv.kind = 'f' AND f.deleted_at IS NULL`).all(req.user.id);
      const favFolders = db.prepare(`SELECT d.*, fv.created_at fav_at FROM favorites fv JOIN folders d ON d.id = fv.item_id
        WHERE fv.user_id = ? AND fv.kind = 'd' AND d.deleted_at IS NULL`).all(req.user.id);
      res.set('Cache-Control', 'no-store').json({
        recents: recents.map((f) => ({ ...fileJson(f), openedWith: f.open_app, openedAt: f.opened_at })),
        favorites: [...favFolders.map((d) => ({ type: 'folder', ...folderJson(d), favAt: d.fav_at })), ...favFiles.map((f) => ({ type: 'file', ...fileJson(f), favAt: f.fav_at }))]
          .sort((a, b) => b.favAt - a.favAt),
      });
    }));
  }

  // Suppression d'un compte : les lignes partent en cascade, les octets sont effacés ici.
  async function purgeUser(userId) {
    const blobs = q.userBlobs.all(userId).map((r) => r.id);
    await removeBlobs(blobs);
    return blobs.length;
  }
  const cleanTmp = () => rm(tmpDir, { recursive: true, force: true }).then(() => mkdirSync(tmpDir, { recursive: true }));

  // Corbeille : effacement automatique au démarrage puis toutes les heures.
  const purgeTimer = setInterval(() => purgeTrash().catch(() => {}), 3_600_000);
  purgeTimer.unref?.();
  setTimeout(() => purgeTrash().catch(() => {}), 5_000).unref?.();
  return { routes, usage, purgeUser, cleanTmp, purgeTrash, blobPath, liveFile: (id) => db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) };
}
