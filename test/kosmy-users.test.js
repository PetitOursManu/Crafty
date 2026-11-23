// Utilisateurs gérés par Kosmy Board (kosmy.board-users.v1) : faux Board en mémoire (découverte, clés, point de jeton) branché par
// fetchImpl, jetons d'admin signés avec sa clé de test. Vérifie le schéma (rôles, restrictions) et la liste, le PUT (création
// sans mot de passe, liaison par l'e-mail, mise à jour idempotente, 409, 422), le DELETE (désactivation appliquée partout, PUT
// qui réactive), les garde-fous, le jeton (htm, htu, jti) et la revendication kosmy_board_access à la connexion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign as signRaw } from 'node:crypto';
import { startServer, PDF } from './helpers.js';

const ISSUER = 'http://board.test/oidc', CLIENT = 'kb-crafty', SECRET = 'secret-client-de-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const PATH = '/api/kosmy-board/users', GIB = 1024 ** 3;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signed = (head, body) => `${head}.${body}.${signRaw('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;

// Faux Board : découverte, clés, et point de jeton qui rend l'ID token préparé pour le code (avec ou sans kosmy_board_access).
const codes = new Map();
async function fakeFetch(url, init = {}) {
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return res(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
  if (url === `${ISSUER}/jwks`) return res(200, { keys: [JWK] });
  if (url === `${ISSUER}/token`) {
    const form = new URLSearchParams(init.body), c = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    if (!c || createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== c.challenge) return res(400, { error: 'invalid_grant' });
    const now = Math.floor(Date.now() / 1000);
    return res(200, { access_token: 'at', token_type: 'Bearer', id_token: signed(b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }),
      b64({ iss: ISSUER, aud: CLIENT, iat: now, exp: now + 300, nonce: c.nonce, ...c.claims })) });
  }
  return res(404, {});
}

let s, admin;
// Jeton d'admin fait comme le Board : typ kb-admin+jwt, 60 s, htm/htu de la requête visée, jti unique ; sub = qui agit.
function token({ method = 'GET', path = PATH, sub = 'board-admin', typ = 'kb-admin+jwt', htu, ...claims } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signed(b64({ alg: 'RS256', kid: 'k1', typ }), b64({ iss: ISSUER, aud: CLIENT, sub, iat: now, exp: now + 60, jti: randomUUID(),
    htm: method, htu: htu ?? `${s.base}${path}`, ...claims }));
}
// Appel du serveur du Board : pas de cookie, pas d'Origin.
async function call(method, path = PATH, { tok = token({ method, path }), json, raw, lang } = {}) {
  const headers = { authorization: `Bearer ${tok}`, ...(lang ? { 'accept-language': lang } : {}) };
  if (json !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(s.base + path, { method, headers, body: raw ?? (json === undefined ? undefined : JSON.stringify(json)), redirect: 'manual' });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, data, text };
}
const put = (sub, json, opts = {}) => call('PUT', `${PATH}/${sub}`, { json, ...opts });
const del = (sub, opts = {}) => call('DELETE', `${PATH}/${sub}`, opts);
const row = (where, ...args) => s.db.prepare(`SELECT * FROM users WHERE ${where}`).get(...args);
const appsOf = (id) => s.db.prepare('SELECT slug FROM user_apps WHERE user_id = ? ORDER BY slug').all(id).map((r) => r.slug);
const aiUsers = () => JSON.parse(s.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get()?.value || '{"users":[]}').users;

// Connexion par le Board : lancement, « autorisation » avec l'ID token voulu, retour ; renvoie la redirection et le cookie de session.
async function boardLogin(claims, ip) {
  const c = s.client();
  c.ip = ip;
  const start = await c.get(`/auth/kosmy-board/login?iss=${encodeURIComponent(ISSUER)}`);
  const u = new URL(start.headers.get('location')), code = `code-${randomUUID()}`;
  codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), claims });
  const flow = start.headers.getSetCookie().find((x) => x.startsWith('craft_kosmy=')).split(';')[0];
  const r = await c.req('GET', `/auth/kosmy-board/callback?${new URLSearchParams({ code, state: u.searchParams.get('state'), iss: ISSUER })}`, { headers: { cookie: flow } });
  const sid = r.headers.getSetCookie().find((x) => x.startsWith('craft_sid='))?.split(';')[0];
  if (sid) c.cookie = sid;
  return { location: r.headers.get('location'), client: sid ? c : null };
}
async function passwordLogin(username, password, ip) {
  const c = s.client();
  c.ip = ip;
  const r = await c.post('/api/auth/login', { username, password });
  return { status: r.status, client: c };
}

