// Connexion avec Kosmy Board (OpenID Connect) : faux Board en mémoire (découverte, clés, jeton) branché par fetchImpl.
// Vérifie le lancement (iss, target_link_uri, state, nonce, PKCE S256), le retour (state à usage unique et lié au
// navigateur, iss, client_secret_basic, ID token RS256 complet), la liaison par sub et les réglages d'administration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signRaw } from 'node:crypto';
import { startServer } from './helpers.js';
import { verifyIdToken, safeTarget, normalizeIssuer } from '../src/kosmy-board.js';

const ISSUER = 'http://board.test/oidc', CLIENT = 'kb-crafty', SECRET = 'secret client:é+/';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims = {}, { key = privateKey, alg = 'RS256', kid = 'k1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64({ iss: ISSUER, aud: CLIENT, sub: 'board-uuid-1', name: 'Marie Curie', email: 'marie@exemple.fr', email_verified: false, iat: now, exp: now + 300, ...claims });
  const sig = alg === 'none' ? '' : signRaw('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

// Faux Board : codes émis par authorize() ; le point de jeton vérifie client_secret_basic, redirect_uri et PKCE.
const codes = new Map();
const calls = { token: [] };
let tokenOverride = null;
async function fakeFetch(url, init = {}) {
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return res(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, userinfo_endpoint: `${ISSUER}/me` });
  if (url === `${ISSUER}/jwks`) return res(200, { keys: [JWK] });
  if (url === `${ISSUER}/token`) {
    const form = new URLSearchParams(init.body);
    calls.token.push({ auth: init.headers.Authorization, form });
    const want = `Basic ${Buffer.from(`${encodeURIComponent(CLIENT)}:${encodeURIComponent(SECRET).replace(/%20/g, '+')}`).toString('base64')}`;
    if (init.headers.Authorization !== want) return res(401, { error: 'invalid_client' });
    const c = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    if (!c || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== c.redirect
      || createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== c.challenge) return res(400, { error: 'invalid_grant' });
    return res(200, { access_token: 'at', token_type: 'Bearer', id_token: tokenOverride ? tokenOverride(c) : idToken({ nonce: c.nonce, sub: c.sub }) });
  }
  return res(404, {});
}

let s, admin;
before(async () => {
  s = await startServer({ kosmyOptions: { fetchImpl: fakeFetch, secret: 'cle-de-test' } });
  admin = s.client();
  assert.equal((await admin.post('/api/auth/register', { username: 'admin', password: 'motdepasse1' })).status, 201);
});
after(() => s.close());

const configure = (body) => admin.req('PUT', '/api/admin/kosmy-board', { json: body });
const flowCookie = (r) => r.headers.getSetCookie().find((x) => x.startsWith('craft_kosmy='))?.split(';')[0];
// Le Board « autorise » : code lié au nonce, au challenge PKCE et à l'adresse de retour de la demande.
function authorize(authUrl, sub = 'board-uuid-1') {
  const u = new URL(authUrl), code = `code-${Math.random()}`;
  codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri'), sub });
  return { code, state: u.searchParams.get('state') };
}
async function callback(c, { code, state, cookie, iss = ISSUER, extra = '' }) {
  const session = c.cookie;
  c.cookie = '';
  const qs = new URLSearchParams({ code, state, ...(iss ? { iss } : {}) });
  const r = await c.req('GET', `/auth/kosmy-board/callback?${qs}${extra}`, { headers: { cookie: [cookie, session].filter(Boolean).join('; ') } });
  if (!c.cookie) c.cookie = session;
  return r;
}
async function loginFlow(c, { sub, target = '' } = {}) {
  const r = await c.get(`/auth/kosmy-board/login?iss=${encodeURIComponent(ISSUER)}${target}`);
  assert.equal(r.status, 302, r.headers.get('location'));
  return { ...authorize(r.headers.get('location'), sub), cookie: flowCookie(r), location: r.headers.get('location') };
}

test('fonctions : émetteur, page cible de même origine, ID token', () => {
  assert.equal(normalizeIssuer(' http://board.test/oidc/ '), 'http://board.test/oidc');
  assert.equal(normalizeIssuer('javascript:alert(1)'), '');
  assert.equal(normalizeIssuer('https://b.test/oidc?x=1'), '');
  const base = 'http://crafty.test';
  assert.equal(safeTarget('http://crafty.test/admin.html#users', base), '/admin.html#users');
  assert.equal(safeTarget('/host.html?app=demo', base), '/host.html?app=demo');
  for (const bad of ['https://evil.test/', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)', '/login.html', '']) assert.equal(safeTarget(bad, base), '/', bad);

  const opts = { keys: [JWK], issuer: ISSUER, clientId: CLIENT, nonce: 'n1' };
  assert.equal(verifyIdToken(idToken({ nonce: 'n1' }), opts).sub, 'board-uuid-1');
  const why = (tok, o = {}) => { try { verifyIdToken(tok, { ...opts, ...o }); return 'ok'; } catch (e) { return e.message; } };
  assert.equal(why(idToken({ nonce: 'n1' }, { key: other.privateKey })), 'signature');
  assert.equal(why(idToken({ nonce: 'n1' }, { alg: 'none' })), 'algorithm');
  assert.equal(why(idToken({ nonce: 'n1', alg: 'HS256' }).replace(/^[^.]+/, b64({ alg: 'HS256', kid: 'k1' }))), 'algorithm');
  assert.equal(why(idToken({ nonce: 'n1' }, { kid: 'inconnu' })), 'key');
  assert.equal(why(idToken({ nonce: 'n1', iss: 'http://pirate.test/oidc' })), 'issuer');
  assert.equal(why(idToken({ nonce: 'n1', aud: 'autre-client' })), 'audience');
  assert.equal(why(idToken({ nonce: 'n1', aud: [CLIENT, 'autre'] })), 'audience', 'plusieurs audiences sans azp');
  assert.equal(why(idToken({ nonce: 'n1', exp: Math.floor(Date.now() / 1000) - 120 })), 'expired');
  assert.equal(why(idToken({ nonce: 'autre' })), 'nonce');
  assert.equal(why(idToken({})), 'nonce', 'nonce absent');
});

test('administration : réglages, secret en écriture seule, adresses à copier, réservé aux admins', async () => {
  let r = await admin.get('/api/admin/kosmy-board');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false);
  assert.equal(r.data.createAccounts, false, 'création automatique désactivée par défaut');
  assert.equal(r.data.redirectUri, `${s.base}/auth/kosmy-board/callback`);
  assert.equal(r.data.loginUri, `${s.base}/auth/kosmy-board/login`);
  assert.equal((await configure({ issuer: 'ftp://x' })).status, 400);
  r = await configure({ issuer: `${ISSUER}/`, clientId: CLIENT, clientSecret: SECRET });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.enabled, r.data.issuer, r.data.hasSecret, 'clientSecret' in r.data], [true, ISSUER, true, false]);
  const stored = s.db.prepare("SELECT value FROM settings WHERE key = 'kosmy_board'").get().value;
  assert.ok(!stored.includes('secret client'), 'secret chiffré en base');
  r = await configure({ issuer: ISSUER, clientId: CLIENT, clientSecret: '' });
  assert.equal(r.data.hasSecret, true, 'champ vide = secret gardé');
  assert.ok(!JSON.stringify((await admin.get('/api/admin/settings')).data).includes('kosmy'));
  assert.deepEqual((await s.client().get('/api/auth/config')).data.sso, { dashy: false, kosmyBoard: true });

  assert.equal((await admin.post('/api/admin/users', { username: 'bob', password: 'provisoire1' })).status, 201);
  const bob = s.client();
  await bob.post('/api/auth/login', { username: 'bob', password: 'provisoire1' });
  await bob.post('/api/auth/password', { current: 'provisoire1', password: 'motdepasse2' });
  assert.equal((await bob.get('/api/admin/kosmy-board')).status, 404);
  assert.equal((await bob.req('PUT', '/api/admin/kosmy-board', { json: { issuer: 'http://pirate.test' } })).status, 404);
});

