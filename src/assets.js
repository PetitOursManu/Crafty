// Versions des fichiers de l'interface (public/). Derrière Cloudflare, les .js et .css sont gardés en cache (et la durée
// imposée au navigateur, 4 h par défaut, remplace notre no-cache) alors que les pages HTML ne le sont pas : après une
// mise à jour, une page neuve chargeait d'anciens scripts (constaté le 20/11/2026 : accueil sans genres, tuiles en liste).
// Le serveur ajoute donc ?v=<empreinte du contenu de public/> à chaque script et feuille de style que citent les pages
// (src, href) et les modules (import … from, import()). Une mise à jour change toutes ces adresses ; une adresse à la
// version courante est servie en immutable.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// Une référence locale à un .js ou .css, entre guillemets, juste après from, import(, src= ou href=.
const REF = /(\bfrom\s*|\bimport\s*\(\s*|\b(?:src|href)\s*=\s*)(['"])(\/[\w\-./]+\.(?:js|css))\2/g;
export const REWRITTEN = new Set(['.html', '.js']);

export function rewriteRefs(text, version) {
  return text.replace(REF, (m, before, q, path) => `${before}${q}${path}?v=${version}${q}`);
}

// ttlMs : intervalle minimal entre deux relevés du dossier (les fichiers changent en développement, jamais en production).
export function createAssets(publicDir, { ttlMs = 1000 } = {}) {
  let current = null, checkedAt = 0, pending = null;
  async function walk(dir, out = []) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, out);
      else if (e.isFile()) out.push(p);
    }
    return out;
  }
  async function compute() {
    const files = (await walk(publicDir)).sort();
    const stats = await Promise.all(files.map((f) => stat(f)));
    const key = files.map((f, i) => `${relative(publicDir, f).split(sep).join('/')}:${stats[i].size}:${stats[i].mtimeMs}`).join('\n');
    if (current?.key === key) return current;
    // Empreinte du contenu (pas des dates) : deux conteneurs construits depuis le même commit donnent la même version.
    const h = createHash('sha256');
    for (const f of files) h.update(relative(publicDir, f).split(sep).join('/')).update('\0').update(await readFile(f)).update('\0');
    return { key, version: h.digest('base64url').slice(0, 12) };
  }
  async function version() {
    if (current && Date.now() - checkedAt < ttlMs) return current.version;
    pending ??= compute().then((c) => { current = c; checkedAt = Date.now(); return c; }).finally(() => { pending = null; });
    return (await pending).version;
  }
  return { version };
}
