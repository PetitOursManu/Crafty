// Sauvegarde de la base : copie cohérente à chaud (API de sauvegarde de SQLite), rotation, restauration.
// Les contenus (blobs/, appdata/, thumbs/) ne changent jamais une fois écrits (UUID, écriture atomique) : une copie du
// volume /data par l'hôte suffit pour eux. La base, elle, se modifie en continu : la copier telle quelle pendant que le
// serveur tourne peut donner un fichier incohérent ; ce module en fait un instantané sûr dans DATA_DIR/backups/.
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = /^craft-(\d{8}-\d{6})\.db$/;
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export async function backupDb(db, { dir, keep = 14 } = {}) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `craft-${stamp()}.db`);
  await db.backup(file);
  const all = (await readdir(dir)).filter((n) => NAME.test(n)).sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const n of removed) await rm(join(dir, n), { force: true });
  return { file, size: (await stat(file)).size, removed };
}

export async function listBackups(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => NAME.test(n)).sort().reverse();
  return Promise.all(names.map(async (n) => ({ name: n, size: (await stat(join(dir, n))).size, at: (await stat(join(dir, n))).mtimeMs })));
}

// Restauration : serveur ARRÊTÉ. La base actuelle est gardée à côté (craft.db.avant-restauration-<date>).
export async function restoreDb({ dataDir, from }) {
  const target = join(dataDir, 'craft.db');
  const keepAside = `${target}.avant-restauration-${stamp()}`;
  if (await stat(target).catch(() => null)) await copyFile(target, keepAside);
  for (const ext of ['-wal', '-shm']) await rm(`${target}${ext}`, { force: true });
  await copyFile(from, target);
  return { target, keepAside };
}

// Sauvegarde automatique dans le serveur : toutes les `hours` heures (0 = désactivée), première une minute après le démarrage.
export function scheduleBackups(db, { dir, hours, keep, log = console }) {
  if (!(hours > 0)) return null;
  const run = () => backupDb(db, { dir, keep })
    .then((r) => log.log(`sauvegarde de la base : ${r.file} (${r.size} octets)${r.removed.length ? `, ${r.removed.length} ancienne(s) effacée(s)` : ''}`))
    .catch((e) => log.error(`sauvegarde de la base impossible : ${e.message}`));
  const first = setTimeout(run, 60_000); first.unref();
  const every = setInterval(run, hours * 3_600_000); every.unref();
  return { stop: () => { clearTimeout(first); clearInterval(every); } };
}