test('lancement : iss vérifié, cible de même origine, state, nonce et PKCE S256', async () => {
  const c = s.client();
  let r = await c.get('/auth/kosmy-board/login?iss=http%3A%2F%2Fpirate.test%2Foidc');
  assert.equal(r.headers.get('location'), '/login.html?kosmy=issuer');
  r = await c.get(`/auth/kosmy-board/login?iss=${encodeURIComponent(ISSUER)}&target_link_uri=${encodeURIComponent(`${s.base}/admin.html`)}`);
  const u = new URL(r.headers.get('location'));
  assert.equal(u.origin + u.pathname, `${ISSUER}/auth`);
  const p = Object.fromEntries(u.searchParams);
  assert.equal(p.response_type, 'code');
  assert.equal(p.client_id, CLIENT);
  assert.equal(p.redirect_uri, `${s.base}/auth/kosmy-board/callback`);
  assert.equal(p.scope, 'openid profile email');
  assert.equal(p.code_challenge_method, 'S256');
  assert.ok(p.state.length >= 22 && p.nonce.length >= 22 && p.code_challenge.length === 43);
  const ck = r.headers.getSetCookie().find((x) => x.startsWith('craft_kosmy='));
  assert.match(ck, /HttpOnly/i);
  assert.equal(ck.split(';')[0], `craft_kosmy=${p.state}`);
});

