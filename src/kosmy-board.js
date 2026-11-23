// « Se connecter avec Kosmy Board » : Crafty client OpenID Connect de Kosmy Board (guide : docs/integration.md du Board).
// Convention Kosmy : lancement GET /auth/kosmy-board/login (bouton de la page de connexion, ou « Ouvrir » du Board avec
// iss et target_link_uri), retour GET /auth/kosmy-board/callback. state, nonce et PKCE S256 toujours ; le parcours en
// cours est gardé côté serveur (usage unique) et lié au navigateur par un cookie httpOnly (pas de login CSRF).
// Code échangé en client_secret_basic ; ID token vérifié ici sans dépendance : RS256 (clés de jwks_uri), iss, aud, exp, nonce.
// Comptes reliés par `sub` seulement, jamais par l'e-mail (le Board ne le vérifie pas) ; création automatique en option,
// désactivée par défaut, toujours en simple utilisateur. Exception : l'ID token porte kosmy_board_access (accès donné par un
// administrateur du Board, docs/users-api.md) → rôle et restrictions appliqués comme un PUT de src/kosmy-users.js, compte créé
// au besoin. Réglages en base (clé kosmy_board), secret chiffré par CRAFTY_SECRET.
// Exception assumée à « jamais d'état modifié en GET » : le retour du Board est une redirection (GET), comme pour Dashy.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySig } from 'node:crypto';
import { rateLimiter, USERNAME_RE, verifyPassword } from './auth.js';
import { makeSealer } from './secrets.js';

export const LOGIN_PATH = '/auth/kosmy-board/login';
export const CALLBACK_PATH = '/auth/kosmy-board/callback';
const FLOW_TTL = 10 * 60_000, CACHE_TTL = 60 * 60_000, MAX_FLOWS = 2000;
const DEFAULT_TARGET = '/';

const b64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const codeChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

// Émetteur saisi par l'admin : adresse http(s) sans paramètres ni « / » final ; '' si invalide.
export function normalizeIssuer(v) {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || u.search || u.hash || u.username || u.password) return '';
    return s;
  } catch { return ''; }
}

// Page où arriver après la connexion : une page de Crafty seulement (même origine), sinon l'accueil (pas de redirection ouverte).
export function safeTarget(target, base) {
  if (typeof target !== 'string' || !target) return DEFAULT_TARGET;
  try {
    const u = new URL(target, base);
    if (u.origin !== new URL(base).origin) return DEFAULT_TARGET;
    const path = u.pathname + u.search + u.hash;
    if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\') || u.pathname.startsWith('/login') || u.pathname.startsWith('/auth/')) return DEFAULT_TARGET;
    return path.slice(0, 500);
  } catch { return DEFAULT_TARGET; }
}

// Jeton du Board : en-tête et revendications lus, signature RS256 vérifiée avec la clé de jwks_uri désignée par kid.
function verifySigned(token, keys) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed');
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw new Error('malformed'); }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') throw new Error('malformed');
  if (header.alg !== 'RS256') throw new Error('algorithm');
  const jwk = keys.find((k) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (!jwk) throw new Error('key');
  let key;
  try { key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }); } catch { throw new Error('key'); }
  if (!verifySig('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw new Error('signature');
  return { header, claims };
}
// Type de jeton (en-tête typ), comparé sans casse et sans le préfixe « application/ » (RFC 7515 § 4.1.9).
const typOf = (header) => String(header.typ ?? '').toLowerCase().replace(/^application\//, '');
export const ADMIN_TYP = 'kb-admin+jwt';

// ID token : signature, iss, aud (= identifiant client), exp, nonce. Un jeton d'admin du Board n'est jamais un ID token.
export function verifyIdToken(token, { keys, issuer, clientId, nonce, now = Date.now() }) {
  const { header, claims } = verifySigned(token, keys);
  if (typOf(header) === ADMIN_TYP) throw new Error('type');
  if (claims.iss !== issuer) throw new Error('issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId) || (aud.length > 1 && claims.azp !== clientId)) throw new Error('audience');
  const sec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < sec - 30) throw new Error('expired');
  if (typeof claims.iat === 'number' && claims.iat > sec + 120) throw new Error('expired');
  if (!sameText(claims.nonce, nonce)) throw new Error('nonce');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 200) throw new Error('claims');
  return claims;
}

// Jeton de l'admin dans le Board (docs/admin-api.md du Board) : signature RS256, typ kb-admin+jwt, iss, aud, exp (30 s de
// tolérance), âge de 2 min au plus, htm = méthode, chemin de htu terminé par le chemin demandé. Le jti (usage unique) est
// vérifié par l'appelant, qui garde les jti reçus.
export function verifyAdminToken(token, { keys, issuer, clientId, method, path, now = Date.now() }) {
  const { header, claims } = verifySigned(token, keys);
  if (typOf(header) !== ADMIN_TYP) throw new Error('type');
  if (claims.iss !== issuer) throw new Error('issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('audience');
  const sec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < sec - 30) throw new Error('expired');
  if (typeof claims.iat !== 'number' || claims.iat > sec + 30 || claims.iat < sec - 150) throw new Error('expired');
  if (claims.htm !== method) throw new Error('htm');
  let htuPath = null;
  try { const u = new URL(claims.htu); if (['http:', 'https:'].includes(u.protocol)) htuPath = u.pathname; } catch {}
  if (!htuPath || !htuPath.endsWith(path)) throw new Error('htu');
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 200) throw new Error('jti');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 200) throw new Error('claims');
  return claims;
}

