// Précompression au build (scripts/precompress.mjs) et service des fichiers précompressés (src/static.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { startServer, client, WASM } from './helpers.js';
import { createApp } from '../src/app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const W = '/apps/demo/demo-web-0123456789abcdef_bg.wasm';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function fetchRaw(base, path, enc, cookie) {
  const { request } = await import('node:http');
  return new Promise((resolve) => {
    const u = new URL(base + path);
    request({ host: u.hostname, port: u.port, path: u.pathname, headers: { 'accept-encoding': enc, cookie } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(chunks) }));
    }).end();
  });
}

test('précompression : script incrémental, fichiers servis depuis le disque, repli si le fichier a changé', async () => {
  const s = await startServer();
  const servers = [];
  try {
    const env = { ...process.env, APPS_FILE: join(s.root, 'apps.json'), VENDOR_DIR: join(s.root, 'vendor'),
      PRECOMPRESSED_DIR: join(s.root, 'precompressed'), PRECOMPRESS_QUALITY: '4' };
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'precompress.mjs')], { env, encoding: 'utf8' });
    assert.match(out, /absent : absent de vendor\/|absent 9\.9\.9 : absent de vendor\/, ignoré/);
    const manifest = JSON.parse(readFileSync(join(s.root, 'precompressed', 'manifest.json'), 'utf8'));
    const rel = 'demo/1.0.0/demo-web-0123456789abcdef_bg.wasm';
    assert.equal(manifest[rel].size, WASM.length);
    assert.ok(manifest[rel].br && manifest[rel].gz);
    assert.ok(!Object.keys(manifest).some((k) => k.endsWith('.onnx')), 'modèles .onnx jamais compressés');
    // Relancé : rien à refaire.
    assert.match(execFileSync(process.execPath, [join(ROOT, 'scripts', 'precompress.mjs')], { env, encoding: 'utf8' }), /, 0 compressé\(s\)/);

    const app = createApp({ root: s.root, dataDir: join(s.root, 'data2'), quiet: true });
    const a = await listen(app); servers.push([a.server, app]);
    const c = client(a.base);
    assert.equal((await c.post('/api/auth/register', { username: 'admin', password: 'motdepasse1' })).status, 201);
    const onDisk = readFileSync(join(s.root, 'precompressed', `${rel}.br`));
    const b = await fetchRaw(a.base, W, 'gzip, br', c.cookie);
    assert.equal(b.h['content-encoding'], 'br');
    assert.deepEqual(b.body, onDisk, 'octets du fichier précompressé');
    assert.deepEqual(brotliDecompressSync(b.body), WASM);
    assert.equal(b.h.etag, `"${manifest[rel].etag}-br"`);
    assert.equal(b.h['cache-control'], 'public, max-age=31536000, immutable');
    const g = await fetchRaw(a.base, W, 'gzip', c.cookie);
    assert.deepEqual(gunzipSync(g.body), WASM);
    const i = await fetchRaw(a.base, W, 'identity', c.cookie);
    assert.deepEqual(i.body, WASM);
    assert.equal(i.h.etag, `"${manifest[rel].etag}"`);
    assert.equal((await fetchRaw(a.base, W, 'br', `${c.cookie}`)).status, 200);

    // Manifeste qui ne correspond plus (taille différente) : compression à la volée, contenu juste.
    cpSync(join(s.root, 'precompressed'), join(s.root, 'pre2'), { recursive: true });
    manifest[rel].size += 1;
    writeFileSync(join(s.root, 'pre2', 'manifest.json'), JSON.stringify(manifest));
    const app2 = createApp({ root: s.root, dataDir: join(s.root, 'data3'), precompressedDir: join(s.root, 'pre2'), quiet: true });
    const a2 = await listen(app2); servers.push([a2.server, app2]);
    const c2 = client(a2.base);
    assert.equal((await c2.post('/api/auth/register', { username: 'admin', password: 'motdepasse1' })).status, 201);
    const f = await fetchRaw(a2.base, W, 'br', c2.cookie);
    assert.notDeepEqual(f.body, onDisk);
    assert.deepEqual(brotliDecompressSync(f.body), WASM);
  } finally {
    for (const [srv, app] of servers) { srv.close(); app.locals.db.close(); }
    s.close();
  }
});
