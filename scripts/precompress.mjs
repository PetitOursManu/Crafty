#!/usr/bin/env node
// Usage : node scripts/precompress.mjs   (variables : PRECOMPRESS_QUALITY=11, PRECOMPRESS_JOBS=<cœurs>)
// Précompresse au build (CLAUDE.md : Brotli 11 + gzip) les fichiers compressibles des applications installées dans
// vendor/ (activées dans apps.json), dans precompressed/<slug>/<version>/<fichier>.br|.gz. vendor/ n'est pas touché.
// precompressed/manifest.json donne pour chaque fichier sa taille et son ETag : le serveur ne sert la version
// précompressée que si la taille du fichier d'origine est la même (src/static.js). Relancer ne refait que ce qui manque.
// Mesuré : wasm de 61 Mo → environ 13 Mo en Brotli 11, environ 2 min de CPU par fichier.
import { availableParallelism } from 'node:os';
process.env.UV_THREADPOOL_SIZE ||= String(Math.max(4, availableParallelism())); // avant tout appel asynchrone

const { createHash } = await import('node:crypto');
const { existsSync } = await import('node:fs');
const { mkdir, readFile, readdir, rename, writeFile, stat } = await import('node:fs/promises');
const { dirname, extname, join, relative, resolve, sep } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { promisify } = await import('node:util');
const { brotliCompress, gzip, constants: Z } = await import('node:zlib');
const { COMPRESSIBLE, etagOf } = await import('../src/static-rules.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = process.env.VENDOR_DIR || join(ROOT, 'vendor');
const OUT = process.env.PRECOMPRESSED_DIR || join(ROOT, 'precompressed');
const QUALITY = Number(process.env.PRECOMPRESS_QUALITY || 11);
const JOBS = Number(process.env.PRECOMPRESS_JOBS || availableParallelism());
const MIN_SIZE = 1024; // en dessous, la compression à la volée suffit
const br = promisify(brotliCompress), gz = promisify(gzip);

const apps = JSON.parse(await readFile(process.env.APPS_FILE || join(ROOT, 'apps.json'), 'utf8'));
const manifestPath = join(OUT, 'manifest.json');
const old = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
const manifest = {};

async function walk(dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p))); else out.push(p);
  }
  return out;
}
async function writeAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, data);
  await rename(`${file}.tmp`, file);
}

const todo = [];
for (const [slug, a] of Object.entries(apps)) {
  if (a.enabled === false) continue;
  const dir = join(VENDOR, slug, a.version);
  if (!existsSync(dir)) { console.log(`${slug} ${a.version} : absent de vendor/, ignoré`); continue; }
  for (const f of await walk(dir)) {
    if (!COMPRESSIBLE.has(extname(f).toLowerCase())) continue;
    const st = await stat(f);
    if (st.size < MIN_SIZE) continue;
    todo.push({ file: f, rel: relative(VENDOR, f).split(sep).join('/'), size: st.size });
  }
}

let done = 0, saved = 0, raw = 0;
const t0 = Date.now();
async function one({ file, rel, size }) {
  const prev = old[rel];
  if (prev && prev.size === size && (!prev.br || existsSync(join(OUT, `${rel}.br`))) && (!prev.gz || existsSync(join(OUT, `${rel}.gz`)))) {
    manifest[rel] = prev;
    return;
  }
  const data = await readFile(file);
  const entry = { size, etag: etagOf(data) };
  const [b, g] = await Promise.all([
    br(data, { params: { [Z.BROTLI_PARAM_QUALITY]: QUALITY, [Z.BROTLI_PARAM_LGWIN]: 24, [Z.BROTLI_PARAM_SIZE_HINT]: size } }),
    gz(data, { level: 9 }),
  ]);
  // Une version compressée qui ne gagne rien n'est pas gardée : le fichier part tel quel.
  if (b.length < size * 0.95) { await writeAtomic(join(OUT, `${rel}.br`), b); entry.br = b.length; }
  if (g.length < size * 0.95) { await writeAtomic(join(OUT, `${rel}.gz`), g); entry.gz = g.length; }
  manifest[rel] = entry;
  raw += size; saved += size - (entry.br ?? size);
  done++;
  console.log(`${rel} : ${(size / 1e6).toFixed(1)} Mo → br ${entry.br ? (entry.br / 1e6).toFixed(1) : '—'} Mo, gz ${entry.gz ? (entry.gz / 1e6).toFixed(1) : '—'} Mo`);
}
// Les plus gros d'abord : la durée totale est celle du plus gros fichier, pas d'une file qui l'attend.
todo.sort((a, b) => b.size - a.size);
let next = 0;
await Promise.all(Array.from({ length: Math.min(JOBS, todo.length) }, async () => { while (next < todo.length) await one(todo[next++]); }));
await writeAtomic(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.log(`${todo.length} fichier(s) compressible(s), ${done} compressé(s) en ${Math.round((Date.now() - t0) / 1000)} s` +
  (raw ? ` (Brotli ${QUALITY} : ${(raw / 1e6).toFixed(0)} Mo → ${((raw - saved) / 1e6).toFixed(0)} Mo)` : '') + ` ; manifeste : ${manifestPath}`);