before(async () => {
  s = await startServer({ kosmyOptions: { fetchImpl: fakeFetch, secret: 'cle-de-test' } });
  admin = s.client();
  assert.equal((await admin.post('/api/auth/register', { username: 'admin', password: 'motdepasse1' })).status, 201);
  assert.equal((await admin.req('PUT', '/api/admin/kosmy-board', { json: { issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET } })).status, 200);
  s.db.prepare("UPDATE users SET kosmy_sub = 'board-admin' WHERE username = 'admin'").run();
  // bob : compte Crafty existant, non relié, avec mot de passe ; son adresse est saisie par l'admin de Crafty.
  const bob = await admin.post('/api/admin/users', { username: 'bob', password: 'provisoire1' });
  assert.equal(bob.status, 201);
  assert.equal((await admin.patch(`/api/admin/users/${bob.data.id}`, { email: 'pas-une-adresse' })).status, 400);
  const r = await admin.patch(`/api/admin/users/${bob.data.id}`, { email: ' Bob@Exemple.fr ' });
  assert.equal(r.data.email, 'bob@exemple.fr');
  const b = await passwordLogin('bob', 'provisoire1', '198.51.100.40');
  assert.equal((await b.client.post('/api/auth/password', { current: 'provisoire1', password: 'motdepasse2' })).status, 200);
});
after(() => s.close());

test('GET : protocole, rôles, restrictions et comptes reliés, sans secret ni CORS ni cache', async () => {
  const r = await call('GET');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.protocol, 'kosmy.board-users.v1');
  assert.deepEqual(r.data.roles.map((x) => [x.value, x.label, !!x.admin]), [['admin', 'Administrateur', true], ['user', 'Utilisateur', false]]);
  assert.equal(r.data.defaultRole, 'user');
  const fields = Object.fromEntries(r.data.fields.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(fields), ['quota', 'allApps', 'app-demo', 'app-other', 'ai']);
  assert.equal(fields.quota.type, 'number');
  assert.equal(fields.quota.roles, undefined, 'le quota vaut pour tous les rôles');
  assert.match(fields.quota.help, /\(1 Gio\)/);
  assert.deepEqual([fields.allApps.value, fields['app-demo'].label, fields.ai.value], [true, 'Demo', false]);
  for (const k of ['allApps', 'app-demo', 'ai']) assert.deepEqual(fields[k].roles, ['user'], k);
  assert.ok(r.data.fields.every((f) => f.type !== 'password'));
  assert.deepEqual(r.data.users, [{ sub: 'board-admin', role: 'admin', active: true, account: 'admin',
    values: { allApps: true, 'app-demo': false, 'app-other': false, ai: false } }], 'seulement les comptes reliés au Board');
  assert.ok(!/scrypt\$|pass_hash|!kosmy|bob@/.test(r.text), 'ni hachage ni compte non relié');
  assert.match(r.headers.get('content-type'), /^application\/json; charset=utf-8/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(r.headers.get('set-cookie'), null);
  const en = await call('GET', PATH, { lang: 'en-US,en;q=0.9' });
  assert.deepEqual(en.data.roles.map((x) => x.label), ['Administrator', 'User']);
  assert.equal(en.data.fields[0].label, 'Quota (GiB)');
});

