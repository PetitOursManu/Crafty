#!/usr/bin/env node
// Vérifie que vendor/<slug>/<version>/ correspond exactement au manifeste écrit par fetch-app.mjs
// (mêmes fichiers, mêmes SHA-256). Code de sortie 1 au moindre écart.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apps = JSON.parse(await readFile(join(ROOT, 'apps.json'), 'utf8'));
let bad = 0;

async function walk(dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

for (const [slug, { version, enabled }] of Object.entries(apps)) {
  const dir = join(ROOT, 'vendor', slug, version);
  // Une application désactivée peut manquer (l'image Docker n'installe que les applications activées).
  if (!existsSync(dir)) { if (enabled === false) { console.log(`${slug} ${version} : absente (désactivée)`); continue; } console.log(`MANQUANTE ${slug} ${version}`); bad++; continue; }
  const want = new Map(
    (await readFile(`${dir}.sha256`, 'utf8')).trim().split('\n').map((l) => [l.slice(66), l.slice(0, 64)]),
  );
  const seen = new Set();
  for (const f of await walk(dir)) {
    const rel = relative(dir, f).split(sep).join('/');
    seen.add(rel);
    const h = createHash('sha256').update(await readFile(f)).digest('hex');
    if (!want.has(rel)) { console.log(`EN TROP   ${slug}/${rel}`); bad++; }
    else if (want.get(rel) !== h) { console.log(`MODIFIÉ   ${slug}/${rel}`); bad++; }
  }
  for (const rel of want.keys()) if (!seen.has(rel)) { console.log(`MANQUANT  ${slug}/${rel}`); bad++; }
  console.log(`${slug} ${version} : ${want.size} fichiers attendus, ${seen.size} présents`);
}
console.log(bad ? `${bad} écart(s)` : 'vendor/ intact');
process.exit(bad ? 1 : 0);
