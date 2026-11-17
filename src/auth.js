// Comptes et sessions. Motifs repris de Mocky avec les corrections de CLAUDE.md :
// 1. scrypt asynchrone, coût réglable (SCRYPT_N) ; 2. faux hachage si le compte n'existe pas ;
// 3. empreinte SHA-256 du jeton de session en base ; 4. IP via trust proxy ; 5. contrôle d'origine
// sur toute écriture (voir originCheck) ; 6. CSP (static.js).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
export const COOKIE = 'craft_sid';
const DAY = 86_400_000;
const SESSION_TTL = 90 * DAY, GUEST_TTL = DAY / 2;
export const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
export const PASSWORD_MIN = 8;

export async function hashPassword(password, N = Number(process.env.SCRYPT_N || 32768)) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, 64, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), want.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(got, want);
}
export const tokenHash = (t) => createHash('sha256').update(t).digest('hex');

// Limite simple par clé et par fenêtre fixe (en mémoire : suffit pour une instance unique).
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    return ++h.n <= max;
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth({ db, log, cookieSecure }) {
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    count: db.prepare('SELECT COUNT(*) n FROM users'),
    insertUser: db.prepare(`INSERT INTO users (username, pass_hash, role, must_change, all_apps, created_at)
      VALUES (@username, @pass_hash, @role, @must_change, @all_apps, @created_at)`),
    session: db.prepare(`SELECT s.*, u.id uid, u.username, u.role, u.disabled, u.must_change, u.all_apps, u.quota, u.theme
      FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
    insertSession: db.prepare(`INSERT INTO sessions (token_hash, user_id, guest, created_at, last_seen, expires_at, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    touch: db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    fail: db.prepare(`UPDATE users SET failed_count = failed_count + 1,
      locked_until = CASE WHEN failed_count + 1 >= 10 THEN ? ELSE locked_until END WHERE id = ?`),
    ok: db.prepare('UPDATE users SET failed_count = 0, locked_until = 0, last_login_at = ? WHERE id = ?'),
    setPass: db.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?'),
  };
  let dummy; // faux hachage, même coût que les vrais (correction 2)
  const dummyHash = async () => (dummy ??= await hashPassword(randomBytes(12).toString('hex')));
  const ipLimit = rateLimiter(8, 60_000);     // 8 tentatives par minute et par IP
  const createLimit = rateLimiter(5, 3_600_000); // créations de compte / sessions invité par IP et par heure
  const apiLimit = rateLimiter(600, 60_000);   // requêtes d'API par session et par minute
  setInterval(() => q.purge.run(Date.now()), 3_600_000).unref();

  function openSession(req, res, { userId = null, guest = false }) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now(), ttl = guest ? GUEST_TTL : SESSION_TTL;
    q.insertSession.run(tokenHash(token), userId, guest ? 1 : 0, now, now, now + ttl, req.ip);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: cookieSecure || req.secure, path: '/', maxAge: ttl });
    return token;
  }
  function closeSession(req, res) {
    if (req.sessionHash) q.delSession.run(req.sessionHash);
    res.clearCookie(COOKIE, { path: '/' });
  }

  // Charge la session (utilisateur ou invité) ; expiration glissante, mise à jour au plus une fois par heure.
  function loadSession(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return next();
    const h = tokenHash(token), s = q.session.get(h), now = Date.now();
    if (!s || s.expires_at < now || (s.user_id && (!s.uid || s.disabled))) {
      if (s) q.delSession.run(h);
      res.clearCookie(COOKIE, { path: '/' });
      return next();
    }
    if (!s.guest && now - s.last_seen > 3_600_000) q.touch.run(now, now + SESSION_TTL, h);
    req.sessionHash = h;
    if (s.guest) req.guest = true;
    else req.user = { id: s.uid, username: s.username, role: s.role, mustChange: !!s.must_change, allApps: !!s.all_apps, quota: s.quota, theme: s.theme };
    next();
  }

  // Correction 5 : une requête qui modifie quelque chose doit venir de la même origine.
  function originCheck(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    const self = `${req.protocol}://${req.headers.host}`;
    if ((site && site !== 'same-origin') || (origin && origin !== self) || (!site && !origin))
      return res.status(403).json({ error: 'Requête refusée (origine).' });
    next();
  }

  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
    if (!apiLimit(`s:${req.sessionHash}`)) return res.status(429).json({ error: 'Trop de requêtes.' });
    if (req.user.mustChange) return res.status(403).json({ error: 'Changez votre mot de passe.', mustChange: true });
    next();
  };
  const requireAdmin = (req, res, next) => requireUser(req, res, () =>
    req.user.role === 'admin' ? next() : res.status(404).json({ error: 'Introuvable.' }));

  async function login(req, username, password) {
    const ip = req.ip;
    if (!ipLimit(`login:${ip}`)) { log.auth('AUTH_RATELIMIT', { ip, user: username }); return { status: 429, error: 'Trop de tentatives, réessayez dans une minute.' }; }
    const u = typeof username === 'string' ? q.userByName.get(username) : undefined;
    const good = await verifyPassword(String(password ?? ''), u ? u.pass_hash : await dummyHash());
    const now = Date.now();
    if (u && u.locked_until > now) { log.auth('AUTH_LOCKED', { ip, user: username }); return { status: 423, error: 'Compte verrouillé pendant 15 minutes après trop d\'échecs.' }; }
    if (!u || !good) {
      if (u && u.locked_until && u.locked_until <= now) q.ok.run(u.last_login_at, u.id); // verrou expiré : on repart de zéro
      if (u) q.fail.run(now + 15 * 60_000, u.id);
      log.auth('AUTH_FAIL', { ip, user: username, reason: u ? 'password' : 'unknown_user' });
      return { status: 401, error: 'Identifiant ou mot de passe incorrect.' };
    }
    if (u.disabled) { log.auth('AUTH_FAIL', { ip, user: username, reason: 'disabled' }); return { status: 401, error: 'Identifiant ou mot de passe incorrect.' }; }
    // Double authentification : le compteur d'échecs n'est remis à zéro qu'après le code (sinon, chaque bon mot de passe
    // rouvrirait une série d'essais de codes).
    if (u.totp_enabled) { log.auth('AUTH_PASSWORD_OK', { ip, user: u.username }); return { user: u, secondFactor: true }; }
    q.ok.run(now, u.id);
    log.auth('AUTH_OK', { ip, user: u.username });
    return { user: u };
  }
  // Fin d'une connexion en deux étapes (code TOTP ou de secours) ; échec = un échec de connexion de plus (verrouillage à 10).
  function secondFactorOk(req, u) { q.ok.run(Date.now(), u.id); log.auth('AUTH_OK', { ip: req.ip, user: u.username }); }
  function secondFactorFail(req, u) {
    q.fail.run(Date.now() + 15 * 60_000, u.id);
    log.auth('AUTH_FAIL', { ip: req.ip, user: u.username, reason: 'totp' });
  }

  async function createUser({ username, password, role = 'user', mustChange = false, allApps = true }) {
    return q.insertUser.run({ username, pass_hash: await hashPassword(password), role, must_change: mustChange ? 1 : 0,
      all_apps: allApps ? 1 : 0, created_at: Date.now() }).lastInsertRowid;
  }
  async function changePassword(req, userId, password) {
    q.setPass.run(await hashPassword(password), userId);
    q.delUserSessions.run(userId, req.sessionHash ?? ''); // les autres sessions du compte sont fermées
  }
  const userCount = () => q.count.get().n;

  return { openSession, closeSession, loadSession, originCheck, requireUser, requireAdmin, login, createUser,
    changePassword, userCount, createLimit, ipLimit, secondFactorOk, secondFactorFail, userByName: (n) => q.userByName.get(n) };
}

export function checkCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return 'Identifiant : 3 à 32 caractères parmi lettres, chiffres, . _ -';
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > 256) return `Mot de passe : au moins ${PASSWORD_MIN} caractères.`;
  return null;
}
