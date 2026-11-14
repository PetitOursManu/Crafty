// Réglages des applications, par compte. Les applications gardent leurs préférences dans le localStorage du site
// (vérifié : clés pdfcraft, wordcraft.ui, egui_memory_ron…), donc partagées par tous les comptes d'un même navigateur.
// La page hôte remet les valeurs du compte avant de charger l'application et renvoie ici celles qui ont changé.
// Seules les clés déclarées (prefKeys dans apps.json) des applications autorisées au compte sont acceptées.
import express from 'express';

const MAX_VALUE = 512 * 1024;     // par clé
const MAX_TOTAL = 4 * 1024 * 1024; // par compte

export function prefsRoutes(app, { db, requireUser, allowedApps, apps }) {
  const q = {
    get: db.prepare('SELECT value FROM prefs WHERE user_id = ? AND key = ?'),
    set: db.prepare(`INSERT INTO prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
    del: db.prepare('DELETE FROM prefs WHERE user_id = ? AND key = ?'),
    total: db.prepare('SELECT IFNULL(SUM(LENGTH(value)), 0) n FROM prefs WHERE user_id = ? AND key != ?'),
  };
  const keysFor = (req) => new Set(allowedApps(req).flatMap((s) => apps[s].prefKeys || []));
  const json = express.json({ limit: '5mb' });

  app.get('/api/prefs', requireUser, (req, res) => {
    const allowed = keysFor(req);
    const keys = String(req.query.keys || '').split(',').filter((k) => allowed.has(k));
    res.set('Cache-Control', 'no-store').json({ values: Object.fromEntries(keys.map((k) => [k, q.get.get(req.user.id, k)?.value ?? null])) });
  });

  app.put('/api/prefs', requireUser, json, (req, res) => {
    const values = req.body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return res.status(400).json({ error: 'Format invalide.' });
    const allowed = keysFor(req);
    for (const [k, v] of Object.entries(values)) {
      if (!allowed.has(k)) return res.status(404).json({ error: `Clé inconnue : ${k}` });
      if (v !== null && (typeof v !== 'string' || v.length > MAX_VALUE)) return res.status(413).json({ error: `Réglage trop gros : ${k}` });
    }
    const now = Date.now();
    try {
      db.transaction(() => {
        for (const [k, v] of Object.entries(values)) {
          if (v === null) { q.del.run(req.user.id, k); continue; }
          if (q.total.get(req.user.id, k).n + v.length > MAX_TOTAL) throw Object.assign(new Error('Réglages trop volumineux.'), { status: 413 });
          q.set.run(req.user.id, k, v, now);
        }
      })();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    res.json({ ok: true });
  });
}
