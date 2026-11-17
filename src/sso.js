// Connexion unique avec Dashy (repris de Mocky, server/index.js « SSO ») : Dashy authentifie la personne (sa propre
// double authentification comprise), signe un jeton HS256 de 60 s avec le secret partagé et renvoie le navigateur sur
// /sso/dashy/callback?token=…&state=…. Vérifications : signature (temps constant), alg HS256, iss "dashy", aud = notre
// origine publique (PUBLIC_ORIGIN, jamais déduite de la requête), exp, identité ; jti à usage unique (table sso_jti).
// Différences avec Mocky : le state est vérifié par le SERVEUR (cookie httpOnly, préfixe __Host- en HTTPS, que les autres
// sous-domaines ne peuvent pas poser), ce qui empêche de connecter quelqu'un au compte d'un autre (login CSRF) ; un compte
// Crafty existant peut être lié à son identité Dashy ; le rôle n'est fixé qu'à la création du compte.
// Exception assumée à la règle « jamais d'état modifié en GET » : le retour de Dashy est une redirection (GET).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rateLimiter, USERNAME_RE } from './auth.js';

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const STATE_TTL = 10 * 60_000;

export function verifyDashyToken(token, { secret, audience, now = Date.now() }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed');
  let header, claims;
  try { header = JSON.parse(b64url(parts[0]).toString('utf8')); } catch { throw new Error('malformed'); }
  if (header.alg !== 'HS256') throw new Error('algorithm');
  const sig = b64url(parts[2]);
  const want = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) throw new Error('signature');
  try { claims = JSON.parse(b64url(parts[1]).toString('utf8')); } catch { throw new Error('malformed'); }
  if (claims.iss !== 'dashy') throw new Error('issuer');
  if (claims.aud !== audience) throw new Error('audience');
  const sec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < sec) throw new Error('expired');
  if (typeof claims.iat === 'number' && claims.iat > sec + 60) throw new Error('expired');
  if (!claims.sub || !claims.email) throw new Error('claims');
  return claims;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

