// Connexion unique avec Dashy : jeton HS256 vérifié (signature, émetteur, audience, expiration, usage unique), state lié
// au navigateur par un cookie (pas de login CSRF), création ou liaison de compte.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { startServer } from './helpers.js';

const SECRET = 'secret-partage-avec-dashy', ORIGIN = 'http://crafty.test', DASHY = 'https://dashy.test';
let s;
before(async () => { s = await startServer({ ssoOptions: { secret: SECRET, dashyUrl: DASHY, origin: ORIGIN } }); });
after(() => s.close());

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims = {}, { secret = SECRET, alg = 'HS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: 'dashy', aud: ORIGIN, sub: 'u-1', email: 'marie@exemple.fr', name: 'Marie Curie', role: 'user', iat: now, exp: now + 60, jti: randomUUID(), ...claims };
  const head = b64({ alg, typ: 'JWT' }), payload = b64(body);
  return `${head}.${payload}.${createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url')}`;
}
// Début du parcours : renvoie l'adresse d'autorisation et le cookie de state posé par le serveur.
async function start(c, body = {}) {
  const r = await c.post('/api/auth/sso/dashy/start', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const url = new URL(r.data.url);
  const cookie = r.headers.getSetCookie().find((x) => x.startsWith('craft_sso=')).split(';')[0];
  return { url, state: url.searchParams.get('state'), cookie };
}
// Le client de test pose lui-même son cookie de session : on l'écarte le temps d'envoyer les deux cookies ensemble.
async function callback(c, { tok, state, cookie }) {
  const session = c.cookie;
  c.cookie = '';
  const r = await c.req('GET', `/sso/dashy/callback?token=${encodeURIComponent(tok)}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: [cookie, session].filter(Boolean).join('; ') } });
  if (!c.cookie) c.cookie = session;
  return r;
}

test('config publique et adresse d\'autorisation de Dashy', async () => {
  const c = s.client();
  assert.deepEqual((await c.get('/api/auth/config')).data.sso, { dashy: true, kosmyBoard: false });
  const { url, state } = await start(c);
  assert.equal(url.origin + url.pathname, `${DASHY}/api/sso/authorize`);
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/sso/dashy/callback`);
  assert.ok(state.length >= 32);
});

test('première connexion : compte créé (nom tiré de Dashy), session ouverte, retour à la page demandée', async () => {
  const c = s.client();
  c.ip = '198.51.100.10';
  const st = await start(c, { next: '/admin.html' });
  const r = await callback(c, { tok: token(), ...st });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin.html');
  const m = r.headers.getSetCookie().find((x) => x.startsWith('craft_sid='));
  c.cookie = m.split(';')[0];
  const me = (await c.get('/api/me')).data.user;
  assert.equal(me.username, 'Marie.Curie');
  assert.equal(me.role, 'user');
  assert.deepEqual([me.hasPassword, me.dashy], [false, true]);
  // Pas de mot de passe : la connexion par mot de passe est impossible pour ce compte.
  assert.equal((await s.client().post('/api/auth/login', { username: 'Marie.Curie', password: '!sso' })).status, 401);
});

test('refus : state absent ou d\'un autre navigateur, signature, audience, émetteur, expiration, alg, rejeu', async () => {
  const c = s.client();
  c.ip = '198.51.100.11';
  const loc = async (tok, st) => (await callback(c, { tok, ...st })).headers.get('location');
  const st = await start(c);
  assert.equal(await loc(token(), { state: st.state, cookie: null }), '/login.html?sso=state', 'cookie absent (lien envoyé par un tiers)');
  const other = await start(s.client());
  assert.equal(await loc(token(), { state: other.state, cookie: st.cookie }), '/login.html?sso=state', 'state d\'un autre navigateur');
  const fresh = async () => start(c);
  assert.equal(await loc(token({}, { secret: 'autre' }), await fresh()), '/login.html?sso=signature');
  assert.equal(await loc(token({ aud: 'https://autre-app.test' }), await fresh()), '/login.html?sso=audience');
  assert.equal(await loc(token({ iss: 'pirate' }), await fresh()), '/login.html?sso=issuer');
  assert.equal(await loc(token({ exp: Math.floor(Date.now() / 1000) - 5 }), await fresh()), '/login.html?sso=expired');
  assert.equal(await loc(token({}, { alg: 'none' }), await fresh()), '/login.html?sso=algorithm');
  const t1 = token({ sub: 'u-2', email: 'x@y.fr', name: 'X' });
  assert.equal(await loc(t1, await fresh()), '/');
  assert.equal(await loc(t1, await fresh()), '/login.html?sso=replay', 'même jti : refusé');
  const log = (await import('node:fs')).readFileSync((await import('node:path')).join(s.root, 'data', 'logs', 'auth.log'), 'utf8');
  assert.match(log, /AUTH_FAIL ip=198\.51\.100\.11 user="" reason=sso_signature/);
});

