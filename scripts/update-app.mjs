#!/usr/bin/env node
// Mise à jour d'une application Craft, sans toucher au code (phase 5) :
//   node scripts/update-app.mjs                 versions épinglées comparées aux dernières releases GitHub
//   node scripts/update-app.mjs <slug> [tag]    télécharge et vérifie la nouvelle version (fetch-app.mjs), passe ses tests
//                                               e2e dans Chrome ; s'ils échouent, apps.json revient à l'ancienne version
//   … --skip-e2e                                sans les tests (la version reste épinglée : à vos risques)
// Ensuite : relire les notes de version et le HOSTING.md de l'application, committer apps.json, redéployer dans Coolify.
// Les sessions et les fichiers sont dans le volume /data : un redéploiement ne déconnecte personne.
// L'ancienne version reste dans vendor/ : revenir en arrière = remettre l'ancienne version dans apps.json.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appsPath = join(ROOT, 'apps.json');
const args = process.argv.slice(2);
const skipE2e = args.includes('--skip-e2e');
const [slug, tag] = args.filter((a) => !a.startsWith('--'));
const before = await readFile(appsPath, 'utf8');
const apps = JSON.parse(before);
const headers = { 'User-Agent': 'craft-host-update', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

if (!slug) {
  // Tour des applications : dernière release publiée de chaque dépôt.
  for (const [s, a] of Object.entries(apps)) {
    const repo = a.repo || `storytold/${s}`;
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
    const latest = r.ok ? (await r.json()).tag_name : `? (${r.status})`;
    const flag = r.ok && latest !== a.tag ? '  ← nouvelle version' : '';
    console.log(`${s.padEnd(16)} ${(a.enabled === false ? '(désactivée) ' : '').padEnd(13)}${String(a.tag).padEnd(10)} dernière : ${latest}${flag}`);
  }
  process.exit(0);
}
if (!apps[slug]) { console.error(`${slug} absent de apps.json (ajout d'une application : npm run fetch, voir CLAUDE.md)`); process.exit(2); }

const old = apps[slug].version;
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: ROOT, stdio: 'inherit', ...opts });
const restore = async (why) => { await writeFile(appsPath, before); console.error(`\n${why} : apps.json remis à ${slug} ${old}.`); process.exit(1); };

const repo = apps[slug].repo || `storytold/${slug}`;
const f = run(process.execPath, [join('scripts', 'fetch-app.mjs'), repo.startsWith('storytold/') ? slug : repo, ...(tag ? [tag] : [])]);
if (f.status !== 0) await restore('téléchargement ou vérification refusés');
const now = JSON.parse(await readFile(appsPath, 'utf8'))[slug];
if (now.version === old) { console.log(`\n${slug} est déjà en ${old}.`); process.exit(0); }
console.log(`\n${slug} : ${old} → ${now.version}`);

if (skipE2e) {
  console.log('Tests e2e sautés (--skip-e2e) : la nouvelle version est épinglée sans vérification.');
} else {
  console.log(`Tests e2e de ${slug} (Chrome, vraies applications)…`);
  const e = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `--test-name-pattern=${slug}`, join('e2e', 'apps.e2e.mjs')],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(e.stdout || '');
  const ran = Number(/ℹ tests (\d+)/.exec(e.stdout || '')?.[1] || 0), skipped = Number(/ℹ skipped (\d+)/.exec(e.stdout || '')?.[1] || 0);
  if (e.status !== 0) await restore('tests e2e en échec');
  if (ran - skipped === 0) await restore(`aucun test e2e pour ${slug} : ajoutez son cas dans e2e/apps.e2e.mjs (CLAUDE.md), ou relancez avec --skip-e2e`);
  console.log(`${ran - skipped} test(s) e2e réussi(s).`);
}
console.log(`\napps.json épingle maintenant ${slug} ${now.version}. Reste à faire :
  1. lire les notes de version : ${now.source}
  2. git commit apps.json (et FINDINGS.md si le comportement a changé)
  3. redéployer dans Coolify (l'image télécharge et précompresse la nouvelle version ; /data est conservé)`);
