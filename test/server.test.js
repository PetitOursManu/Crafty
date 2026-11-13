// Tests du service statique : MIME, 404 sans repli, cache, compression, chemins, /api/echo.
// Utilise une fausse application dans un dossier temporaire : ne dépend pas de vendor/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createApp } from '../server.js';

const WASM = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(200_000, 7)]);
let dir, server, port;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'craft-host-test-'));
  const v = join(dir, 'vendor', 'demo', '1.0.0');
  mkdirSync(join(v, 'models'), { recursive: true });
  writeFileSync(join(v, 'index.html'), '<!doctype html><title>demo</title>' + 'x'.repeat(2000));
  writeFileSync(join(v, 'demo-web-0123456789abcdef.js'), 'export default 1;' + ' '.repeat(2000));
  writeFileSync(join(v, 'demo-web-0123456789abcdef_bg.wasm'), WASM);
  writeFileSync(join(v, 'models', 'm.onnx'), Buffer.alloc(5000, 1));
  writeFileSync(join(v, '.htaccess'), 'secret');
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ demo: { version: '1.0.0' } }));
  server = createApp({ vendorDir: join(dir, 'vendor'), appsFile: join(dir, 'apps.json'), csp: 'off' }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

function req(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

test('wasm : application/wasm, immutable, octets intacts', async () => {
  const r = await req('/apps/demo/demo-web-0123456789abcdef_bg.wasm');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/wasm');
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['content-encoding'], undefined);
  assert.deepEqual(r.body, WASM);
});

test('js : text/javascript, immutable', async () => {
  const r = await req('/apps/demo/demo-web-0123456789abcdef.js');
  assert.match(r.headers['content-type'], /^text\/javascript/);
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('index.html : no-cache, servi pour /apps/demo/', async () => {
  for (const p of ['/apps/demo/', '/apps/demo/index.html', '/apps/demo/?host=parent']) {
    const r = await req(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['cache-control'], 'no-cache');
  }
});

test('fichier non haché (modèle OCR) : no-cache + ETag, 304 sur If-None-Match', async () => {
  const r = await req('/apps/demo/models/m.onnx');
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.ok(r.headers.etag);
  const r2 = await req('/apps/demo/models/m.onnx', { headers: { 'if-none-match': r.headers.etag } });
  assert.equal(r2.status, 304);
});

test('compression : br préféré, gzip sinon, Vary', async () => {
  const b = await req('/apps/demo/demo-web-0123456789abcdef_bg.wasm', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.equal(b.headers['content-encoding'], 'br');
  assert.equal(b.headers.vary, 'Accept-Encoding');
  assert.ok(b.body.length < WASM.length / 10);
  assert.deepEqual(brotliDecompressSync(b.body), WASM);
  const g = await req('/apps/demo/demo-web-0123456789abcdef_bg.wasm', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(g.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(g.body), WASM);
});

test('404 pour tout fichier absent, sans repli vers index.html', async () => {
  for (const p of ['/apps/demo/absent.wasm', '/apps/demo/x/y/z.js', '/apps/demo/models/', '/apps/inconnue/', '/apps/demo/.htaccess',
    '/apps/demo/..%2f..%2fapps.json', '/apps/demo/%2e%2e/%2e%2e/apps.json', '/apps/demo/models%5c..%5c..%5capps.json', '/apps/demo/%252e%252e/%252e%252e/apps.json', '/%2e%2e/apps.json', '/.claude/launch.json', '/apps/demo/%00']) {
    const r = await req(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body.toString(), /<title>demo/, p);
  }
});

test('/api/apps : seulement les applications présentes dans vendor/', async () => {
  const r = await req('/api/apps');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), [{ slug: 'demo', name: 'demo', description: '', version: '1.0.0', extensions: [] }]);
});

test('/ sert le tableau de bord, /host.html la page hôte', async () => {
  const d = await req('/');
  assert.equal(d.status, 200);
  assert.match(d.body.toString(), /dashboard\.js/);
  assert.match((await req('/host.html')).body.toString(), /host\.js/);
});

test('/apps/demo redirige vers /apps/demo/ en gardant la requête', async () => {
  const r = await req('/apps/demo?host=parent&webgl');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/apps/demo/?host=parent&webgl');
});

test('CSP auto : stricte, avec les empreintes du script et du style en ligne de index.html', async () => {
  const { createHash } = await import('node:crypto');
  const v = join(dir, 'vendor', 'demo', '1.0.0');
  writeFileSync(join(v, 'index.html'), '<script type="module">import x from "./a.js";</script><style>body{margin:0}</style><script src="./b.js"></script>');
  const srv = createApp({ vendorDir: join(dir, 'vendor'), appsFile: join(dir, 'apps.json'), csp: 'auto' }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const p = port;
  port = srv.address().port;
  try {
    const h = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    const a = (await req('/apps/demo/')).headers['content-security-policy'];
    assert.match(a, /default-src 'none'/);
    assert.ok(a.includes(`script-src 'self' 'wasm-unsafe-eval' ${h('import x from "./a.js";')}`), a);
    assert.ok(a.includes(`style-src 'self' ${h('body{margin:0}')}`), a);
    assert.equal(a.match(/sha256-/g).length, 2);
    assert.match(a, /frame-ancestors 'self'/);
    const host = (await req('/host.html')).headers['content-security-policy'];
    assert.doesNotMatch(host, /sha256-/);
    assert.match(host, /frame-src 'self'/);
  } finally { srv.close(); port = p; }
});

test('/api/echo : stocke puis rend les octets ; refuse une autre origine', async () => {
  const body = Buffer.from('%PDF-1.7 test');
  const p = await req('/api/echo', { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent('é.pdf'), 'content-type': 'application/pdf', 'sec-fetch-site': 'same-origin' } });
  assert.equal(p.status, 201);
  const { id, size } = JSON.parse(p.body);
  assert.equal(size, body.length);
  const g = await req(`/api/echo/${id}`);
  assert.deepEqual(g.body, body);
  assert.match(g.headers['content-disposition'], /%C3%A9\.pdf/);
  const x = await req('/api/echo', { method: 'POST', body, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(x.status, 403);
  const o = await req('/api/echo', { method: 'POST', body, headers: { origin: 'https://evil.example' } });
  assert.equal(o.status, 403);
  assert.equal((await req('/api/echo/nope')).status, 404);
});
