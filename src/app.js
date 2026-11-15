// Assemblage du service : en-têtes, sessions, API (connexion, fichiers, administration), pages et applications.
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createLogger } from './log.js';
import { createAuth, checkCredentials, verifyPassword } from './auth.js';
import { createStatic, notFound, safeFile } from './static.js';
import { createFiles } from './files.js';
import { adminRoutes } from './admin.js';
import { prefsRoutes } from './prefs.js';
import { createAppData } from './appdata.js';
import { createAi } from './ai.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/host.html': 'host.html', '/admin.html': 'admin.html' };

export function createApp({
  root = ROOT,
  vendorDir = join(root, 'vendor'),
  appsFile = process.env.APPS_FILE || join(root, 'apps.json'),
  dataDir = process.env.DATA_DIR || join(root, 'data'),
  dbFile = join(dataDir, 'craft.db'),
  csp = process.env.CSP ?? 'auto',
  trustProxy = process.env.TRUST_PROXY ?? false,
  cookieSecure = process.env.COOKIE_SECURE === '1',
  quiet = false,
  aiOptions = null, // essais : fetchImpl, secret (sinon CRAFTY_SECRET)
} = {}) {
  const registry = JSON.parse(readFileSync(appsFile, 'utf8'));
  // Seules les applications activées et réellement présentes dans vendor/ sont proposées.
  // enabled: false (défaut de fetch-app pour une nouvelle application) tant qu'elle n'a pas passé les essais.
  const apps = Object.fromEntries(Object.entries(registry).filter(([slug, a]) => a.enabled !== false && existsSync(join(vendorDir, slug, a.version, 'index.html'))));
  const db = openDb(dbFile);
  const log = createLogger({ authLogFile: dataDir === ':memory:' ? null : join(dataDir, 'logs', 'auth.log'), db, quiet });
  const auth = createAuth({ db, log, cookieSecure });
  const files = createFiles({ db, dataDir, log, settings: db.settings });
  const appData = createAppData({ db, dataDir });
  const ai = createAi({ db, log, ...(aiOptions || {}) });
  files.cleanTmp();
  const st = createStatic({ apps, vendorDir, csp });
  const json = express.json({ limit: '64kb' });

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  // Correction 4 : derrière Cloudflare + Traefik, TRUST_PROXY doit être réglé (nombre de sauts) et vérifié.
  app.set('trust proxy', /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy || false);
  app.locals.db = db;
  app.use(st.headers);
  app.use(auth.loadSession);
  app.use('/api', auth.originCheck);

  // Applications autorisées : invité → réglage guest_apps ; compte → toutes, ou la liste choisie par l'admin.
  const userApps = db.prepare('SELECT slug FROM user_apps WHERE user_id = ?');
  function allowedApps(req) {
    if (req.guest) { const g = db.settings().guest_apps; return Object.keys(apps).filter((s) => !g || g.includes(s)); }
    if (!req.user) return [];
    if (req.user.role === 'admin' || req.user.allApps) return Object.keys(apps);
    const mine = new Set(userApps.all(req.user.id).map((r) => r.slug));
    return Object.keys(apps).filter((s) => mine.has(s));
  }
  const appJson = (slug) => ({ slug, name: apps[slug].name || slug, description: apps[slug].description || '',
    version: apps[slug].version, extensions: apps[slug].extensions || [], imports: apps[slug].imports || [],
    prefKeys: apps[slug].prefKeys || [], control: apps[slug].control || {}, mode: apps[slug].mode || 'bridge',
    data: apps[slug].data || null, tools: apps[slug].tools || [] });

  // --- Connexion ---
  app.get('/api/auth/config', (req, res) => {
    const s = db.settings();
    res.set('Cache-Control', 'no-store').json({ setup: auth.userCount() === 0, signupOpen: !!s.signup_open, guestEnabled: !!s.guest_enabled });
  });
  app.post('/api/auth/login', json, async (req, res) => {
    const r = await auth.login(req, req.body?.username, req.body?.password);
    if (r.error) return res.status(r.status).json({ error: r.error });
    auth.openSession(req, res, { userId: r.user.id });
    req.user = { id: r.user.id, username: r.user.username };
    log.audit(req, 'auth.login');
    res.json({ ok: true, mustChange: !!r.user.must_change });
  });
  app.post('/api/auth/register', json, async (req, res) => {
    const setup = auth.userCount() === 0;
    if (!setup && !db.settings().signup_open) return res.status(403).json({ error: 'Les inscriptions sont fermées.' });
    if (!auth.createLimit(`create:${req.ip}`)) return res.status(429).json({ error: 'Trop de comptes créés depuis cette adresse.' });
    const { username, password } = req.body || {};
    const e = checkCredentials(username, password);
    if (e) return res.status(400).json({ error: e });
    if (auth.userByName(username)) return res.status(409).json({ error: 'Cet identifiant existe déjà.' });
    // Le premier compte devient administrateur ; l'inscription publique reste fermée par défaut.
    const id = Number(await auth.createUser({ username, password, role: 'user' }));
    // Deux inscriptions simultanées sur une base vide : seul le plus ancien compte devient administrateur.
    if (setup) db.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND id = (SELECT MIN(id) FROM users)").run(id);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id);
    log.auth('AUTH_REGISTER', { ip: req.ip, user: username });
    auth.openSession(req, res, { userId: id });
    req.user = { id, username };
    log.audit(req, setup ? 'auth.setup' : 'auth.register');
    res.status(201).json({ ok: true });
  });
  app.post('/api/auth/guest', (req, res) => {
    if (!db.settings().guest_enabled) return res.status(403).json({ error: 'Le mode invité est désactivé.' });
    if (!auth.createLimit(`create:${req.ip}`)) return res.status(429).json({ error: 'Trop de sessions invitées depuis cette adresse.' });
    auth.openSession(req, res, { guest: true });
    log.auth('AUTH_GUEST', { ip: req.ip });
    res.json({ ok: true });
  });
  app.post('/api/auth/logout', (req, res) => {
    if (req.user) log.audit(req, 'auth.logout');
    auth.closeSession(req, res);
    res.json({ ok: true });
  });
  app.post('/api/auth/password', json, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
    const { current, password } = req.body || {};
    const row = auth.userByName(req.user.username);
    if (!(await verifyPassword(String(current ?? ''), row.pass_hash))) {
      log.auth('AUTH_FAIL', { ip: req.ip, user: req.user.username, reason: 'password_change' });
      return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
    }
    const e = checkCredentials(req.user.username, password);
    if (e) return res.status(400).json({ error: e });
    if (password === current) return res.status(400).json({ error: 'Choisissez un mot de passe différent.' });
    await auth.changePassword(req, req.user.id, password);
    log.audit(req, 'auth.password');
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.guest) return res.json({ guest: true, apps: allowedApps(req).map(appJson) });
    if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
    const { id, username, role, mustChange, theme } = req.user;
    res.json({ user: { id, username, role, mustChange, theme }, apps: mustChange ? [] : allowedApps(req).map(appJson),
      usage: files.usage(req.user), autosave: db.settings().autosave_seconds });
  });
  app.patch('/api/me', auth.requireUser, json, (req, res) => {
    if (!['light', 'dark', 'system'].includes(req.body?.theme)) return res.status(400).json({ error: 'Thème invalide.' });
    db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(req.body.theme, req.user.id);
    res.json({ ok: true });
  });

  files.routes(app, auth.requireUser, json);
  prefsRoutes(app, { db, requireUser: auth.requireUser, allowedApps, apps });
  appData.routes(app, { requireUser: auth.requireUser, allowedApps, apps, usage: files.usage });
  ai.routes(app, { requireUser: auth.requireUser, requireAdmin: auth.requireAdmin, json: express.json({ limit: '8mb' }) });
  adminRoutes(app, { db, auth, files, appData, log, apps, json });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Introuvable.' }));

  // --- Applications : session obligatoire et application autorisée, sinon 404 ---
  app.get(/^\/apps\/([a-z0-9-]+)$/, (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect(301, `/apps/${req.params[0]}/${q >= 0 ? req.originalUrl.slice(q) : ''}`);
  });
  app.get(/^\/apps\/([a-z0-9-]+)\/(.*)$/, async (req, res, next) => {
    try {
      const slug = req.path.split('/')[2], a = apps[slug];
      if (!a || (req.user?.mustChange) || !allowedApps(req).includes(slug)) return notFound(res);
      const f = safeFile(resolve(vendorDir, slug, a.version), req.path.slice(`/apps/${slug}/`.length), 'index.html');
      if (!f) return notFound(res);
      return await st.sendStatic(req, res, f.file, st.immutable(f.rel));
    } catch (e) { next(e); }
  });

  // --- Pages : connexion obligatoire, sinon /login.html ---
  app.get(/^\/(.*)$/, async (req, res, next) => {
    try {
      const page = PAGES[req.path];
      if (page) {
        const back = encodeURIComponent(req.originalUrl);
        if (!req.user && !req.guest) return res.redirect(302, `/login.html?next=${back}`);
        if (req.user?.mustChange) return res.redirect(302, `/login.html?change=1&next=${back}`);
        if (page === 'admin.html' && req.user?.role !== 'admin') return res.redirect(302, '/');
        return await st.sendStatic(req, res, join(root, 'public', page), 'no-store');
      }
      const f = safeFile(resolve(root, 'public'), req.path.slice(1), 'index.html');
      if (!f || Object.values(PAGES).includes(f.rel)) return notFound(res);
      return await st.sendStatic(req, res, f.file, 'no-cache');
    } catch (e) { next(e); }
  });
  return app;
}
