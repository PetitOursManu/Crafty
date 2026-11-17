// Outils communs à fetch-app.mjs et vendor-install.mjs : téléchargement, empreinte, extraction d'un zip web Craft
// dans vendor/<slug>/<version>/ avec son manifeste <version>.sha256 (format sha256sum).
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listZip, readEntry, safeName } from './unzip.mjs';

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const UA = 'craft-host-fetch';

export async function download(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} : ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

// Extrait le zip dans dest (dossier temporaire puis renommage) ; ne réécrit jamais un dossier existant.
// Les zips Craft contiennent un dossier racine <slug>-web-<version>/ : il est retiré. Renvoie { strip, files, existed }.
export async function extractZip(zip, dest) {
  const entries = listZip(zip);
  for (const e of entries) if (!safeName(e.name)) throw new Error(`chemin refusé dans le zip : ${e.name}`);
  const files = entries.filter((e) => !e.name.endsWith('/'));
  const tops = new Set(files.map((e) => e.name.split('/')[0]));
  const strip = tops.size === 1 && files.every((e) => e.name.includes('/')) ? `${[...tops][0]}/` : '';
  if (await stat(dest).catch(() => null)) return { strip, files: files.length, existed: true };
  const tmp = `${dest}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  const manifest = [];
  for (const e of files) {
    const rel = e.name.slice(strip.length);
    const data = readEntry(zip, e);
    const out = join(tmp, ...rel.split('/'));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, data, { flag: 'wx' });
    manifest.push(`${sha256(data)}  ${rel}`);
  }
  await rename(tmp, dest);
  manifest.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  await writeFile(`${dest}.sha256`, manifest.join('\n') + '\n');
  return { strip, files: files.length, existed: false };
}