test('compte non relié : refus sans création ; puis liaison depuis le compte connecté et connexion par le Board', async () => {
  const c = s.client();
  c.ip = '198.51.100.20';
  let f = await loginFlow(c, { target: `&target_link_uri=${encodeURIComponent('https://evil.test/')}` });
  let r = await callback(c, f);
  assert.equal(r.headers.get('location'), '/login.html?kosmy=no-account');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM users').get().n, 2, 'aucun compte créé, même avec un e-mail connu');

  // Liaison : POST (contrôle d'origine), puis retour du Board avec la session du compte.
  assert.equal((await s.client().post('/api/auth/kosmy-board/link')).status, 401);
  r = await admin.post('/api/auth/kosmy-board/link');
  assert.equal(r.status, 200);
  const l = { ...authorize(r.data.url), cookie: flowCookie(r) };
  r = await callback(admin, l);
  assert.equal(r.headers.get('location'), '/?kosmy=linked');
  assert.equal((await admin.get('/api/me')).data.user.kosmy, true);
  const call = calls.token.at(-1);
  assert.equal(call.form.get('grant_type'), 'authorization_code');

  // Connexion par le Board : session du compte relié, page cible respectée (même origine), redirection ouverte refusée.
  f = await loginFlow(c, { target: `&target_link_uri=${encodeURIComponent(`${s.base}/admin.html`)}` });
  r = await callback(c, f);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin.html');
  c.cookie = r.headers.getSetCookie().find((x) => x.startsWith('craft_sid=')).split(';')[0];
  const me = (await c.get('/api/me')).data.user;
  assert.deepEqual([me.username, me.role], ['admin', 'admin']);
  const e = s.client();
  f = await loginFlow(e, { target: `&target_link_uri=${encodeURIComponent('https://evil.test/')}` });
  assert.equal((await callback(e, f)).headers.get('location'), '/');

  // Le même sub ne peut pas être relié à un deuxième compte.
  const bob = s.client();
  await bob.post('/api/auth/login', { username: 'bob', password: 'motdepasse2' });
  r = await bob.post('/api/auth/kosmy-board/link');
  r = await callback(bob, { ...authorize(r.data.url), cookie: flowCookie(r) });
  assert.equal(r.headers.get('location'), '/?kosmy=linked-elsewhere');
});

