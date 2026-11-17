#!/usr/bin/env node
// Usage : node scripts/vendor-install.mjs [--all] [slug…]
// Installe dans vendor/ les applications épinglées dans apps.json (image Docker, nouveau poste) : télécharge le zip
// <repo>/releases/download/<tag>/<zip>, vérifie qu'il a exactement le SHA-256 épinglé (apps.json → sha256), puis
// l'extrait (vendor-lib.mjs). Sans argument : les applications activées seulement ; --all : toutes ; sinon la liste.
// Aucun appel à l'API GitHub (pas de limite de débit) ; un dossier déjà présent n'est pas réécrit.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, extractZip, sha256 } from './vendor-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const apps = JSON.parse(await readFile(process.env.APPS_FILE || join(ROOT, 'apps.json'), 'utf8'));
const vendor = process.env.VENDOR_DIR || join(ROOT, 'vendor');
const all = args.includes('--all'), only = args.filter((a) => !a.startsWith('--'));
const wanted = Object.entries(apps).filter(([slug, a]) => (only.length ? only.includes(slug) : all || a.enabled !== false));
for (const s of only) if (!apps[s]) { console.error(`${s} absent de apps.json`); process.exit(2); }

let failed = 0;
for (const [slug, a] of wanted) {
  try {
    a.repo ||= `storytold/${slug}`; // défaut de fetch-app.mjs
    for (const k of ['repo', 'tag', 'zip', 'sha256', 'version']) if (!a[k]) throw new Error(`champ ${k} manquant dans apps.json`);
    const dest = join(vendor, slug, a.version);
    if (existsSync(join(dest, 'index.html'))) { console.log(`${slug} ${a.version} : déjà présent (intégrité : npm run verify-vendor)`); continue; }
    const url = `https://github.com/${a.repo}/releases/download/${encodeURIComponent(a.tag)}/${encodeURIComponent(a.zip)}`;
    const zip = await download(url);
    const got = sha256(zip);
    if (got !== a.sha256) throw new Error(`SHA-256 différent de celui épinglé : ${got} au lieu de ${a.sha256}`);
    const { files, existed } = await extractZip(zip, dest);
    console.log(`${slug} ${a.version} : ${existed ? 'déjà présent' : `${files} fichiers`} (SHA-256 épinglé vérifié)`);
  } catch (e) {
    failed++;
    console.error(`${slug} : ${e.message}`);
  }
}
console.log(failed ? `${failed} échec(s)` : `${wanted.length} application(s) prête(s)`);
process.exit(failed ? 1 : 0);