export function createSso({ db, log, auth, settings, cookieSecure = false,
  secret = process.env.SSO_SHARED_SECRET || '', dashyUrl = process.env.SSO_DASHY_URL || '', origin = process.env.PUBLIC_ORIGIN || '' }) {
  dashyUrl = dashyUrl.replace(/\/+$/, ''); origin = origin.replace(/\/+$/, '');
  const enabled = !!(secret && dashyUrl && origin);
  if (secret && dashyUrl && !origin) console.error('SSO Dashy configuré mais PUBLIC_ORIGIN absent : SSO désactivé (l\'audience du jeton ne peut pas être vérifiée).');
  const secure = cookieSecure || origin.startsWith('https://');
  const COOKIE = secure ? '__Host-craft_sso' : 'craft_sso';
  const limit = rateLimiter(15, 60_000);
  const q = {
    bySub: db.prepare('SELECT * FROM users WHERE dashy_sub = ?'),
    byName: db.prepare('SELECT 1 FROM users WHERE username = ?'),
    insert: db.prepare(`INSERT INTO users (username, pass_hash, role, must_change, all_apps, created_at, dashy_sub)
      VALUES (?, '!sso', ?, 0, 1, ?, ?)`),
    link: db.prepare('UPDATE users SET dashy_sub = ? WHERE id = ? AND dashy_sub IS NULL'),
    jti: db.prepare('INSERT OR IGNORE INTO sso_jti (jti, expires_at) VALUES (?, ?)'),
    purge: db.prepare('DELETE FROM sso_jti WHERE expires_at < ?'),
    login: db.prepare('UPDATE users SET failed_count = 0, locked_until = 0, last_login_at = ? WHERE id = ?'),
  };

  // Identifiant Crafty tiré du nom Dashy (ou de l'adresse), rendu unique.
  function usernameFor(claims) {
    let base = String(claims.name || String(claims.email).split('@')[0] || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '.').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 28);
    if (base.length < 3) base = `dashy-${base}`.slice(0, 28);
    let name = base, n = 2;
    while (q.byName.get(name)) name = `${base}${n++}`;
    return USERNAME_RE.test(name) ? name : `dashy-${randomBytes(4).toString('hex')}`;
  }

  function routes(app, { json }) {
    if (!enabled) {
      app.post('/api/auth/sso/dashy/start', (req, res) => res.status(404).json({ error: 'Introuvable.' }));
      app.get('/sso/dashy/callback', (req, res) => res.status(404).type('text/plain').send('404\n'));
      return;
    }
    app.post('/api/auth/sso/dashy/start', json, (req, res) => {
      const link = req.body?.link === true;
      if (link && !req.user) return res.status(401).json({ error: 'Connexion requise.' });
      // Retour après connexion : chemin local seulement (ni //hôte ni /\hôte, que les navigateurs prennent pour un autre site).
      const raw = typeof req.body?.next === 'string' ? req.body.next : '';
      const n = /^\/(?![/\\])[^\\]*$/.test(raw) && !raw.startsWith('/login') ? raw.slice(0, 500) : '/';
      const state = randomBytes(24).toString('base64url');
      const value = Buffer.from(JSON.stringify({ s: state, m: link ? 'link' : 'login', n, e: Date.now() + STATE_TTL })).toString('base64url');
      res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: STATE_TTL });
      const u = new URL(`${dashyUrl}/api/sso/authorize`);
      u.searchParams.set('redirect_uri', `${origin}/sso/dashy/callback`);
      u.searchParams.set('state', state);
      res.set('Cache-Control', 'no-store').json({ url: u.toString() });
    });

    app.get('/sso/dashy/callback', (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      let st = null;
      try { st = JSON.parse(Buffer.from(parseCookies(req.headers.cookie)[COOKIE] || '', 'base64url').toString('utf8')); } catch {}
      res.clearCookie(COOKIE, { path: '/', secure, sameSite: 'lax', httpOnly: true });
      const back = (code) => res.redirect(302, st?.m === 'link' ? `/?sso=${code}` : `/login.html?sso=${code}`);
      const fail = (code, user) => { log.auth('AUTH_FAIL', { ip: req.ip, user, reason: `sso_${code}` }); return back(code); };
      if (!limit(`sso:${req.ip}`)) return back('ratelimit');
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      if (!st || st.e < Date.now() || !state || state.length !== st.s.length || !timingSafeEqual(Buffer.from(state), Buffer.from(st.s))) return fail('state');
      let claims;
      try { claims = verifyDashyToken(token, { secret, audience: origin }); } catch (e) { return fail(e.message); }
      q.purge.run(Date.now());
      if (claims.jti && q.jti.run(String(claims.jti).slice(0, 200), (claims.exp + 600) * 1000).changes === 0) return fail('replay', claims.email);
      const sub = String(claims.sub).slice(0, 200);

      if (st.m === 'link') {
        if (!req.user) return back('session');
        const other = q.bySub.get(sub);
        if (other && other.id !== req.user.id) return back('linked-elsewhere');
        if (!other && q.link.run(sub, req.user.id).changes === 0) return back('already-linked');
        log.audit(req, 'auth.sso.link', null, { email: claims.email });
        return res.redirect(302, '/?sso=linked');
      }

      let u = q.bySub.get(sub), created = false;
      if (!u) {
        if (!settings().sso_create_accounts) return fail('no-account', claims.email);
        const role = claims.role === 'admin' ? 'admin' : 'user';
        const id = Number(q.insert.run(usernameFor(claims), role, Date.now(), sub).lastInsertRowid);
        u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        created = true;
      }
      if (u.disabled) return fail('disabled', u.username);
      q.login.run(Date.now(), u.id);
      auth.openSession(req, res, { userId: u.id });
      log.auth('AUTH_OK', { ip: req.ip, user: u.username, reason: 'sso' });
      req.user = { id: u.id, username: u.username };
      log.audit(req, created ? 'auth.sso.create' : 'auth.sso', null, { email: claims.email });
      res.redirect(302, st.n || '/');
    });
  }
  return { enabled, routes, callback: enabled ? `${origin}/sso/dashy/callback` : null, dashyUrl: enabled ? dashyUrl : null };
}