test('retour refusé : state rejoué, d\'un autre navigateur ou sans cookie, iss, erreur du Board, jeton invalide', async () => {
  const c = s.client();
  c.ip = '198.51.100.21';
  const loc = async (f) => (await callback(c, f)).headers.get('location');
  let f = await loginFlow(c);
  assert.equal(await loc({ ...f, cookie: null }), '/login.html?kosmy=state', 'sans cookie (lien envoyé par un tiers)');
  f = await loginFlow(c);
  const g = await loginFlow(s.client());
  assert.equal(await loc({ ...f, cookie: g.cookie }), '/login.html?kosmy=state', 'cookie d\'un autre parcours');
  f = await loginFlow(c);
  assert.equal(await loc(f), '/', 'premier passage accepté');
  assert.equal(await loc(f), '/login.html?kosmy=state', 'state à usage unique');
  f = await loginFlow(c);
  assert.equal(await loc({ ...f, iss: 'http://pirate.test/oidc' }), '/login.html?kosmy=issuer');
  f = await loginFlow(c);
  assert.equal(await loc({ ...f, extra: '&error=access_denied' }), '/login.html?kosmy=denied');
  for (const [name, make] of [['signature', (x) => idToken({ nonce: x.nonce }, { key: other.privateKey })], ['nonce', () => idToken({ nonce: 'autre' })],
    ['audience', (x) => idToken({ nonce: x.nonce, aud: 'autre' })], ['exp', (x) => idToken({ nonce: x.nonce, exp: 1 })]]) {
    tokenOverride = make;
    f = await loginFlow(c);
    assert.equal(await loc(f), '/login.html?kosmy=token', name);
  }
  tokenOverride = null;
});

test('création automatique (option) : simple utilisateur, jamais administrateur ; compte sans mot de passe', async () => {
  await configure({ createAccounts: true });
  const c = s.client();
  c.ip = '198.51.100.22';
  tokenOverride = (x) => idToken({ nonce: x.nonce, sub: x.sub, name: 'Pierre Curie', role: 'admin', groups: ['admin'] });
  const f = await loginFlow(c, { sub: 'board-uuid-9' });
  const r = await callback(c, f);
  tokenOverride = null;
  assert.equal(r.headers.get('location'), '/');
  c.cookie = r.headers.getSetCookie().find((x) => x.startsWith('craft_sid=')).split(';')[0];
  const me = (await c.get('/api/me')).data.user;
  assert.deepEqual([me.username, me.role, me.hasPassword, me.kosmy], ['Pierre.Curie', 'user', false, true]);
  assert.equal((await c.post('/api/auth/kosmy-board/unlink', { password: '!kosmy' })).status, 400, 'sans mot de passe : pas de déliaison');
  await configure({ createAccounts: false });
});

test('défaire le lien : mot de passe demandé', async () => {
  assert.equal((await admin.post('/api/auth/kosmy-board/unlink', { password: 'faux-mot-de-passe' })).status, 400);
  assert.equal((await admin.get('/api/me')).data.user.kosmy, true);
  assert.equal((await admin.post('/api/auth/kosmy-board/unlink', { password: 'motdepasse1' })).status, 200);
  assert.equal((await admin.get('/api/me')).data.user.kosmy, false);
  const c = s.client();
  c.ip = '198.51.100.23';
  assert.equal((await callback(c, await loginFlow(c))).headers.get('location'), '/login.html?kosmy=no-account');
});

test('non configuré : le lancement renvoie vers la connexion', async () => {
  await configure({ clearSecret: true });
  const r = await s.client().get('/auth/kosmy-board/login');
  assert.equal(r.headers.get('location'), '/login.html?kosmy=not-configured');
  assert.equal((await admin.post('/api/auth/kosmy-board/link')).status, 404);
});