test('jeton : absent, ID token, htm ou htu d\'une autre requête, rejoué, compte non relié ou sans droits', async () => {
  const no = await fetch(s.base + PATH);
  assert.deepEqual([no.status, await no.json()], [401, { error: 'invalid_token' }]);
  const refused = {
    'ID token (typ JWT)': ['GET', PATH, token({ typ: 'JWT' })],
    'htm : GET envoyé en PUT': ['PUT', `${PATH}/u-1`, token({ path: `${PATH}/u-1` })],
    'htm : PUT envoyé en DELETE': ['DELETE', `${PATH}/u-1`, token({ method: 'PUT', path: `${PATH}/u-1` })],
    'htu : la liste, envoyé pour un compte': ['PUT', `${PATH}/u-1`, token({ method: 'PUT' })],
    'htu : un autre compte': ['DELETE', `${PATH}/u-1`, token({ method: 'DELETE', path: `${PATH}/u-2` })],
    'htu : admin dans le Board': ['GET', PATH, token({ path: '/api/kosmy-board/admin' })],
  };
  for (const [name, [method, path, tok]] of Object.entries(refused)) {
    const r = await call(method, path, { tok, json: method === 'PUT' ? { role: 'user' } : undefined });
    assert.deepEqual([r.status, r.data?.error], [401, 'invalid_token'], name);
  }
  assert.equal(row("kosmy_sub = 'u-1'"), undefined, 'aucun compte créé par un jeton refusé');
  const tok = token();
  assert.equal((await call('GET', PATH, { tok })).status, 200);
  assert.equal((await call('GET', PATH, { tok })).status, 401, 'jti déjà vu');
  let r = await call('GET', PATH, { tok: token({ sub: 'board-inconnu' }) });
  assert.deepEqual([r.status, r.data.error], [403, 'not_linked']);
  s.db.prepare("UPDATE users SET role = 'user' WHERE username = 'admin'").run();
  r = await put('u-1', { role: 'user' }, { tok: token({ method: 'PUT', path: `${PATH}/u-1` }), lang: 'en' });
  s.db.prepare("UPDATE users SET role = 'admin' WHERE username = 'admin'").run();
  assert.deepEqual([r.status, r.data.error, r.data.message], [403, 'forbidden', 'Your Crafty account does not have administrator rights.']);
  assert.equal(row("kosmy_sub = 'u-1'"), undefined);
});