test('liaison d\'un compte existant ; identité déjà liée ailleurs refusée ; création coupée par l\'admin', async () => {
  const admin = s.client();
  admin.ip = '198.51.100.12';
  assert.equal((await admin.post('/api/auth/login', { username: 'Marie.Curie', password: 'x' })).status, 401);
  // Compte local « bob » créé par un admin : on donne le rôle admin à Marie pour cela.
  s.db.prepare("UPDATE users SET role = 'admin' WHERE username = 'Marie.Curie'").run();
  const marie = s.client(); marie.ip = '198.51.100.13';
  const st0 = await start(marie);
  const r0 = await callback(marie, { tok: token(), ...st0 });
  marie.cookie = r0.headers.getSetCookie().find((x) => x.startsWith('craft_sid=')).split(';')[0];
  assert.equal((await marie.post('/api/admin/users', { username: 'bob', password: 'motdepasse1' })).status, 201);
  const bob = s.client(); bob.ip = '198.51.100.14';
  await bob.post('/api/auth/login', { username: 'bob', password: 'motdepasse1' });
  await bob.post('/api/auth/password', { current: 'motdepasse1', password: 'motdepasse2' });
  // Bob lie son compte à l'identité Dashy u-3.
  const stl = await start(bob, { link: true });
  const rl = await callback(bob, { tok: token({ sub: 'u-3', email: 'bob@exemple.fr', name: 'Bob' }), ...stl });
  assert.equal(rl.headers.get('location'), '/?sso=linked');
  assert.equal((await bob.get('/api/me')).data.user.dashy, true);
  // Connexion Dashy de u-3 : c'est le compte de Bob (pas un nouveau compte).
  const anon = s.client(); anon.ip = '198.51.100.15';
  const st2 = await start(anon);
  const r2 = await callback(anon, { tok: token({ sub: 'u-3', email: 'bob@exemple.fr', name: 'Bob' }), ...st2 });
  anon.cookie = r2.headers.getSetCookie().find((x) => x.startsWith('craft_sid=')).split(';')[0];
  assert.equal((await anon.get('/api/me')).data.user.username, 'bob');
  // u-1 (Marie) ne peut pas être liée au compte de Bob.
  const st3 = await start(bob, { link: true });
  assert.equal((await callback(bob, { tok: token(), ...st3 })).headers.get('location'), '/?sso=linked-elsewhere');
  // Création de compte coupée : une identité inconnue est refusée.
  assert.equal((await marie.patch('/api/admin/settings', { sso_create_accounts: false })).status, 200);
  const st4 = await start(anon);
  assert.equal((await callback(anon, { tok: token({ sub: 'u-9', email: 'z@z.fr' }), ...st4 })).headers.get('location'), '/login.html?sso=no-account');
});

test('SSO non configuré : routes en 404', async () => {
  const s2 = await startServer();
  try {
    const c = s2.client();
    assert.deepEqual((await c.get('/api/auth/config')).data.sso, { dashy: false, kosmyBoard: false });
    assert.equal((await c.post('/api/auth/sso/dashy/start', {})).status, 404);
    assert.equal((await c.get('/sso/dashy/callback?token=x&state=y')).status, 404);
  } finally { s2.close(); }
});