// Identifiant Crafty tiré du nom (ou de l'adresse) donné par le Board, rendu unique (taken : identifiant déjà pris ?).
export function usernameFor(claims, taken) {
  let base = String(claims.name || String(claims.email || claims.preferred_username || '').split('@')[0] || '').normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 28);
  if (base.length < 3) base = `kosmy-${base}`.slice(0, 28);
  let name = base, n = 2;
  while (taken(name)) name = `${base}${n++}`;
  return USERNAME_RE.test(name) ? name : `kosmy-${randomBytes(4).toString('hex')}`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

// boardUsers : utilisateurs gérés par le Board (src/kosmy-users.js), pour appliquer kosmy_board_access à la connexion.
export function createKosmyBoard({ db, log, auth, cookieSecure = false, origin = process.env.PUBLIC_ORIGIN || '',
  secret = process.env.CRAFTY_SECRET || '', fetchImpl = globalThis.fetch, boardUsers = null }) {
  origin = String(origin).replace(/\/+$/, '');
  const sealer = makeSealer(secret, 'crafty-kosmy-board');
  const getRow = db.prepare("SELECT value FROM settings WHERE key = 'kosmy_board'");
  const setRow = db.prepare("INSERT INTO settings (key, value) VALUES ('kosmy_board', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const q = {
    bySub: db.prepare('SELECT * FROM users WHERE kosmy_sub = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byName: db.prepare('SELECT 1 FROM users WHERE username = ?'),
    insert: db.prepare(`INSERT INTO users (username, pass_hash, role, must_change, all_apps, created_at, kosmy_sub)
      VALUES (?, '!kosmy', 'user', 0, 1, ?, ?)`),
    link: db.prepare('UPDATE users SET kosmy_sub = ? WHERE id = ? AND kosmy_sub IS NULL'),
    unlink: db.prepare('UPDATE users SET kosmy_sub = NULL WHERE id = ?'),
    login: db.prepare('UPDATE users SET failed_count = 0, locked_until = 0, last_login_at = ? WHERE id = ?'),
  };
  const startLimit = rateLimiter(30, 60_000), backLimit = rateLimiter(30, 60_000), unlinkLimit = rateLimiter(8, 60_000);
  const flows = new Map(); // state → { verifier, nonce, issuer, target, mode, userId, exp }
  let discovery = null, jwks = null;

  // Réglages : { issuer, clientId, secret (scellé), createAccounts }.
  const config = () => {
    let c = {};
    try { c = JSON.parse(getRow.get()?.value || '{}'); } catch {}
    return { issuer: c.issuer || '', clientId: c.clientId || '', secret: c.secret || '', createAccounts: !!c.createAccounts };
  };
  const enabled = (c = config()) => !!(c.issuer && c.clientId && c.secret);
  // Adresse publique de Crafty : PUBLIC_ORIGIN, sinon celle de la requête (le Board n'accepte que l'adresse de retour enregistrée).
  const baseOf = (req) => origin || `${req.protocol}://${req.get('host')}`;
  const secure = (req) => cookieSecure || req.secure || origin.startsWith('https://');
  const cookieName = (req) => (secure(req) ? '__Host-craft_kosmy' : 'craft_kosmy');

  async function getJson(url, init) {
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json', ...(init?.headers || {}) } });
    let data = null;
    try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  }
  async function discover(issuer) {
    if (discovery?.issuer === issuer && discovery.at > Date.now() - CACHE_TTL) return discovery.doc;
    const r = await getJson(`${issuer}/.well-known/openid-configuration`);
    if (!r.ok || !r.data) throw new Error(`discovery ${r.status}`);
    if (r.data.issuer !== issuer) throw new Error('discovery issuer');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (typeof r.data[k] !== 'string') throw new Error(`discovery ${k}`);
    discovery = { issuer, doc: r.data, at: Date.now() };
    return r.data;
  }
  // Clés publiques du Board ; rechargées si le kid est inconnu (rotation), au plus une fois par minute.
  async function signingKeys(uri, kid) {
    const fresh = jwks?.uri === uri && jwks.at > Date.now() - CACHE_TTL;
    const known = fresh && (!kid || jwks.keys.some((k) => k.kid === kid));
    if (!known && !(fresh && jwks.at > Date.now() - 60_000)) {
      const r = await getJson(uri);
      if (!r.ok || !Array.isArray(r.data?.keys)) throw new Error(`jwks ${r.status}`);
      jwks = { uri, keys: r.data.keys, at: Date.now() };
    }
    return jwks.keys;
  }

  // Début du parcours : state, nonce et vérificateur PKCE gardés ici ; cookie qui lie le parcours à ce navigateur.
  async function begin(req, res, { mode, target, userId = null }) {
    const c = config();
    const d = await discover(c.issuer);
    const now = Date.now();
    for (const [k, f] of flows) if (f.exp < now) flows.delete(k);
    while (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value);
    const state = randomBytes(24).toString('base64url'), nonce = randomBytes(24).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    flows.set(state, { verifier, nonce, issuer: c.issuer, target, mode, userId, exp: now + FLOW_TTL });
    res.cookie(cookieName(req), state, { httpOnly: true, sameSite: 'lax', secure: secure(req), path: '/', maxAge: FLOW_TTL });
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: `${baseOf(req)}${CALLBACK_PATH}`,
      scope: 'openid profile email', state, nonce, code_challenge: codeChallenge(verifier), code_challenge_method: 'S256' }).toString();
    return u.href;
  }

  function routes(app, { json, requireUser, requireAdmin }) {
    const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });

    // 1. Lancement : bouton de la page de connexion, ou « Ouvrir » du Board (connexion initiée par un tiers).
    app.get(LOGIN_PATH, async (req, res) => {
      noStore(res);
      const c = config();
      if (!enabled(c)) return res.redirect(302, '/login.html?kosmy=not-configured');
      if (!startLimit(`kb:${req.ip}`)) return res.redirect(302, '/login.html?kosmy=ratelimit');
      const iss = typeof req.query.iss === 'string' ? req.query.iss : null;
      if (iss !== null && iss.replace(/\/+$/, '') !== c.issuer) {
        log.auth('AUTH_FAIL', { ip: req.ip, reason: 'kosmy_issuer' });
        return res.redirect(302, '/login.html?kosmy=issuer');
      }
      const target = safeTarget(typeof req.query.target_link_uri === 'string' ? req.query.target_link_uri : '', baseOf(req));
      try { res.redirect(302, await begin(req, res, { mode: 'login', target })); }
      catch (e) { console.error('Kosmy Board :', e.message); res.redirect(302, '/login.html?kosmy=unreachable'); }
    });

    // Relier le compte connecté (par mot de passe) à un compte Kosmy Board : POST, donc contrôle d'origine.
    app.post('/api/auth/kosmy-board/link', requireUser, async (req, res) => {
      noStore(res);
      if (!enabled()) return res.status(404).json({ error: 'Introuvable.' });
      if (!startLimit(`kb:${req.ip}`)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans une minute.' });
      try { res.json({ url: await begin(req, res, { mode: 'link', target: '/', userId: req.user.id }) }); }
      catch (e) { console.error('Kosmy Board :', e.message); res.status(502).json({ error: 'Kosmy Board ne répond pas : réessayez plus tard.' }); }
    });

    // Défaire le lien : le mot de passe Crafty est demandé (un compte sans mot de passe ne peut pas se délier lui-même).
    app.post('/api/auth/kosmy-board/unlink', requireUser, json, async (req, res) => {
      if (!unlinkLimit(`kbu:${req.ip}`)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans une minute.' });
      const u = q.byId.get(req.user.id);
      if (!u.kosmy_sub) return res.status(400).json({ error: 'Ce compte n\'est pas relié à Kosmy Board.' });
      if (!String(u.pass_hash).startsWith('scrypt$')) return res.status(400).json({ error: 'Ce compte n\'a pas de mot de passe : demandez à l\'administrateur.' });
      if (!(await verifyPassword(String(req.body?.password ?? ''), u.pass_hash))) {
        log.auth('AUTH_FAIL', { ip: req.ip, user: u.username, reason: 'kosmy_unlink' });
        return res.status(400).json({ error: 'Mot de passe incorrect.' });
      }
      q.unlink.run(u.id);
      log.audit(req, 'auth.kosmy.unlink');
      res.json({ ok: true });
    });

    // 3. Retour du Board.
    app.get(CALLBACK_PATH, async (req, res) => {
      noStore(res);
      const name = cookieName(req), cookieState = parseCookies(req.headers.cookie)[name] || '';
      res.clearCookie(name, { path: '/', secure: secure(req), sameSite: 'lax', httpOnly: true });
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const flow = sameText(state, cookieState) ? flows.get(state) : null;
      if (flow) flows.delete(state); // usage unique
      const back = (code) => res.redirect(302, flow?.mode === 'link' ? `/?kosmy=${code}` : `/login.html?kosmy=${code}`);
      const fail = (code, user) => { log.auth('AUTH_FAIL', { ip: req.ip, user, reason: `kosmy_${code}` }); return back(code); };
      if (!backLimit(`kbb:${req.ip}`)) return back('ratelimit');
      if (!flow || flow.exp < Date.now()) return fail('state');
      if (typeof req.query.error === 'string') return fail(req.query.error === 'access_denied' ? 'denied' : 'error');
      const c = config();
      if (!enabled(c) || c.issuer !== flow.issuer) return fail('not-configured');
      // RFC 9207 : la réponse vient de l'émetteur attendu.
      if (req.query.iss !== undefined && req.query.iss !== c.issuer) return fail('issuer');
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) return fail('error');

      let claims;
      try {
        const d = await discover(c.issuer);
        const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
        const tr = await getJson(d.token_endpoint, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${enc(c.clientId)}:${enc(sealer.open(c.secret))}`).toString('base64')}` },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${baseOf(req)}${CALLBACK_PATH}`, code_verifier: flow.verifier }).toString() });
        if (!tr.ok || typeof tr.data?.id_token !== 'string') {
          console.error('Kosmy Board : échange du code refusé', tr.status, tr.data?.error || '');
          return fail(tr.data?.error === 'invalid_client' ? 'client' : 'exchange');
        }
        let kid;
        try { kid = b64urlJson(tr.data.id_token.split('.')[0]).kid; } catch {}
        claims = verifyIdToken(tr.data.id_token, { keys: await signingKeys(d.jwks_uri, kid), issuer: c.issuer, clientId: c.clientId, nonce: flow.nonce });
      } catch (e) {
        if (/^(malformed|algorithm|key|signature|type|issuer|audience|expired|nonce|claims)$/.test(e.message)) return fail('token');
        console.error('Kosmy Board :', e.message);
        return fail('unreachable');
      }
      const sub = claims.sub, email = typeof claims.email === 'string' ? claims.email.slice(0, 200) : undefined;

      if (flow.mode === 'link') {
        if (!req.user || req.user.id !== flow.userId) return back('session');
        const owner = q.bySub.get(sub);
        if (owner && owner.id !== req.user.id) return back('linked-elsewhere');
        if (!owner && q.link.run(sub, req.user.id).changes === 0) return back('already-linked');
        log.audit(req, 'auth.kosmy.link', null, { email });
        return res.redirect(302, '/?kosmy=linked');
      }

      let u = q.bySub.get(sub), created = false;
      // Un compte désactivé (accès retiré dans le Board, ou par un admin de Crafty) ne se connecte pas, même avec un accès.
      if (u?.disabled) return fail('disabled', u.username);
      const access = claims.kosmy_board_access;
      if (access !== undefined && access !== null && boardUsers) {
        // Accès géré par le Board (docs/users-api.md du Board) : appliqué comme un PUT, compte créé s'il n'existe pas encore,
        // jamais de liaison par l'e-mail ici.
        try {
          const r = await boardUsers.provision({ ip: req.ip, via: 'kosmy-board' }, sub,
            { name: claims.name, email: claims.email, role: access?.role, values: access?.values }, { atLogin: true });
          u = q.byId.get(r.id);
          created = r.status === 'created';
        } catch (e) {
          if (!e.status) throw e;
          return fail('access', u?.username ?? email);
        }
      } else if (!u) {
        if (!c.createAccounts) return fail('no-account', email);
        const id = Number(q.insert.run(usernameFor(claims, (n) => !!q.byName.get(n)), Date.now(), sub).lastInsertRowid); // jamais administrateur
        u = q.byId.get(id);
        created = true;
      }
      if (u.disabled) return fail('disabled', u.username);
      q.login.run(Date.now(), u.id);
      auth.openSession(req, res, { userId: u.id });
      log.auth('AUTH_OK', { ip: req.ip, user: u.username, reason: 'kosmy-board' });
      req.user = { id: u.id, username: u.username };
      log.audit(req, created ? 'auth.kosmy.create' : 'auth.kosmy', null, { email, ...(access && boardUsers ? { role: u.role } : {}) });
      res.redirect(302, flow.target || DEFAULT_TARGET);
    });

    app.get('/api/admin/kosmy-board', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(adminJson(req)));
    app.put('/api/admin/kosmy-board', requireAdmin, json, (req, res) => {
      try { res.json(saveSettings(req, req.body || {})); }
      catch (e) { if (!e.expose) throw e; res.status(e.status).json({ error: e.message }); }
    });
  }

  // Administration : réglages à coller depuis le Board, adresses à donner au Board. Le secret n'est jamais renvoyé.
  const adminJson = (req) => {
    const c = config(), base = baseOf(req);
    return { enabled: enabled(c), issuer: c.issuer, clientId: c.clientId, hasSecret: !!c.secret, createAccounts: c.createAccounts,
      redirectUri: `${base}${CALLBACK_PATH}`, loginUri: `${base}${LOGIN_PATH}`, secretsEncrypted: sealer.encrypted, publicOrigin: !!origin };
  };
  const err = (status, error) => Object.assign(new Error(error), { status, expose: true });
  function saveSettings(req, b) {
    const c = config();
    const issuer = b.issuer === undefined ? c.issuer : normalizeIssuer(b.issuer);
    if (b.issuer !== undefined && String(b.issuer).trim() && !issuer) throw err(400, 'Émetteur invalide : adresse http(s) attendue.');
    const clientId = b.clientId === undefined ? c.clientId : String(b.clientId).trim();
    if (clientId.length > 200) throw err(400, 'Identifiant client invalide.');
    let sealed = c.secret;
    if (b.clearSecret === true) sealed = '';
    else if (typeof b.clientSecret === 'string' && b.clientSecret.trim()) {
      if (b.clientSecret.trim().length > 500) throw err(400, 'Secret client invalide.');
      sealed = sealer.seal(b.clientSecret.trim());
    }
    const createAccounts = b.createAccounts === undefined ? c.createAccounts : b.createAccounts === true;
    setRow.run(JSON.stringify({ issuer, clientId, secret: sealed, createAccounts }));
    if (issuer !== c.issuer) { discovery = null; jwks = null; flows.clear(); }
    log.audit(req, 'admin.kosmy', null, { issuer, clientId, secret: sealed !== c.secret ? '(changé)' : undefined, createAccounts });
    return adminJson(req);
  }

  // Admin dans le Board : jeton vérifié avec les réglages, la découverte et les clés de la connexion unique ; jti à usage
  // unique, gardés en mémoire jusqu'à leur expiration. Renvoie { claims, user } (user : compte relié par sub, ou null).
  // Erreurs : 'not-configured', 'unreachable' (découverte ou clés), ou le motif du refus du jeton.
  const seenJti = new Map(); // jti → fin de validité (ms)
  async function adminIdentity(token, { method, path }) {
    const c = config();
    if (!enabled(c)) throw new Error('not-configured');
    let kid, keys;
    try { kid = b64urlJson(String(token).split('.')[0])?.kid; } catch {}
    try { keys = await signingKeys((await discover(c.issuer)).jwks_uri, kid); }
    catch (e) { console.error('Kosmy Board :', e.message); throw new Error('unreachable'); }
    const claims = verifyAdminToken(token, { keys, issuer: c.issuer, clientId: c.clientId, method, path });
    const now = Date.now();
    for (const [k, exp] of seenJti) if (exp < now) seenJti.delete(k);
    if (seenJti.has(claims.jti)) throw new Error('replay');
    seenJti.set(claims.jti, (claims.exp + 30) * 1000);
    return { claims, user: q.bySub.get(claims.sub) || null };
  }

  return { routes, enabled: () => enabled(), adminJson, saveSettings, adminIdentity };
}
