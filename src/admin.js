// Administration : comptes, droits d'applications, réglages, journal d'audit.
import { checkCredentials } from './auth.js';
import { DEFAULT_SETTINGS } from './db.js';

export function adminRoutes(app, { db, auth, files, log, apps, json }) {
  const { requireAdmin } = auth;
  const q = {
    users: db.prepare(`SELECT u.id, u.username, u.role, u.disabled, u.must_change, u.all_apps, u.quota, u.created_at, u.last_login_at,
        u.locked_until, (SELECT IFNULL(SUM(size), 0) FROM versions v WHERE v.user_id = u.id) used,
        (SELECT COUNT(*) FROM files f WHERE f.user_id = u.id) files
      FROM users u ORDER BY u.username COLLATE NOCASE`),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    userApps: db.prepare('SELECT slug FROM user_apps WHERE user_id = ? ORDER BY slug'),
    clearApps: db.prepare('DELETE FROM user_apps WHERE user_id = ?'),
    addApp: db.prepare('INSERT OR IGNORE INTO user_apps (user_id, slug) VALUES (?, ?)'),
    admins: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0"),
    audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),
    killSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  };
  const bad = (res, error, status = 400) => res.status(status).json({ error });
  const validApps = (list) => Array.isArray(list) && list.every((s) => typeof s === 'string' && apps[s]);
  const userJson = (u) => ({ id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, mustChange: !!u.must_change,
    allApps: !!u.all_apps, apps: q.userApps.all(u.id).map((r) => r.slug), quota: u.quota, used: u.used, files: u.files,
    createdAt: u.created_at, lastLoginAt: u.last_login_at, locked: u.locked_until > Date.now() });
  const setApps = (id, allApps, list) => {
    q.clearApps.run(id);
    if (!allApps) for (const s of list) q.addApp.run(id, s);
  };

  app.get('/api/admin/users', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(q.users.all().map(userJson)));

  app.post('/api/admin/users', requireAdmin, json, async (req, res) => {
    const { username, password, role = 'user', allApps = true, apps: list = [], quota = null } = req.body || {};
    const e = checkCredentials(username, password);
    if (e) return bad(res, e);
    if (!['admin', 'user'].includes(role)) return bad(res, 'Rôle invalide.');
    if (!allApps && !validApps(list)) return bad(res, 'Liste d\'applications invalide.');
    if (quota !== null && !(Number.isInteger(quota) && quota >= 0)) return bad(res, 'Quota invalide.');
    if (auth.userByName(username)) return bad(res, 'Cet identifiant existe déjà.', 409);
    const id = Number(await auth.createUser({ username, password, role, mustChange: true, allApps: !!allApps }));
    setApps(id, !!allApps, list);
    if (quota !== null) db.prepare('UPDATE users SET quota = ? WHERE id = ?').run(quota, id);
    log.audit(req, 'admin.user.create', String(id), { username, role, allApps: !!allApps, apps: list });
    res.status(201).json(userJson(q.users.all().find((u) => u.id === id)));
  });

  app.patch('/api/admin/users/:id', requireAdmin, json, async (req, res) => {
    const u = q.user.get(Number(req.params.id));
    if (!u) return bad(res, 'Compte introuvable.', 404);
    const b = req.body || {};
    const self = u.id === req.user.id;
    const losesAdmin = (b.role === 'user' || b.disabled === true) && u.role === 'admin' && !u.disabled;
    if (losesAdmin && q.admins.get().n <= 1) return bad(res, 'Il doit rester au moins un administrateur actif.');
    if (self && b.disabled === true) return bad(res, 'Vous ne pouvez pas désactiver votre propre compte.');
    if (b.role !== undefined && !['admin', 'user'].includes(b.role)) return bad(res, 'Rôle invalide.');
    if (b.allApps === false && !validApps(b.apps ?? [])) return bad(res, 'Liste d\'applications invalide.');
    if (b.quota !== undefined && b.quota !== null && !(Number.isInteger(b.quota) && b.quota >= 0)) return bad(res, 'Quota invalide.');
    if (b.password !== undefined) {
      const e = checkCredentials(u.username, b.password);
      if (e) return bad(res, e);
    }
    db.transaction(() => {
      if (b.role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
      if (b.disabled !== undefined) db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, u.id);
      if (b.quota !== undefined) db.prepare('UPDATE users SET quota = ? WHERE id = ?').run(b.quota, u.id);
      if (b.unlock) db.prepare('UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?').run(u.id);
      if (b.allApps !== undefined) {
        db.prepare('UPDATE users SET all_apps = ? WHERE id = ?').run(b.allApps ? 1 : 0, u.id);
        setApps(u.id, !!b.allApps, b.apps ?? []);
      }
    })();
    if (b.password !== undefined) {
      // Mot de passe provisoire : changement obligatoire à la prochaine connexion, sessions fermées.
      await auth.changePassword({ sessionHash: self ? req.sessionHash : '' }, u.id, b.password);
      db.prepare('UPDATE users SET must_change = ? WHERE id = ?').run(self ? 0 : 1, u.id);
    }
    if (b.disabled === true) q.killSessions.run(u.id);
    log.audit(req, 'admin.user.update', String(u.id), { ...b, password: b.password !== undefined ? '(changé)' : undefined });
    res.json(userJson(q.users.all().find((x) => x.id === u.id)));
  });

  app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const u = q.user.get(Number(req.params.id));
    if (!u) return bad(res, 'Compte introuvable.', 404);
    if (u.id === req.user.id) return bad(res, 'Vous ne pouvez pas supprimer votre propre compte.');
    if (u.role === 'admin' && !u.disabled && q.admins.get().n <= 1) return bad(res, 'Il doit rester au moins un administrateur actif.');
    const blobs = await files.purgeUser(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    log.audit(req, 'admin.user.delete', String(u.id), { username: u.username, versions: blobs });
    res.status(204).end();
  });

  app.get('/api/admin/settings', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(db.settings()));
  app.patch('/api/admin/settings', requireAdmin, json, (req, res) => {
    const b = req.body || {}, patch = {};
    for (const k of ['signup_open', 'guest_enabled']) if (b[k] !== undefined) patch[k] = !!b[k];
    if (b.guest_apps !== undefined) {
      if (b.guest_apps !== null && !validApps(b.guest_apps)) return bad(res, 'Liste d\'applications invalide.');
      patch.guest_apps = b.guest_apps;
    }
    for (const [k, min, max] of [['max_versions', 1, 100], ['default_quota', 0, 2 ** 50], ['max_file_size', 1, DEFAULT_SETTINGS.max_file_size], ['autosave_seconds', 0, 3600]]) {
      if (b[k] === undefined) continue;
      if (!Number.isInteger(b[k]) || b[k] < min || b[k] > max) return bad(res, `Valeur invalide pour ${k}.`);
      patch[k] = b[k];
    }
    db.setSettings(patch);
    log.audit(req, 'admin.settings', null, patch);
    res.json(db.settings());
  });

  app.get('/api/admin/audit', requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.set('Cache-Control', 'no-store').json(q.audit.all(limit));
  });
}
