// Assemblage du service : en-têtes, sessions, API (connexion, fichiers, administration), pages et applications.
import express from 'express';
import { existsSync, readFileSync, constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
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
import { sharesRoutes } from './shares.js';
import { i18nMiddleware } from './i18n.js';
import { createTwoFactor } from './twofactor.js';
import { createSso } from './sso.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/host.html': 'host.html', '/admin.html': 'admin.html' };

// Connexions persistantes gardées plus longtemps que celles du proxy (Traefik : 90 s par défaut) : avec les 5 s de Node,
// le serveur ferme parfois une connexion au moment où le client la réutilise (ECONNRESET, ou 502 derrière un proxy).
export function tuneServer(srv) {
  srv.keepAliveTimeout = 95_000;
  srv.headersTimeout = 96_000;
  return srv;
}

export function createApp({
  root = ROOT,
  vendorDir = join(root, 'vendor'),
  precompressedDir = process.env.PRECOMPRESSED_DIR || join(root, 'precompressed'),
  appsFile = process.env.APPS_FILE || join(root, 'apps.json'),
  dataDir = process.env.DATA_DIR || join(root, 'data'),
  dbFile = join(dataDir, 'craft.db'),
  csp = process.env.CSP ?? 'auto',
  trustProxy = process.env.TRUST_PROXY ?? false,
  cookieSecure = process.env.COOKIE_SECURE === '1',
  quiet = false,
  aiOptions = null, // essais : fetchImpl, secret (sinon CRAFTY_SECRET)
  twoFactorOptions = null, // essais : secret (sinon CRAFTY_SECRET)
  ssoOptions = null, // essais : secret, dashyUrl, origin (sinon SSO_SHARED_SECRET, SSO_DASHY_URL, PUBLIC_ORIGIN)
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
  const twofa = createTwoFactor({ db, log, auth, ...(twoFactorOptions || {}) });
  const sso = createSso({ db, log, auth, settings: db.settings, cookieSecure, ...(ssoOptions || {}) });
  files.cleanTmp();
  const st = createStatic({ apps, vendorDir, csp, precompressedDir });
  const json = express.json({ limit: '64kb' });

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  // Correction 4 : derrière Cloudflare + Traefik, TRUST_PROXY doit être réglé (nombre de sauts) et vérifié.
  app.set('trust proxy', /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy || false);
  app.locals.db = db;
  app.locals.files = files;
  app.locals.dataDir = dataDir;
  app.use(st.headers);
  app.use(auth.loadSession);
  app.use(i18nMiddleware); // messages d'erreur en anglais selon Accept-Language (src/i18n.js)
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

  // --- Santé (sonde du conteneur) : base lisible, dossier de données accessible en écriture, au moins une application ---
  app.get('/api/health', async (req, res) => {
    const checks = {};
    try { db.prepare('SELECT 1').get(); checks.db = true; } catch { checks.db = false; }
    try { if (dataDir !== ':memory:') await access(dataDir, fsConstants.W_OK); checks.data = true; } catch { checks.data = false; }
    checks.apps = Object.keys(apps).length;
    const ok = checks.db && checks.data && checks.apps > 0;
    res.status(ok ? 200 : 503).set('Cache-Control', 'no-store').json({ ok, ...checks });
  });

  // --- Connexion ---
  app.get('/api/auth/config', (req, res) => {
    const s = db.settings();
    res.set('Cache-Control', 'no-store').json({ setup: auth.userCount() === 0, signupOpen: !!s.signup_open, guestEnabled: !!s.guest_enabled,
      sso: { dashy: sso.enabled } });
  });
  app.post('/api/auth/login', json, async (req, res) => {
    const r = await auth.login(req, req.body?.username, req.body?.password);
    if (r.error) return res.status(r.status).json({ error: r.error });
    // Double authentification : pas encore de session, un ticket pour l'étape du code (src/twofactor.js).
    if (r.secondFactor) return res.set('Cache-Control', 'no-store').json({ twoFactor: true, ticket: twofa.startTicket(r.user) });
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
    const row = db.prepare('SELECT pass_hash, totp_enabled, dashy_sub FROM users WHERE id = ?').get(id);
    const account = { hasPassword: String(row.pass_hash).startsWith('scrypt$'), twoFactor: !!row.totp_enabled, dashy: !!row.dashy_sub, ssoDashy: sso.enabled };
    res.json({ user: { id, username, role, mustChange, theme, ...account }, apps: mustChange ? [] : allowedApps(req).map(appJson),
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
  sharesRoutes(app, { db, files, log, settings: db.settings, requireUser: auth.requireUser, json });
  ai.routes(app, { requireUser: auth.requireUser, requireAdmin: auth.requireAdmin, json: express.json({ limit: '8mb' }) });
  twofa.routes(app, { json, requireUser: auth.requireUser });
  sso.routes(app, { json });
  adminRoutes(app, { db, auth, files, appData, log, apps, json, trustProxy, cookieSecure, twofa, sso,
    backupDir: dataDir === ':memory:' ? null : (process.env.BACKUP_DIR || join(dataDir, 'backups')) });
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

  // --- Page publique d'un lien de partage (sans compte ; voir src/shares.js) ---
  app.get(/^\/s\/[A-Za-z0-9_-]{30,60}$/, async (req, res, next) => {
    try { res.set({ 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' }); return await st.sendStatic(req, res, join(root, 'public', 'share.html'), 'no-store'); }
    catch (e) { next(e); }
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
