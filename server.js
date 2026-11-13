// Prototype phase 0 : sert les applications Craft sous /apps/<slug>/ et une page hôte.
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompress, gzip, constants as Z } from 'node:zlib';
import { promisify } from 'node:util';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const br = promisify(brotliCompress), gz = promisify(gzip);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.onnx': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
};
// .onnx (modèles OCR) : gain de compression nul (mesuré), donc servis tels quels.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.wasm', '.json', '.css', '.svg', '.txt', '.md', '.toml']);
// Noms produits par trunk : <nom>-<16 hex>[_bg|_loader].<ext>
const HASHED = /-[0-9a-f]{16}(_bg|_loader)?\.(wasm|js|ico|css)$/;
// Politique la plus stricte vérifiée en phase 0 (FINDINGS.md, question 7). Les empreintes du script et du
// style en ligne de chaque index.html sont ajoutées par application ('auto'). Trusted Types casse l'OCR.
const STRICT = (scripts = [], styles = []) => [
  "default-src 'none'", `script-src 'self' 'wasm-unsafe-eval'${scripts.map((h) => ` '${h}'`).join('')}`,
  `style-src 'self'${styles.map((h) => ` '${h}'`).join('')}`, "worker-src 'self'", "img-src 'self'", "connect-src 'self'",
  "font-src 'self'", "frame-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');
const sha = (s) => `sha256-${createHash('sha256').update(s).digest('base64')}`;
export function inlineHashes(html) {
  const grab = (re) => [...html.matchAll(re)].map((m) => sha(m[1]));
  return { scripts: grab(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi), styles: grab(/<style[^>]*>([\s\S]*?)<\/style>/gi) };
}

// csp : 'auto' (défaut, politique stricte par application), 'off', ou une politique fixe pour tout le site.
export function createApp({ vendorDir = join(ROOT, 'vendor'), appsFile = join(ROOT, 'apps.json'), csp = process.env.CSP ?? 'auto' } = {}) {
  const apps = JSON.parse(readFileSync(appsFile, 'utf8'));
  const appCsp = {};
  if (csp === 'auto') for (const [slug, a] of Object.entries(apps)) {
    try { const h = inlineHashes(readFileSync(join(vendorDir, slug, a.version, 'index.html'), 'utf8')); appCsp[slug] = STRICT(h.scripts, h.styles); }
    catch { appCsp[slug] = STRICT(); }
  }
  const cache = new Map(); // chemin|encodage → { body, etag, mtime }
  const echo = new Map();  // id → { name, type, bytes, at }
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    const slug = req.path.match(/^\/apps\/([a-z0-9-]+)\//)?.[1];
    const policy = csp === 'auto' ? (slug ? appCsp[slug] : STRICT()) : csp;
    if (policy && policy !== 'off') res.set('Content-Security-Policy', policy);
    next();
  });

  async function sendStatic(req, res, file, cacheControl) {
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return notFound(res);
    const ext = extname(file).toLowerCase();
    const ae = String(req.headers['accept-encoding'] || '');
    const enc = !COMPRESSIBLE.has(ext) ? null : /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
    const key = `${file}|${enc}`;
    // On met la promesse en cache : deux requêtes simultanées (preload + chargement) ne compressent qu'une fois.
    if (cache.get(key)?.mtime !== st.mtimeMs) cache.set(key, { mtime: st.mtimeMs, p: (async () => {
      const raw = await readFile(file);
      const body = enc === 'br'
        ? await br(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: 9, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : enc === 'gzip' ? await gz(raw, { level: 9 }) : raw;
      return { body, etag: `"${createHash('sha256').update(raw).digest('base64url').slice(0, 27)}${enc ? `-${enc}` : ''}"` };
    })() });
    const c = await cache.get(key).p.catch((e) => { cache.delete(key); throw e; });
    res.set({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl, ETag: c.etag,
      'Last-Modified': st.mtime.toUTCString(), Vary: 'Accept-Encoding' });
    if (enc) res.set('Content-Encoding', enc);
    if (req.headers['if-none-match'] === c.etag) return res.status(304).end();
    res.set('Content-Length', String(c.body.length));
    return req.method === 'HEAD' ? res.end() : res.end(c.body);
  }

  // /apps/<slug> → /apps/<slug>/ (les URL de l'application sont relatives)
  app.get(/^\/apps\/([a-z0-9-]+)$/, (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect(301, `/apps/${req.params[0]}/${q >= 0 ? req.originalUrl.slice(q) : ''}`);
  });

  // Chemin brut (req.path, non décodé) → fichier sous base, ou null. Décodé une seule fois ; refuse les fichiers
  // cachés (.htaccess), la remontée, l'antislash et l'octet nul.
  function safeFile(base, raw, index) {
    let rel;
    try { rel = decodeURIComponent(raw || index); } catch { return null; }
    if (rel.endsWith('/')) rel += index;
    if (/[\\\0]/.test(rel) || rel.split('/').some((s) => s === '..' || s.startsWith('.'))) return null;
    const file = resolve(base, rel);
    return file.startsWith(base + sep) ? { file, rel } : null;
  }
  const notFound = (res) => res.status(404).type('text/plain').send('404\n');

  app.get(/^\/apps\/([a-z0-9-]+)\/(.*)$/, async (req, res, next) => {
    try {
      const slug = req.path.split('/')[2], a = apps[slug];
      const f = a && safeFile(resolve(vendorDir, slug, a.version), req.path.slice(`/apps/${slug}/`.length), 'index.html');
      if (!f) return notFound(res);
      return await sendStatic(req, res, f.file, HASHED.test(f.rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
    } catch (e) { next(e); }
  });

  // Simulation de stockage. Contrôle d'origine sur l'écriture (règle 5 de CLAUDE.md).
  app.post('/api/echo', (req, res, next) => {
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    const self = `${req.protocol}://${req.headers.host}`;
    if ((site && site !== 'same-origin') || (origin && origin !== self)) return res.status(403).json({ error: 'origine refusée' });
    if (req.query.fail) return res.status(500).json({ error: 'échec simulé' });
    next();
  }, express.raw({ type: () => true, limit: '600mb' }), (req, res) => {
    const id = randomUUID();
    let name = 'sans-nom';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || name)); } catch {}
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    echo.set(id, { name, type: req.headers['content-type'] || 'application/octet-stream', bytes, at: new Date().toISOString() });
    res.status(201).json({ id, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  });
  app.get('/api/echo', (req, res) => {
    res.set('Cache-Control', 'no-store').json([...echo].map(([id, e]) => ({ id, name: e.name, size: e.bytes.length, at: e.at })));
  });
  app.get('/api/echo/:id', (req, res) => {
    const e = echo.get(req.params.id);
    if (!e) return res.status(404).json({ error: 'inconnu' });
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(e.name)}` }).end(e.bytes);
  });

  // Registre pour le tableau de bord : seulement les applications présentes dans vendor/.
  app.get('/api/apps', (req, res) => res.set('Cache-Control', 'no-store').json(Object.entries(apps)
    .filter(([slug, a]) => existsSync(join(vendorDir, slug, a.version, 'index.html')))
    .map(([slug, a]) => ({ slug, name: a.name || slug, description: a.description || '', version: a.version, extensions: a.extensions || [] }))));

  // Tableau de bord (index.html), page hôte et fichiers de test
  app.get(/^\/(.*)$/, async (req, res, next) => {
    try {
      const f = safeFile(resolve(ROOT, 'public'), req.path.slice(1), 'index.html');
      return f ? await sendStatic(req, res, f.file, 'no-cache') : notFound(res);
    } catch (e) { next(e); }
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Boucle locale seulement (IPv4 et IPv6) : rien n'est exposé hors de la machine.
  const port = Number(process.env.PORT || 8787), app = createApp();
  app.listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/`));
  app.listen(port, '::1').on('error', (e) => console.warn(`[::1]:${port} indisponible : ${e.code}`));
}
