#!/usr/bin/env node
// Usage : node scripts/fetch-app.mjs <slug | propriétaire/slug> [tag]   (défaut : storytold/<slug>)
// Télécharge le zip web officiel de storytold/<slug>, vérifie son SHA-256 (SHA256SUMS.txt de la
// release et empreinte de l'asset donnée par l'API GitHub), le décompresse dans
// vendor/<slug>/<version>/ et met à jour apps.json. Écrit aussi vendor/<slug>/<version>.sha256
// (format sha256sum) pour vérifier plus tard qu'aucun fichier n'a été modifié.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractZip, sha256, UA } from './vendor-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [arg, wantTag] = process.argv.slice(2);
const [owner, slug] = String(arg || '').includes('/') ? String(arg).toLowerCase().split('/') : ['storytold', arg];
if (!slug || !/^[a-z0-9-]+$/.test(slug) || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner)) {
  console.error('usage : node scripts/fetch-app.mjs <slug | propriétaire/slug> [tag]');
  process.exit(2);
}

const headers = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function get(url, binary = false) {
  const r = await fetch(url, { headers: binary ? { 'User-Agent': headers['User-Agent'] } : headers });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} : ${url}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.json();
}

const releases = await get(`https://api.github.com/repos/${owner}/${slug}/releases?per_page=30`);
const zipRe = new RegExp(`^${slug}-web-(.+)\\.zip$`);
let release, asset;
for (const r of releases) {
  if (r.draft || (wantTag && r.tag_name !== wantTag)) continue;
  const a = r.assets.find((x) => zipRe.test(x.name));
  if (a) { release = r; asset = a; break; }
}
if (!asset) {
  console.error(`Aucun zip web (${slug}-web-<version>.zip) dans les ${releases.length} dernières releases de ${owner}/${slug}${wantTag ? ` (tag ${wantTag})` : ''}. Arrêt.`);
  process.exit(1);
}
const version = asset.name.match(zipRe)[1];
console.log(`${slug} : release ${release.tag_name}, ${asset.name} (${asset.size} octets)`);

const zip = await get(asset.browser_download_url, true);
const digest = sha256(zip);
const checks = [];
if (asset.digest) {
  if (asset.digest !== `sha256:${digest}`) throw new Error(`empreinte différente de l'API GitHub : ${asset.digest} / ${digest}`);
  checks.push('digest API GitHub');
}
const sums = release.assets.find((x) => x.name === 'SHA256SUMS.txt');
if (sums) {
  const text = (await get(sums.browser_download_url, true)).toString('utf8');
  const line = text.split('\n').find((l) => l.trim().endsWith(asset.name));
  if (!line) throw new Error(`${asset.name} absent de SHA256SUMS.txt`);
  if (line.trim().split(/\s+/)[0].toLowerCase() !== digest) throw new Error('SHA-256 différent de SHA256SUMS.txt');
  checks.push('SHA256SUMS.txt');
}
console.log(`SHA-256 ${digest} ${checks.length ? `vérifié (${checks.join(' + ')})` : 'NON vérifié : la release ne publie aucune empreinte'}`);
// Note : SHA256SUMS.txt.asc (signature GPG) existe mais n'est pas vérifiée ici.

const dest = join(ROOT, 'vendor', slug, version);
const { strip, files, existed } = await extractZip(zip, dest);
console.log(existed ? `${dest} existe déjà : pas de réécriture (vérifier avec scripts/verify-vendor.mjs).` : `${files} fichiers dans ${dest}`);

const appsPath = join(ROOT, 'apps.json');
const apps = JSON.parse(await readFile(appsPath, 'utf8').catch(() => '{}'));
apps[slug] = {
  enabled: false, // à passer à true après les essais (CLAUDE.md, « Ajouter une application »)
  ...apps[slug],
  version,
  tag: release.tag_name,
  zip: asset.name,
  zipSize: asset.size,
  sha256: digest,
  sha256Source: checks,
  stripPrefix: strip || null,
  repo: `${owner}/${slug}`,
  source: `https://github.com/${owner}/${slug}/releases/tag/${release.tag_name}`,
};
await writeFile(appsPath, JSON.stringify(apps, null, 2) + '\n');
console.log(`apps.json : ${slug} → ${version}`);
