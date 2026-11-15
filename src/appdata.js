// Données des applications par compte (au-delà des réglages, voir prefs.js) : ce que certaines applications gardent dans
// le stockage du navigateur (boîte MailCraft dans le localStorage, session EffectCraft dans l'OPFS, bases IndexedDB…).
// Ce stockage est commun à tous les comptes d'un même navigateur (même origine). La page hôte en envoie ici un
// instantané (format défini par public/appdata-sync.js, opaque pour le serveur) et le remet en place avant de charger
// l'application pour le même compte. Un instantané par compte et par application, dans DATA_DIR/appdata/, compté dans
// le quota du compte. Seules les applications autorisées au compte et qui déclarent des données (« data » dans
// apps.json) sont acceptées ; sinon 404, comme un fichier d'autrui.
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const APPDATA_MAX = 512 * 1024 ** 2; // par application et par compte

export function createAppData({ db, dataDir }) {
  const dir = join(dataDir, 'appdata');
  mkdirSync(dir, { recursive: true });
  const q = {
    get: db.prepare('SELECT size, sha256, updated_at FROM app_data WHERE user_id = ? AND app = ?'),
    set: db.prepare(`INSERT INTO app_data (user_id, app, size, sha256, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, app) DO UPDATE SET size = excluded.size, sha256 = excluded.sha256, updated_at = excluded.updated_at`),
    del: db.prepare('DELETE FROM app_data WHERE user_id = ? AND app = ?'),
    ofUser: db.prepare('SELECT app FROM app_data WHERE user_id = ?'),
  };
  const fileOf = (userId, slug) => join(dir, `${Number(userId)}-${slug}.bin`);

  function routes(app, { requireUser, allowedApps, apps, usage }) {
    const target = (req, res) => {
      const slug = req.params.slug;
      if (!/^[a-z0-9-]+$/.test(slug) || !apps[slug]?.data || !allowedApps(req).includes(slug)) { res.status(404).json({ error: 'Introuvable.' }); return null; }
      return slug;
    };

    app.get('/api/appdata/:slug', requireUser, (req, res) => {
      const slug = target(req, res);
      if (!slug) return;
      const row = q.get.get(req.user.id, slug);
      res.set('Cache-Control', 'no-store');
      if (!row) return res.status(204).end();
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': row.size, ETag: `"${row.sha256}"`, 'X-Updated-At': row.updated_at });
      createReadStream(fileOf(req.user.id, slug)).on('error', () => res.destroy()).pipe(res);
    });

    // Corps reçu en flux vers un fichier temporaire, taille et quota vérifiés, puis renommage atomique.
    app.put('/api/appdata/:slug', requireUser, async (req, res, next) => {
      const slug = target(req, res);
      if (!slug) return;
      const previous = q.get.get(req.user.id, slug)?.size ?? 0;
      const { used, quota } = usage(req.user);
      const room = Math.min(APPDATA_MAX, quota - used + previous);
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > room) return res.status(declared > APPDATA_MAX ? 413 : 507).json({ error: declared > APPDATA_MAX ? 'Données trop volumineuses.' : 'Espace de stockage plein.' });
      const tmp = join(dir, `${randomUUID()}.tmp`);
      const hash = createHash('sha256');
      let size = 0;
      const out = createWriteStream(tmp, { flags: 'wx' });
      try {
        await new Promise((resolve, reject) => {
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > room) { req.destroy(); return reject(Object.assign(new Error(size > APPDATA_MAX ? 'Données trop volumineuses.' : 'Espace de stockage plein.'), { status: size > APPDATA_MAX ? 413 : 507 })); }
            hash.update(chunk);
            if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
          });
          req.on('end', resolve);
          req.on('error', reject);
          req.on('aborted', () => reject(Object.assign(new Error('Envoi interrompu.'), { status: 400 })));
        });
        await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
        if (!size) throw Object.assign(new Error('Données vides.'), { status: 400 });
        const sha256 = hash.digest('hex'), now = Date.now();
        await rename(tmp, fileOf(req.user.id, slug));
        q.set.run(req.user.id, slug, size, sha256, now);
        res.json({ ok: true, size, sha256, updatedAt: now });
      } catch (e) {
        out.destroy();
        await unlink(tmp).catch(() => {});
        if (e.status) return res.status(e.status).json({ error: e.message });
        next(e);
      }
    });

    app.delete('/api/appdata/:slug', requireUser, async (req, res) => {
      const slug = target(req, res);
      if (!slug) return;
      q.del.run(req.user.id, slug);
      await unlink(fileOf(req.user.id, slug)).catch(() => {});
      res.json({ ok: true });
    });
  }

  async function purgeUser(userId) {
    for (const { app } of q.ofUser.all(userId)) await unlink(fileOf(userId, app)).catch(() => {});
  }
  // Envois interrompus par un arrêt du serveur : seuls les fichiers temporaires sont retirés.
  for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) rmSync(join(dir, f), { force: true });
  return { routes, purgeUser };
}
