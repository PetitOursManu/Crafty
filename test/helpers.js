// Serveur de test : dossier temporaire, fausses applications, client HTTP avec cookies.
process.env.SCRYPT_N ??= '1024'; // hachage rapide pour les tests (le vrai coût est réglé par SCRYPT_N en production)
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

export const WASM = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(200_000, 7)]);

export async function startServer(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'craft-test-'));
  for (const slug of ['demo', 'other']) {
    const v = join(root, 'vendor', slug, '1.0.0');
    mkdirSync(join(v, 'models'), { recursive: true });
    writeFileSync(join(v, 'index.html'), `<!doctype html><title>${slug}</title><script type="module">import x from "./a.js";</script><style>body{margin:0}</style>` + 'x'.repeat(2000));
    writeFileSync(join(v, `${slug}-web-0123456789abcdef.js`), 'export default 1;' + ' '.repeat(2000));
    writeFileSync(join(v, `${slug}-web-0123456789abcdef_bg.wasm`), WASM);
    writeFileSync(join(v, 'models', 'm.onnx'), Buffer.alloc(5000, 1));
    writeFileSync(join(v, '.htaccess'), 'secret');
  }
  writeFileSync(join(root, 'apps.json'), JSON.stringify({
    demo: { name: 'Demo', version: '1.0.0', extensions: ['pdf'], prefKeys: ['demo.ui', 'shared'], data: { local: ['demo.data'], opfs: ['demo/'] } },
    other: { name: 'Other', version: '1.0.0', extensions: ['docx'], prefKeys: ['other.ui', 'shared'] },
    absent: { name: 'Absent', version: '9.9.9' },
  }));
  mkdirSync(join(root, 'public'));
  for (const p of ['index.html', 'host.html', 'admin.html', 'login.html', 'share.html', 'ui.js']) writeFileSync(join(root, 'public', p), `<!-- ${p} -->`);
  const app = createApp({ root, dataDir: join(root, 'data'), quiet: true, trustProxy: 'true', ...opts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    root, base, app, db: app.locals.db, client: () => client(base),
    close: () => { server.close(); app.locals.db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

// Client HTTP minimal avec cookie de session et en-tête Origin (requêtes de même origine).
export function client(base) {
  let cookie = '';
  const c = {
    ip: null,
    async req(method, path, { json, body, headers = {}, origin = true } = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      if (origin && method !== 'GET' && method !== 'HEAD') h.origin = base;
      if (c.ip) h['x-forwarded-for'] = c.ip;
      if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
      const r = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set) { const m = set.match(/craft_sid=([^;]*)/); if (m) cookie = m[1] ? `craft_sid=${m[1]}` : ''; }
      const buf = Buffer.from(await r.arrayBuffer());
      let data = null;
      try { data = JSON.parse(buf.toString()); } catch {}
      return { status: r.status, headers: r.headers, buf, data };
    },
    get: (p, o) => c.req('GET', p, o),
    post: (p, json, o = {}) => c.req('POST', p, { json, ...o }),
    patch: (p, json, o = {}) => c.req('PATCH', p, { json, ...o }),
    del: (p, o) => c.req('DELETE', p, o),
    upload: (name, bytes, folder = 'root', extra = '') => c.req('POST', `/api/files?folder=${folder}${extra}`, { body: bytes, headers: { 'x-file-name': encodeURIComponent(name) } }),
    put: (id, bytes, app) => c.req('PUT', `/api/files/${id}/content`, { body: bytes, headers: app ? { 'x-app': app } : {} }),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
  return c;
}
export const PDF = (s = '') => Buffer.from(`%PDF-1.7 ${s}`);
