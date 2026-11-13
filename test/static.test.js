// Fichiers statiques des applications : MIME, cache, compression, 404 strict, CSP, accès réservé.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { startServer, WASM } from './helpers.js';

let s, c;
before(async () => {
  s = await startServer();
  c = s.client();
  assert.equal((await c.post('/api/auth/register', { username: 'admin', password: 'motdepasse1' })).status, 201);
});
after(() => s.close());

const W = '/apps/demo/demo-web-0123456789abcdef_bg.wasm';

test('sans session : applications en 404, pages redirigées vers la connexion', async () => {
  const anon = s.client();
  assert.equal((await anon.get(W)).status, 404);
  assert.equal((await anon.get('/apps/demo/')).status, 404);
  const r = await anon.get('/host.html?app=demo');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login.html?next=%2Fhost.html%3Fapp%3Ddemo');
  assert.equal((await anon.get('/login.html')).status, 200);
});

test('wasm : application/wasm, immutable, octets intacts', async () => {
  const r = await c.get(W, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/wasm');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(r.buf, WASM);
});

test('compression : br préféré, gzip sinon', async () => {
  const { request } = await import('node:http');
  const raw = (enc) => new Promise((resolve) => {
    const u = new URL(s.base + W);
    request({ host: u.hostname, port: u.port, path: u.pathname, headers: { 'accept-encoding': enc, cookie: c.cookie } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve({ h: res.headers, body: Buffer.concat(chunks) }));
    }).end();
  });
  const b = await raw('gzip, deflate, br');
  assert.equal(b.h['content-encoding'], 'br');
  assert.equal(b.h.vary, 'Accept-Encoding');
  assert.deepEqual(brotliDecompressSync(b.body), WASM);
  const g = await raw('gzip');
  assert.equal(g.h['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(g.body), WASM);
});

test('index.html : no-cache ; modèle OCR non haché : no-cache + ETag + 304', async () => {
  const i = await c.get('/apps/demo/?host=parent');
  assert.equal(i.status, 200);
  assert.equal(i.headers.get('cache-control'), 'no-cache');
  const m = await c.get('/apps/demo/models/m.onnx');
  assert.equal(m.headers.get('cache-control'), 'no-cache');
  const r = await c.get('/apps/demo/models/m.onnx', { headers: { 'if-none-match': m.headers.get('etag') } });
  assert.equal(r.status, 304);
});

test('404 pour tout fichier absent ou chemin douteux, sans repli vers index.html', async () => {
  for (const p of ['/apps/demo/absent.wasm', '/apps/demo/x/y/z.js', '/apps/demo/models/', '/apps/inconnue/', '/apps/absent/',
    '/apps/demo/.htaccess', '/apps/demo/..%2f..%2fapps.json', '/apps/demo/%2e%2e/%2e%2e/apps.json', '/apps/demo/models%5c..%5c..%5capps.json',
    '/apps/demo/%252e%252e/%252e%252e/apps.json', '/%2e%2e/apps.json', '/.claude/launch.json', '/apps/demo/%00', '/data/craft.db']) {
    const r = await c.get(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.buf.toString(), /<title>demo/, p);
  }
});

test('/apps/demo redirige vers /apps/demo/ en gardant la requête', async () => {
  const r = await c.get('/apps/demo?host=parent&webgl');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/apps/demo/?host=parent&webgl');
});

test('CSP stricte, avec les empreintes du script et du style en ligne de chaque application', async () => {
  const hsh = (x) => `'sha256-${createHash('sha256').update(x).digest('base64')}'`;
  const a = (await c.get('/apps/demo/')).headers.get('content-security-policy');
  assert.match(a, /default-src 'none'/);
  assert.ok(a.includes(`script-src 'self' 'wasm-unsafe-eval' ${hsh('import x from "./a.js";')}`), a);
  assert.ok(a.includes(`style-src 'self' ${hsh('body{margin:0}')}`), a);
  assert.match(a, /frame-ancestors 'self'/);
  const page = (await c.get('/')).headers.get('content-security-policy');
  assert.doesNotMatch(page, /sha256-/);
  assert.match(page, /frame-src 'self'/);
});

test('/api/me liste les applications présentes dans vendor/ seulement', async () => {
  const r = await c.get('/api/me');
  assert.deepEqual(r.data.apps.map((a) => a.slug), ['demo', 'other']);
});
