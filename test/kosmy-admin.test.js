// Admin dans Kosmy Board (kosmy.board-admin.v1) : faux Board en mémoire (découverte, clés) branché par fetchImpl, jetons
// d'admin signés avec sa clé de test. Vérifie le jeton (typ, aud, iss, exp, htm, htu, jti à usage unique), le lien sub → compte
// administrateur (not_linked, forbidden), les sections et des actions avec leur effet (mêmes fonctions et même journal que la
// page d'administration), sans session ni contrôle d'origine ni CORS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign as signRaw } from 'node:crypto';
import { startServer } from './helpers.js';

const ISSUER = 'http://board.test/oidc', CLIENT = 'kb-crafty', SECRET = 'secret-client-de-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const PATH = '/api/kosmy-board/admin';

async function fakeFetch(url) {
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return res(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
  if (url === `${ISSUER}/jwks`) return res(200, { keys: [JWK] });
  return res(404, {});
}

let s, admin;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// Jeton fait comme le Board : en-tête typ kb-admin+jwt, 60 s, htm/htu de la requête visée, jti unique.
function token({ method = 'GET', path = PATH, sub = 'board-admin', typ = 'kb-admin+jwt', key = privateKey, htu, ...claims } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'k1', ...(typ ? { typ } : {}) });
  const body = b64({ iss: ISSUER, aud: CLIENT, sub, name: 'Marie Curie', email: 'marie@exemple.fr', iat: now, exp: now + 60, jti: randomUUID(),
    htm: method, htu: htu ?? `${s.base}${path}`, ...claims });
  return `${head}.${body}.${signRaw('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}
// Appel du serveur du Board : pas de cookie, pas d'Origin, pas de Sec-Fetch-Site.
async function call(method, path = PATH, { tok = token({ method, path }), json, lang } = {}) {
  const headers = { authorization: `Bearer ${tok}`, ...(lang ? { 'accept-language': lang } : {}) };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(s.base + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual' });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, data, text };
}
const post = (section, json, opts = {}) => call('POST', `${PATH}/${section}`, { json, ...opts });

before(async () => {
  s = await startServer({ kosmyOptions: { fetchImpl: fakeFetch, secret: 'cle-de-test' } });
  admin = s.client();
  assert.equal((await admin.post('/api/auth/register', { username: 'admin', password: 'motdepasse1' })).status, 201);
  assert.equal((await admin.req('PUT', '/api/admin/kosmy-board', { json: { issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET } })).status, 200);
  assert.equal((await admin.post('/api/admin/users', { username: 'bob', password: 'provisoire1' })).status, 201);
  // Comptes reliés au Board (la liaison elle-même est vérifiée dans kosmy-board.test.js).
  s.db.prepare("UPDATE users SET kosmy_sub = 'board-admin' WHERE username = 'admin'").run();
  s.db.prepare("UPDATE users SET kosmy_sub = 'board-bob' WHERE username = 'bob'").run();
});
after(() => s.close());

test('jeton valide : sommaire, sans session ni CORS ni cache', async () => {
  const r = await call('GET');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.protocol, 'kosmy.board-admin.v1');
  assert.equal(r.data.app.name, 'Crafty');
  assert.deepEqual(r.data.user, { name: 'admin', role: 'Administrateur' });
  assert.deepEqual(r.data.sections.map((x) => x.id), ['overview', 'users', 'settings', 'ai', 'system', 'audit']);
  assert.equal(r.data.sections[0].title, 'Vue d\'ensemble');
  assert.match(r.headers.get('content-type'), /^application\/json; charset=utf-8/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(r.headers.get('set-cookie'), null);
  const en = await call('GET', PATH, { lang: 'en-US,en;q=0.9' });
  assert.equal(en.data.sections[0].title, 'Overview');
  assert.equal(en.data.user.role, 'Administrator');
});

test('jeton refusé : absent, autre typ (ID token), aud, iss, signature, expiré', async () => {
  const no = await fetch(s.base + PATH);
  assert.equal(no.status, 401);
  assert.deepEqual(await no.json(), { error: 'invalid_token' });
  const cases = {
    'typ JWT (ID token)': token({ typ: 'JWT', nonce: 'n1' }),
    'sans typ': token({ typ: null }),
    aud: token({ aud: 'autre-client' }),
    iss: token({ iss: 'http://pirate.test/oidc' }),
    signature: token({ key: other.privateKey }),
    expiré: token({ exp: Math.floor(Date.now() / 1000) - 60, iat: Math.floor(Date.now() / 1000) - 120 }),
    'sans jti': token({ jti: undefined }),
  };
  for (const [name, tok] of Object.entries(cases)) {
    const r = await call('GET', PATH, { tok });
    assert.equal(r.status, 401, name);
    assert.equal(r.data.error, 'invalid_token', name);
  }
});

test('jeton refusé : jti rejoué, htm ou htu d\'une autre requête', async () => {
  const tok = token();
  assert.equal((await call('GET', PATH, { tok })).status, 200);
  assert.equal((await call('GET', PATH, { tok })).status, 401, 'jti déjà vu');
  // Fait pour un POST, envoyé en GET ; fait pour une section, envoyé à une autre ; fait pour une autre instance.
  assert.equal((await call('GET', `${PATH}/users`, { tok: token({ method: 'POST', path: `${PATH}/users` }) })).status, 401, 'htm');
  assert.equal((await call('GET', `${PATH}/settings`, { tok: token({ path: `${PATH}/users` }) })).status, 401, 'htu : autre section');
  assert.equal((await call('GET', `${PATH}/users`, { tok: token({ path: PATH }) })).status, 401, 'htu : sommaire');
  assert.equal((await call('GET', PATH, { tok: token({ htu: 'pas une adresse' }) })).status, 401, 'htu illisible');
  // Derrière un préfixe de chemin (proxy), htu se termine par le chemin demandé : accepté.
  assert.equal((await call('GET', PATH, { tok: token({ htu: `${s.base}/crafty${PATH}` }) })).status, 200, 'préfixe');
});

test('compte : non relié (not_linked), relié sans droits (forbidden), désactivé', async () => {
  let r = await call('GET', PATH, { tok: token({ sub: 'board-inconnu' }) });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'not_linked');
  assert.match(r.data.message, /Relier à Kosmy Board/);
  r = await call('GET', PATH, { tok: token({ sub: 'board-bob' }) });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'forbidden');
  assert.equal(r.data.message, 'Votre compte Crafty n\'a pas les droits d\'administration.');
  r = await call('GET', PATH, { tok: token({ sub: 'board-bob' }), lang: 'en' });
  assert.equal(r.data.message, 'Your Crafty account does not have administrator rights.');
  r = await call('POST', `${PATH}/settings`, { tok: token({ sub: 'board-bob', method: 'POST', path: `${PATH}/settings` }),
    json: { action: 'save-access', values: { signup_open: true } } });
  assert.equal(r.status, 403, 'action refusée avant toute lecture');
  assert.equal(s.db.settings().signup_open, false);
  s.db.prepare("UPDATE users SET disabled = 1 WHERE username = 'admin'").run();
  r = await call('GET');
  s.db.prepare("UPDATE users SET disabled = 0 WHERE username = 'admin'").run();
  assert.deepEqual([r.status, r.data.error, r.data.message], [403, 'forbidden', 'Votre compte Crafty est désactivé.']);
});

test('section : comptes, sans aucun secret ; section inconnue', async () => {
  const r = await call('GET', `${PATH}/users`);
  assert.equal(r.status, 200);
  assert.equal(r.data.id, 'users');
  const table = r.data.blocks.find((b) => b.type === 'table');
  const rows = Object.fromEntries(table.rows.map((x) => [x.cells.name, x]));
  assert.deepEqual(Object.keys(rows).sort(), ['admin (vous)', 'bob']);
  assert.deepEqual(rows['admin (vous)'].actions, ['apps', 'quota'], 'ni rôle, ni état, ni suppression de son propre compte');
  assert.ok(rows.bob.actions.includes('make-admin') && rows.bob.actions.includes('delete'));
  assert.equal(rows.bob.cells.state.text, 'mot de passe provisoire');
  for (const a of table.rowActions) assert.match(a.id, /^[A-Za-z0-9_.:-]{1,64}$/);
  assert.ok(!/scrypt\$|pass_hash|kosmy_sub|board-admin/.test(r.text), 'ni hachage ni identifiant du Board');

  const sys = await call('GET', `${PATH}/system`);
  assert.equal(sys.status, 200);
  assert.ok(!sys.text.includes(SECRET), 'secret client jamais renvoyé');
  for (const id of ['overview', 'settings', 'ai', 'audit']) {
    const x = await call('GET', `${PATH}/${id}`);
    assert.equal(x.status, 200, id);
    assert.ok(x.data.blocks.length >= 1 && x.data.blocks.length <= 30, id);
  }
  const unknown = await call('GET', `${PATH}/inconnue`);
  assert.deepEqual([unknown.status, unknown.data.error], [404, 'not_found']);
});

test('actions : réglage enregistré (même journal), compte créé avec mot de passe provisoire révélé, droits donnés', async () => {
  // Réglages : POST sans Origin accepté (appel de serveur à serveur), section à jour dans la réponse.
  let r = await post('settings', { action: 'save-access', values: { signup_open: true, guest_enabled: false, sharing_enabled: true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.message, 'Réglages enregistrés.');
  assert.equal(r.data.section.id, 'settings');
  assert.equal(s.db.settings().signup_open, true);
  const log = s.db.prepare("SELECT * FROM audit WHERE action = 'admin.settings' ORDER BY id DESC").get();
  assert.equal(log.username, 'admin');
  assert.equal(JSON.parse(log.detail).via, 'kosmy-board');
  r = await post('settings', { action: 'save-files', values: { max_versions: 500, default_quota: 1, max_file_size: 512, autosave_seconds: 30, trash_days: 30 } });
  assert.deepEqual([r.status, r.data.error, r.data.message], [422, 'invalid', 'Valeur invalide pour max_versions.'], 'mêmes contrôles que la page d\'administration');

  // Nouveau compte : mot de passe provisoire montré une fois, valable, à changer.
  r = await post('users', { action: 'create', values: { username: 'claire', role: 'user', quota: '', allApps: false, 'app-demo': true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.reveal.label, 'Mot de passe provisoire de claire');
  const c = s.client();
  const login = await c.post('/api/auth/login', { username: 'claire', password: r.data.reveal.value });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChange, true);
  const claire = r.data.section.blocks[0].rows.find((x) => x.cells.name === 'claire');
  assert.equal(claire.cells.apps, 'Demo');
  r = await post('users', { action: 'create', values: { username: 'x' } }, { lang: 'en' });
  assert.deepEqual([r.status, r.data.message], [422, 'Username: 3 to 32 characters (letters, digits, . _ -)']);

  // Droits d'administration donnés à bob : il peut alors administrer depuis le Board.
  const bobId = String(s.db.prepare("SELECT id FROM users WHERE username = 'bob'").get().id);
  r = await post('users', { action: 'make-admin', row: bobId });
  assert.equal(r.status, 200, r.text);
  assert.equal(s.db.prepare("SELECT role FROM users WHERE username = 'bob'").get().role, 'admin');
  assert.equal(JSON.parse(s.db.prepare("SELECT detail FROM audit WHERE action = 'admin.user.update' ORDER BY id DESC").get().detail).role, 'admin');

  // Refus : son propre compte, ligne inconnue, action inconnue, corps illisible.
  const adminId = String(s.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id);
  assert.deepEqual([(r = await post('users', { action: 'delete', row: adminId })).status, r.data.error], [409, 'conflict']);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM users WHERE username = 'admin'").get().n, 1);
  assert.deepEqual([(r = await post('users', { action: 'disable', row: '99999' })).status, r.data.error], [404, 'not_found']);
  assert.deepEqual([(r = await post('users', { action: 'inventée', row: bobId })).status, r.data.error], [400, 'invalid_request']);
  assert.deepEqual([(r = await post('users', { action: 'explode', row: bobId })).status, r.data.error], [404, 'not_found']);
  assert.deepEqual([(r = await post('audit', { action: 'clear' })).status, r.data.error], [404, 'not_found'], 'section en lecture seule');
  assert.equal((await call('PUT', `${PATH}/users`, { tok: token({ method: 'PUT', path: `${PATH}/users` }) })).status, 405);
});

test('connexion unique non réglée : jeton refusé', async () => {
  assert.equal((await admin.req('PUT', '/api/admin/kosmy-board', { json: { clearSecret: true } })).status, 200);
  const r = await call('GET');
  assert.deepEqual([r.status, r.data.error], [401, 'invalid_token']);
});
