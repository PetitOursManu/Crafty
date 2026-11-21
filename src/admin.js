// Administration : comptes, droits d'applications, réglages, journal d'audit.
// Les règles sont dans createAdmin (service) ; deux interfaces s'en servent : les routes /api/admin/* (page d'administration)
// et l'admin dans Kosmy Board (src/kosmy-admin.js). Mêmes contrôles, mêmes effets, même journal.
import { checkCredentials } from './auth.js';
import { DEFAULT_SETTINGS } from './db.js';
import { listBackups } from './backup.js';

// Refus lisible : statut HTTP et message (en français, traduit à la sortie par src/i18n.js).
const err = (status, error) => Object.assign(new Error(error), { status, expose: true });

// actor : la requête de l'admin qui agit ({ user: { id, username }, ip, sessionHash }), pour les contrôles « soi-même » et le journal.
export function createAdmin({ db, auth, files, appData, log, apps, twofa, sso, backupDir }) {
  const q = {
    users: db.prepare(`SELECT u.id, u.username, u.role, u.disabled, u.must_change, u.all_apps, u.quota, u.created_at, u.last_login_at,
        u.locked_until, u.totp_enabled, u.dashy_sub, u.kosmy_sub, u.pass_hash, (SELECT IFNULL(SUM(size), 0) FROM versions v WHERE v.user_id = u.id) used,
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
  const validApps = (list) => Array.isArray(list) && list.every((s) => typeof s === 'string' && apps[s]);
  const userJson = (u) => ({ id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, mustChange: !!u.must_change,
    allApps: !!u.all_apps, apps: q.userApps.all(u.id).map((r) => r.slug), quota: u.quota, used: u.used, files: u.files,
    createdAt: u.created_at, lastLoginAt: u.last_login_at, locked: u.locked_until > Date.now(),
    twoFactor: !!u.totp_enabled, dashy: !!u.dashy_sub, kosmy: !!u.kosmy_sub, hasPassword: String(u.pass_hash).startsWith('scrypt$') });
  const setApps = (id, allApps, list) => {
    q.clearApps.run(id);
    if (!allApps) for (const s of list) q.addApp.run(id, s);
  };
  const listUsers = () => q.users.all().map(userJson);
  const userById = (id) => { const u = q.users.all().find((x) => x.id === id); return u ? userJson(u) : null; };

  async function createUser(actor, b = {}) {
    const { username, password, role = 'user', allApps = true, apps: list = [], quota = null } = b;
    const e = checkCredentials(username, password);
    if (e) throw err(400, e);
    if (!['admin', 'user'].includes(role)) throw err(400, 'Rôle invalide.');
    if (!allApps && !validApps(list)) throw err(400, 'Liste d\'applications invalide.');
    if (quota !== null && !(Number.isInteger(quota) && quota >= 0)) throw err(400, 'Quota invalide.');
    if (auth.userByName(username)) throw err(409, 'Cet identifiant existe déjà.');
    const id = Number(await auth.createUser({ username, password, role, mustChange: true, allApps: !!allApps }));
    setApps(id, !!allApps, list);
    if (quota !== null) db.prepare('UPDATE users SET quota = ? WHERE id = ?').run(quota, id);
    log.audit(actor, 'admin.user.create', String(id), { username, role, allApps: !!allApps, apps: list });
    return userById(id);
  }

  async function updateUser(actor, id, b = {}) {
    const u = q.user.get(Number(id));
    if (!u) throw err(404, 'Compte introuvable.');
    const self = u.id === actor.user.id;
    const losesAdmin = (b.role === 'user' || b.disabled === true) && u.role === 'admin' && !u.disabled;
    if (losesAdmin && q.admins.get().n <= 1) throw err(400, 'Il doit rester au moins un administrateur actif.');
    if (self && b.disabled === true) throw err(400, 'Vous ne pouvez pas désactiver votre propre compte.');
    if (b.role !== undefined && !['admin', 'user'].includes(b.role)) throw err(400, 'Rôle invalide.');
    if (b.allApps === false && !validApps(b.apps ?? [])) throw err(400, 'Liste d\'applications invalide.');
    if (b.quota !== undefined && b.quota !== null && !(Number.isInteger(b.quota) && b.quota >= 0)) throw err(400, 'Quota invalide.');
    if (b.password !== undefined) {
      const e = checkCredentials(u.username, b.password);
      if (e) throw err(400, e);
    }
    db.transaction(() => {
      if (b.role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
      if (b.disabled !== undefined) db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, u.id);
      if (b.quota !== undefined) db.prepare('UPDATE users SET quota = ? WHERE id = ?').run(b.quota, u.id);
      if (b.unlock) db.prepare('UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?').run(u.id);
      if (b.reset2fa) twofa.reset(u.id); // téléphone perdu, plus de code de secours
      if (b.unlinkDashy) db.prepare('UPDATE users SET dashy_sub = NULL WHERE id = ?').run(u.id);
      if (b.unlinkKosmy) db.prepare('UPDATE users SET kosmy_sub = NULL WHERE id = ?').run(u.id);
      if (b.allApps !== undefined) {
        db.prepare('UPDATE users SET all_apps = ? WHERE id = ?').run(b.allApps ? 1 : 0, u.id);
        setApps(u.id, !!b.allApps, b.apps ?? []);
      }
    })();
    if (b.password !== undefined) {
      // Mot de passe provisoire : changement obligatoire à la prochaine connexion, sessions fermées.
      await auth.changePassword({ sessionHash: self ? actor.sessionHash : '' }, u.id, b.password);
      db.prepare('UPDATE users SET must_change = ? WHERE id = ?').run(self ? 0 : 1, u.id);
    }
    if (b.disabled === true) q.killSessions.run(u.id);
    log.audit(actor, 'admin.user.update', String(u.id), { ...b, password: b.password !== undefined ? '(changé)' : undefined });
    return userById(u.id);
  }

  async function deleteUser(actor, id) {
    const u = q.user.get(Number(id));
    if (!u) throw err(404, 'Compte introuvable.');
    if (u.id === actor.user.id) throw err(400, 'Vous ne pouvez pas supprimer votre propre compte.');
    if (u.role === 'admin' && !u.disabled && q.admins.get().n <= 1) throw err(400, 'Il doit rester au moins un administrateur actif.');
    const blobs = await files.purgeUser(u.id);
    await appData?.purgeUser(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    log.audit(actor, 'admin.user.delete', String(u.id), { username: u.username, versions: blobs });
  }

  function patchSettings(actor, b = {}) {
    const patch = {};
    for (const k of ['signup_open', 'guest_enabled', 'sharing_enabled', 'sso_create_accounts']) if (b[k] !== undefined) patch[k] = !!b[k];
    if (b.guest_apps !== undefined) {
      if (b.guest_apps !== null && !validApps(b.guest_apps)) throw err(400, 'Liste d\'applications invalide.');
      patch.guest_apps = b.guest_apps;
    }
    for (const [k, min, max] of [['max_versions', 1, 100], ['default_quota', 0, 2 ** 50], ['max_file_size', 1, DEFAULT_SETTINGS.max_file_size], ['autosave_seconds', 0, 3600], ['trash_days', 0, 365]]) {
      if (b[k] === undefined) continue;
      if (!Number.isInteger(b[k]) || b[k] < min || b[k] > max) throw err(400, `Valeur invalide pour ${k}.`);
      patch[k] = b[k];
    }
    db.setSettings(patch);
    log.audit(actor, 'admin.settings', null, patch);
    return db.settings();
  }

  // État de l'exploitation : SSO Dashy, chiffrement des secrets, sauvegardes de la base.
  const system = async () => ({
    sso: { dashy: sso.enabled, dashyUrl: sso.dashyUrl, callback: sso.callback },
    secretsEncrypted: twofa.encrypted,
    backups: backupDir ? (await listBackups(backupDir)).slice(0, 20) : [],
    backupEveryHours: Number(process.env.BACKUP_EVERY_HOURS || 0),
  });

  const audit = (limit) => q.audit.all(Math.min(Math.max(Number(limit) || 200, 1), 1000));

  return { listUsers, userById, createUser, updateUser, deleteUser, settings: () => db.settings(), patchSettings, system, audit };
}

export function adminRoutes(app, { admin, auth, json, trustProxy, cookieSecure }) {
  const { requireAdmin } = auth;
  // Refus prévu (e.expose) : message au client ; sinon erreur interne (gestionnaire d'Express).
  const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) { if (e.expose) return res.status(e.status).json({ error: e.message }); next(e); }
  };

  app.get('/api/admin/users', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(admin.listUsers()));
  app.post('/api/admin/users', requireAdmin, json, wrap(async (req, res) => res.status(201).json(await admin.createUser(req, req.body || {}))));
  app.patch('/api/admin/users/:id', requireAdmin, json, wrap(async (req, res) => res.json(await admin.updateUser(req, req.params.id, req.body || {}))));
  app.delete('/api/admin/users/:id', requireAdmin, wrap(async (req, res) => { await admin.deleteUser(req, req.params.id); res.status(204).end(); }));

  app.get('/api/admin/settings', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(admin.settings()));
  app.patch('/api/admin/settings', requireAdmin, json, wrap((req, res) => res.json(admin.patchSettings(req, req.body || {}))));

  // Vérification de TRUST_PROXY (correction 4) en conditions réelles : l'adresse retenue doit être celle du visiteur.
  // Derrière Cloudflare, CF-Connecting-IP est l'adresse vue par Cloudflare ; sans proxy, la connexion directe.
  app.get('/api/admin/network', requireAdmin, (req, res) => {
    const hdr = (k) => (typeof req.headers[k] === 'string' ? req.headers[k].slice(0, 300) : null);
    const cf = hdr('cf-connecting-ip'), xff = hdr('x-forwarded-for');
    const norm = (ip) => String(ip || '').replace(/^::ffff:/, '');
    const verdict = cf ? (norm(req.ip) === norm(cf) ? 'ok' : 'cloudflare-mismatch')
      : xff ? (norm(req.ip) === norm(req.socket.remoteAddress) ? 'proxy-untrusted' : 'proxy')
      : 'direct';
    res.set('Cache-Control', 'no-store').json({
      ip: req.ip, ips: req.ips, socket: req.socket.remoteAddress, protocol: req.protocol, secure: req.secure,
      trustProxy: String(trustProxy ?? false), cookieSecure: !!cookieSecure,
      headers: { 'cf-connecting-ip': cf, 'x-forwarded-for': xff, 'x-forwarded-proto': hdr('x-forwarded-proto'),
        'x-forwarded-host': hdr('x-forwarded-host'), 'x-real-ip': hdr('x-real-ip') },
      verdict,
    });
  });

  app.get('/api/admin/system', requireAdmin, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await admin.system())));

  app.get('/api/admin/audit', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(admin.audit(req.query.limit)));
}
