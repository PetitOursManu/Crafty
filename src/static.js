// Fichiers statiques : MIME, compression, cache, 404 strict, CSP par application (vérifié en phase 0).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { brotliCompress, gzip, constants as Z } from 'node:zlib';
import { promisify } from 'node:util';
import { MIME, COMPRESSIBLE, etagOf } from './static-rules.js';

export { COMPRESSIBLE, etagOf };
const br = promisify(brotliCompress), gz = promisify(gzip);
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
// precompressedDir : sortie de scripts/precompress.mjs (Brotli 11 + gzip au build), servie depuis le disque.
// Sinon, compression à la volée (Brotli 9) gardée en mémoire dans la limite de cacheBytes (les plus anciens sortent).
export function createStatic({ apps, vendorDir, csp, precompressedDir = null,
  cacheBytes = Number(process.env.STATIC_CACHE_MB ?? 256) * 1024 ** 2 }) {
  let pre = {};
  try { if (precompressedDir && existsSync(join(precompressedDir, 'manifest.json'))) pre = JSON.parse(readFileSync(join(precompressedDir, 'manifest.json'), 'utf8')); }
  catch (e) { console.warn(`precompressed/manifest.json illisible : ${e.message}`); }
  const appCsp = {};
  if (csp === 'auto') for (const [slug, a] of Object.entries(apps)) {
    try { const h = inlineHashes(readFileSync(join(vendorDir, slug, a.version, 'index.html'), 'utf8')); appCsp[slug] = STRICT(h.scripts, [...h.styles, ...RUNTIME_STYLES]); }
    catch { appCsp[slug] = STRICT([], RUNTIME_STYLES); }
  }
  const cache = new Map(); // fichier|encodage → { mtime, size, p: Promise<{ body, etag }> }, ordre = ancienneté d'usage
  let cached = 0;
  const etags = new Map(); // fichier → { mtime, size, etag } pour les fichiers servis tels quels
  const remember = (key, entry) => {
    cache.set(key, entry);
    entry.p.then((c) => {
      if (cache.get(key) !== entry) return;
      entry.bytes = c.body.length; cached += entry.bytes;
      for (const [k, v] of cache) { if (cached <= cacheBytes || k === key) break; cache.delete(k); cached -= v.bytes || 0; }
    }, () => {});
  };

  function headers(req, res, next) {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    const slug = req.path.match(/^\/apps\/([a-z0-9-]+)\//)?.[1];
    const policy = csp === 'auto' ? (slug ? appCsp[slug] : STRICT()) : csp;
    if (policy && policy !== 'off') res.set('Content-Security-Policy', policy);
    next();
  }

  // transform(texte) → texte : contenu réécrit avant compression (adresses versionnées de public/), gardé en cache sous
  // variant (la version) avec le fichier, sa date et sa taille.
  async function sendStatic(req, res, file, cacheControl, { transform = null, variant = '' } = {}) {
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return notFound(res);
    const ext = extname(file).toLowerCase();
    const ae = String(req.headers['accept-encoding'] || '');
    const okBr = /\bbr\b/.test(ae), okGz = /\bgzip\b/.test(ae);
    res.set({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl,
      'Last-Modified': st.mtime.toUTCString(), Vary: 'Accept-Encoding' });
    const send = (etag, enc, length, body, path) => {
      res.set('ETag', etag);
      if (enc) res.set('Content-Encoding', enc);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.set('Content-Length', String(length));
      if (req.method === 'HEAD') return res.end();
      if (body) return res.end(body);
      const s = createReadStream(path);
      s.on('error', () => res.destroy());
      s.pipe(res);
    };

    // 1. Précompressé au build : servi depuis le disque si le fichier d'origine a toujours la même taille.
    const rel = file.startsWith(vendorDir + sep) ? relative(vendorDir, file).split(sep).join('/') : null;
    const p = rel ? pre[rel] : null;
    if (p && p.size === st.size) {
      const enc = okBr && p.br ? 'br' : okGz && p.gz ? 'gzip' : null;
      if (!enc) return send(`"${p.etag}"`, null, st.size, null, file);
      return send(`"${p.etag}-${enc}"`, enc, enc === 'br' ? p.br : p.gz, null, join(precompressedDir, `${rel}.${enc === 'br' ? 'br' : 'gz'}`));
    }

    // 2. Tel quel : lu depuis le disque, seule l'empreinte reste en mémoire.
    const enc = !COMPRESSIBLE.has(ext) ? null : okBr ? 'br' : okGz ? 'gzip' : null;
    if (!enc && !transform) {
      let t = etags.get(file);
      if (!t || t.mtime !== st.mtimeMs || t.size !== st.size) {
        t = { mtime: st.mtimeMs, size: st.size, etag: etagOf(await readFile(file)) };
        etags.set(file, t);
        if (etags.size > 20_000) etags.delete(etags.keys().next().value);
      }
      return send(`"${t.etag}"`, null, st.size, null, file);
    }

    // 3. Compressé à la volée (ou seulement réécrit). Promesse en cache : deux requêtes simultanées (preload + chargement)
    // ne compressent qu'une fois.
    const key = `${file}|${enc || 'identity'}|${transform ? variant : ''}`;
    let c = cache.get(key);
    if (c && (c.mtime !== st.mtimeMs || c.size !== st.size)) { cache.delete(key); cached -= c.bytes || 0; c = null; }
    if (c) { cache.delete(key); cache.set(key, c); } // plus récemment utilisé
    else remember(key, c = { mtime: st.mtimeMs, size: st.size, p: (async () => {
      let raw = await readFile(file);
      if (transform) raw = Buffer.from(transform(raw.toString('utf8')), 'utf8');
      const body = enc === 'br'
        ? await br(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: 9, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : enc === 'gzip' ? await gz(raw, { level: 9 }) : raw;
      return { body, etag: `"${etagOf(raw)}${enc ? `-${enc}` : ''}"` };
    })() });
    const r = await c.p.catch((err) => { if (cache.get(key) === c) cache.delete(key); throw err; });
    return send(r.etag, enc, r.body.length, r.body);
  }

  return { headers, sendStatic, immutable: (rel) => (HASHED.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache') };
}
