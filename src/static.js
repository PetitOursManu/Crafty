// Fichiers statiques : MIME, compression, cache, 404 strict, CSP par application (vérifié en phase 0).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { brotliCompress, gzip, constants as Z } from 'node:zlib';
import { promisify } from 'node:util';

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
export const HASHED = /-[0-9a-f]{16}(_bg|_loader)?\.(wasm|js|ico|css)$/;
// Politique la plus stricte vérifiée en phase 0 (FINDINGS.md § 7). Trusted Types casse l'OCR de PdfCraft.
export const STRICT = (scripts = [], styles = []) => [
  "default-src 'none'", `script-src 'self' 'wasm-unsafe-eval'${scripts.map((h) => ` '${h}'`).join('')}`,
  `style-src 'self'${styles.map((h) => ` '${h}'`).join('')}`, "worker-src 'self'", "img-src 'self'", "connect-src 'self'",
  "font-src 'self'", "frame-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');
const sha = (s) => `sha256-${createHash('sha256').update(s).digest('base64')}`;
// Styles insérés à l'exécution par des bibliothèques communes aux applications (vérifié le 14/11/2026) :
// rfd (boîte « Ouvrir ») ajoute un <style> constant pour #rfd-overlay. Si une version le change, le contrôle de
// CSP de npm run test:e2e échoue : relever la nouvelle empreinte dans la console et la mettre ici.
// CadCraft crée son champ fichier avec l'attribut style="display:none" : un attribut ne s'autorise par empreinte
// qu'avec 'unsafe-hashes', limité ici à cette seule valeur.
const RUNTIME_STYLES = ['unsafe-hashes', 'sha256-9tSqG2Th9gNn6sbn1ZYMSqakJLznxnsamRDeigez2Mo=',
  'sha256-aqNNdDLnnrDOnTNdkJpYlAxKVJtLt9CtFLklmInuUAE=' /* display:none */];
export function inlineHashes(html) {
  const grab = (re) => [...html.matchAll(re)].map((m) => sha(m[1]));
  return { scripts: grab(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi), styles: grab(/<style[^>]*>([\s\S]*?)<\/style>/gi) };
}

export const notFound = (res) => res.status(404).type('text/plain').send('404\n');

// Chemin brut (non décodé) → fichier sous base, ou null. Décodé une seule fois ; refuse les fichiers cachés
// (.htaccess), la remontée, l'antislash et l'octet nul.
export function safeFile(base, raw, index) {
  let rel;
  try { rel = decodeURIComponent(raw || index); } catch { return null; }
  if (rel.endsWith('/')) rel += index;
  if (/[\\\0]/.test(rel) || rel.split('/').some((s) => s === '..' || s.startsWith('.'))) return null;
  const file = resolve(base, rel);
  return file.startsWith(base + sep) ? { file, rel } : null;
}

// csp : 'auto' (politique stricte, empreintes du script et du style en ligne de chaque index.html), 'off', ou fixe.
export function createStatic({ apps, vendorDir, csp }) {
  const appCsp = {};
  if (csp === 'auto') for (const [slug, a] of Object.entries(apps)) {
    try { const h = inlineHashes(readFileSync(join(vendorDir, slug, a.version, 'index.html'), 'utf8')); appCsp[slug] = STRICT(h.scripts, [...h.styles, ...RUNTIME_STYLES]); }
    catch { appCsp[slug] = STRICT([], RUNTIME_STYLES); }
  }
  const cache = new Map();

  function headers(req, res, next) {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    const slug = req.path.match(/^\/apps\/([a-z0-9-]+)\//)?.[1];
    const policy = csp === 'auto' ? (slug ? appCsp[slug] : STRICT()) : csp;
    if (policy && policy !== 'off') res.set('Content-Security-Policy', policy);
    next();
  }

  async function sendStatic(req, res, file, cacheControl) {
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return notFound(res);
    const ext = extname(file).toLowerCase();
    const ae = String(req.headers['accept-encoding'] || '');
    const enc = !COMPRESSIBLE.has(ext) ? null : /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
    const key = `${file}|${enc}`;
    // Promesse en cache : deux requêtes simultanées (preload + chargement) ne compressent qu'une fois.
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

  return { headers, sendStatic, immutable: (rel) => (HASHED.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache') };
}