test('PUT : compte créé sans mot de passe, rôle et restrictions appliqués, idempotent ; puis mis à jour', async () => {
  const body = { name: 'Alice Martin', email: 'Alice@Exemple.fr', locale: 'fr', role: 'user',
    values: { quota: 2.5, allApps: false, 'app-demo': true, 'app-other': false, ai: true } };
  let r = await put('5b6e-alice', body);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data, { ok: true, status: 'created', account: 'Alice.Martin', message: 'Compte créé.' });
  const a = row("kosmy_sub = '5b6e-alice'");
  assert.deepEqual([a.username, a.pass_hash, a.role, a.disabled, a.must_change, a.email, a.quota, a.all_apps],
    ['Alice.Martin', '!kosmy', 'user', 0, 0, 'alice@exemple.fr', 2.5 * GIB, 0]);
  assert.deepEqual(appsOf(a.id), ['demo']);
  assert.deepEqual(aiUsers(), [a.id]);
  const log = s.db.prepare("SELECT * FROM audit WHERE action = 'admin.user.create' ORDER BY id DESC").get();
  assert.deepEqual([log.username, log.target, JSON.parse(log.detail).via], ['admin', String(a.id), 'kosmy-board']);
  // Pas de connexion par mot de passe pour un compte géré par le Board.
  assert.equal((await passwordLogin('Alice.Martin', '!kosmy', '198.51.100.41')).status, 401);

  // Même PUT : même état, aucune écriture de plus au journal.
  const before = s.db.prepare('SELECT COUNT(*) n FROM audit').get().n, snapshot = row('id = ?', a.id);
  r = await put('5b6e-alice', body);
  assert.deepEqual([r.status, r.data.status, r.data.account, r.data.message], [200, 'updated', 'Alice.Martin', 'Compte mis à jour.']);
  assert.deepEqual(row("kosmy_sub = '5b6e-alice'"), snapshot);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM audit').get().n, before, 'idempotent');

  const list = (await call('GET')).data.users.find((u) => u.sub === '5b6e-alice');
  assert.deepEqual(list, { sub: '5b6e-alice', role: 'user', active: true, account: 'Alice.Martin',
    values: { allApps: false, quota: 2.5, 'app-demo': true, 'app-other': false, ai: true } });

  // Mise à jour : champ absent = valeur gardée ; quota vide = quota par défaut ; administrateur (le Board ne lui envoie que le quota).
  r = await put('5b6e-alice', { name: 'Alice M.', email: 'alice@exemple.fr', role: 'user', values: { 'app-other': true, ai: false } }, { lang: 'en' });
  assert.deepEqual([r.data.status, r.data.message], ['updated', 'Account updated.']);
  assert.deepEqual(appsOf(a.id), ['demo', 'other']);
  assert.equal(row('id = ?', a.id).quota, 2.5 * GIB);
  assert.deepEqual(aiUsers(), []);
  r = await put('5b6e-alice', { role: 'admin', values: { quota: '' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([row('id = ?', a.id).role, row('id = ?', a.id).quota, row('id = ?', a.id).username], ['admin', null, 'Alice.Martin']);
  r = await put('5b6e-alice', { role: 'user', values: { allApps: true } });
  assert.deepEqual([r.status, row('id = ?', a.id).role, row('id = ?', a.id).all_apps], [200, 'user', 1]);
});

test('PUT : compte existant non relié repris par son adresse e-mail ; 409 si l\'adresse est déjà reliée ou ambiguë', async () => {
  let r = await put('5b6e-bob', { name: 'Bob', email: 'BOB@exemple.fr', role: 'user', values: { quota: 1 } });
  assert.deepEqual([r.status, r.data.status, r.data.account, r.data.message], [200, 'linked', 'bob', 'Compte existant relié.']);
  const bob = row("username = 'bob'");
  assert.deepEqual([bob.kosmy_sub, bob.quota], ['5b6e-bob', GIB]);
  assert.equal((await passwordLogin('bob', 'motdepasse2', '198.51.100.42')).status, 200, 'son mot de passe marche toujours');
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM users WHERE username LIKE 'Bob%'").get().n, 1, 'aucun compte en double');

  // Adresse d'un compte déjà relié à une autre personne du Board.
  r = await put('5b6e-autre', { name: 'Autre', email: 'alice@exemple.fr', role: 'user' });
  assert.deepEqual([r.status, r.data.error, r.data.message], [409, 'conflict', 'Cette adresse e-mail est celle d\'un compte Crafty déjà relié à une autre personne du Board.']);
  r = await put('5b6e-autre', { name: 'Autre', email: 'alice@exemple.fr', role: 'user' }, { lang: 'en' });
  assert.equal(r.data.message, 'This email address belongs to a Crafty account already linked to another Board user.');
  // Deux comptes non reliés avec la même adresse : on ne devine pas.
  for (const username of ['dup1', 'dup2']) {
    const c = await admin.post('/api/admin/users', { username, password: 'provisoire1' });
    await admin.patch(`/api/admin/users/${c.data.id}`, { email: 'dup@exemple.fr' });
  }
  r = await put('5b6e-dup', { name: 'Dup', email: 'dup@exemple.fr', role: 'user' });
  assert.deepEqual([r.status, r.data.error], [409, 'conflict']);
  assert.equal(row("kosmy_sub IN ('5b6e-autre', '5b6e-dup')"), undefined, 'rien de créé');
});

test('PUT : valeurs refusées (422), corps illisible (400), adresse ou méthode inconnue', async () => {
  const cases = [
    [{ role: 'superuser' }, 'Rôle inconnu.'],
    [{ email: 'x@exemple.fr' }, 'Rôle inconnu.'],
    [{ role: 'user', values: { quota: -1 } }, 'Valeur refusée pour « Quota (Gio) ».'],
    [{ role: 'user', values: { quota: 'beaucoup' } }, 'Valeur refusée pour « Quota (Gio) ».'],
    [{ role: 'user', values: { quota: 200_000 } }, 'Valeur refusée pour « Quota (Gio) ».'],
    [{ role: 'user', values: { allApps: 'oui' } }, 'Valeur refusée pour « Toutes les applications (y compris celles ajoutées plus tard) ».'],
    [{ role: 'user', values: { 'app-demo': 1 } }, 'Valeur refusée pour « Demo ».'],
    [{ role: 'user', values: [true] }, 'Restrictions illisibles.'],
  ];
  for (const [body, message] of cases) {
    const r = await put('5b6e-refus', body);
    assert.deepEqual([r.status, r.data.error, r.data.message], [422, 'invalid', message], JSON.stringify(body));
  }
  let r = await put('5b6e-refus', { role: 'user', values: { ai: 'yes' } }, { lang: 'en' });
  assert.deepEqual([r.status, r.data.message], [422, 'Value refused for “AI assistant”.']);
  r = await call('PUT', `${PATH}/5b6e-refus`, { raw: '{pas du json' });
  assert.deepEqual([r.status, r.data.error], [400, 'invalid_request']);
  assert.equal(row("kosmy_sub = '5b6e-refus'"), undefined, 'rien de créé');
  // Une valeur refusée ne laisse rien à moitié fait sur un compte existant.
  const alice = row("kosmy_sub = '5b6e-alice'");
  r = await put('5b6e-alice', { role: 'admin', values: { quota: 3, ai: 'peut-être' } });
  assert.equal(r.status, 422);
  assert.deepEqual(row('id = ?', alice.id), alice);

  r = await call('PUT', `${PATH}/pas.un.sub`, { json: { role: 'user' } });
  assert.deepEqual([r.status, r.data.error], [404, 'not_found']);
  r = await call('POST', `${PATH}/5b6e-alice`, { json: { role: 'user' } });
  assert.deepEqual([r.status, r.data.error], [405, 'method_not_allowed']);
  r = await call('DELETE', PATH);
  assert.equal(r.status, 405);
});

test('DELETE : compte désactivé partout (sessions, mot de passe, Board, liens de partage), données gardées ; un PUT le réactive', async () => {
  // bob a une session ouverte et un lien de partage.
  const { client: bob } = await passwordLogin('bob', 'motdepasse2', '198.51.100.43');
  const up = await bob.upload('note.pdf', PDF('bob'));
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const share = await bob.post(`/api/files/${up.data.id}/shares`, {});
  assert.equal(share.status, 201, JSON.stringify(share.data));
  const shareApi = `/api${share.data.url}`;
  assert.equal((await s.client().get(shareApi)).status, 200);

  let r = await del('5b6e-bob');
  assert.deepEqual([r.status, r.data], [200, { ok: true, message: 'Compte désactivé, ses sessions sont fermées.' }]);
  const b = row("username = 'bob'");
  assert.deepEqual([b.disabled, b.kosmy_sub], [1, '5b6e-bob']);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(b.id).n, 0, 'sessions fermées');
  assert.equal((await bob.get('/api/me')).status, 401, 'session refusée');
  assert.equal((await passwordLogin('bob', 'motdepasse2', '198.51.100.44')).status, 401, 'mot de passe refusé');
  assert.equal((await boardLogin({ sub: '5b6e-bob', name: 'Bob' }, '198.51.100.45')).location, '/login.html?kosmy=disabled', 'Board refusé');
  assert.equal((await boardLogin({ sub: '5b6e-bob', name: 'Bob', kosmy_board_access: { role: 'user', values: {} } }, '198.51.100.46')).location,
    '/login.html?kosmy=disabled', 'même avec un accès : jamais réactivé à la connexion');
  assert.equal((await s.client().get(shareApi)).status, 404, 'lien de partage coupé');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM files WHERE user_id = ?').get(b.id).n, 1, 'ses fichiers restent');
  assert.equal((await call('GET')).data.users.find((u) => u.sub === '5b6e-bob').active, false);
  // Deuxième DELETE, ou personne inconnue : rien à retirer.
  assert.deepEqual((await del('5b6e-bob')).data, { ok: true });
  assert.deepEqual([(r = await del('5b6e-inconnu')).status, r.data], [200, { ok: true }]);

  r = await put('5b6e-bob', { name: 'Bob', email: 'bob@exemple.fr', role: 'user' });
  assert.deepEqual([r.status, r.data.status], [200, 'updated']);
  assert.equal(row("username = 'bob'").disabled, 0);
  assert.equal((await passwordLogin('bob', 'motdepasse2', '198.51.100.47')).status, 200, 'réactivé');
  assert.equal((await s.client().get(shareApi)).status, 200, 'lien de partage de nouveau ouvert');
});

test('garde-fous : ni retrait de ses propres droits, ni auto-désactivation ; le dernier administrateur le reste', async () => {
  let r = await put('board-admin', { name: 'Admin', role: 'user' });
  assert.deepEqual([r.status, r.data.error, r.data.message], [409, 'conflict', 'Vous ne pouvez pas vous retirer vos propres droits d\'administration.']);
  r = await del('board-admin', { lang: 'en' });
  assert.deepEqual([r.status, r.data.error, r.data.message], [409, 'conflict', 'You can’t remove your own access.']);
  assert.deepEqual([row("username = 'admin'").role, row("username = 'admin'").disabled], ['admin', 0]);
  // Le même PUT sans retrait de droits passe (quota pour un administrateur).
  r = await put('board-admin', { name: 'Admin', role: 'admin', values: { quota: 10 } });
  assert.deepEqual([r.status, row("username = 'admin'").quota], [200, 10 * GIB]);

  // Un autre administrateur peut être rétrogradé ou désactivé tant qu'il en reste un actif.
  r = await put('5b6e-alice', { role: 'admin' });
  assert.equal(r.status, 200);
  r = await del('5b6e-alice');
  assert.equal(r.status, 200);
  r = await put('5b6e-alice', { role: 'user' });
  assert.deepEqual([r.status, row("kosmy_sub = '5b6e-alice'").role, row("kosmy_sub = '5b6e-alice'").disabled], [200, 'user', 0]);

  // À la connexion, une revendication qui retirerait ses droits au dernier administrateur actif ne les retire pas.
  const login = await boardLogin({ sub: 'board-admin', name: 'Admin', kosmy_board_access: { role: 'user', values: { quota: 5 } } }, '198.51.100.48');
  assert.equal(login.location, '/');
  assert.deepEqual([row("username = 'admin'").role, row("username = 'admin'").quota], ['admin', 5 * GIB]);
});

test('connexion avec kosmy_board_access : compte créé (sans création automatique), jamais relié par l\'e-mail ; valeurs appliquées ; accès illisible refusé', async () => {
  assert.equal((await admin.get('/api/admin/kosmy-board')).data.createAccounts, false);
  // Sans revendication : comportement inchangé (pas de compte).
  assert.equal((await boardLogin({ sub: 'claim-0', name: 'Zoé' }, '198.51.100.50')).location, '/login.html?kosmy=no-account');
  assert.equal(row("kosmy_sub = 'claim-0'"), undefined);

  // Avec revendication : compte créé et connecté, même si son adresse est celle d'un compte non relié (dup1).
  const access = { role: 'user', values: { quota: 3, allApps: false, 'app-other': true, ai: true } };
  let r = await boardLogin({ sub: 'claim-1', name: 'Claire Dupont', email: 'dup@exemple.fr', kosmy_board_access: access }, '198.51.100.51');
  assert.equal(r.location, '/');
  const me = (await r.client.get('/api/me')).data;
  assert.deepEqual([me.user.username, me.user.role, me.user.hasPassword, me.user.kosmy], ['Claire.Dupont', 'user', false, true]);
  assert.deepEqual(me.apps.map((a) => a.slug), ['other'], 'applications appliquées');
  assert.equal(me.usage.quota, 3 * GIB, 'quota appliqué');
  const claire = row("kosmy_sub = 'claim-1'");
  assert.ok(aiUsers().includes(claire.id), 'assistant IA appliqué');
  assert.equal(row("username = 'dup1'").kosmy_sub, null, 'jamais de liaison par l\'e-mail à la connexion');
  assert.equal(s.db.prepare("SELECT action FROM audit WHERE user_id = ? ORDER BY id DESC").get(claire.id).action, 'auth.kosmy.create');

  // Connexion suivante : nouvelle revendication appliquée comme un PUT.
  r = await boardLogin({ sub: 'claim-1', name: 'Claire Dupont', kosmy_board_access: { role: 'admin', values: { quota: 4 } } }, '198.51.100.52');
  assert.equal(r.location, '/');
  assert.deepEqual([row('id = ?', claire.id).role, row('id = ?', claire.id).quota], ['admin', 4 * GIB]);

  // Revendication illisible : connexion refusée, rien de créé.
  for (const bad of [{ role: 'roi' }, 'admin', { role: 'user', values: { quota: -3 } }]) {
    r = await boardLogin({ sub: 'claim-2', name: 'Pirate', kosmy_board_access: bad }, '198.51.100.53');
    assert.equal(r.location, '/login.html?kosmy=access', JSON.stringify(bad));
  }
  assert.equal(row("kosmy_sub = 'claim-2'"), undefined);
});
