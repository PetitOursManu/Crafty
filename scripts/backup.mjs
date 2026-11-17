#!/usr/bin/env node
// Usage (DATA_DIR comme le serveur ; dans le conteneur : docker exec crafty node scripts/backup.mjs …)
//   node scripts/backup.mjs                 instantané cohérent de la base dans DATA_DIR/backups/ (serveur en marche ou non)
//   node scripts/backup.mjs list            instantanés disponibles
//   node scripts/backup.mjs restore <nom>   remet un instantané en place : SERVEUR ARRÊTÉ (vérifié sur PORT)
// Variables : DATA_DIR (./data), BACKUP_DIR (DATA_DIR/backups), BACKUP_KEEP (14), PORT (8787).
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDb, listBackups, restoreDb } from '../src/backup.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const dir = resolve(process.env.BACKUP_DIR || join(dataDir, 'backups'));
const [cmd = 'now', arg] = process.argv.slice(2);

if (cmd === 'now') {
  const file = join(dataDir, 'craft.db');
  if (!existsSync(file)) { console.error(`pas de base dans ${dataDir}`); process.exit(1); }
  const db = new Database(file, { fileMustExist: true });
  try {
    const r = await backupDb(db, { dir, keep: Number(process.env.BACKUP_KEEP || 14) });
    console.log(`${r.file} (${r.size} octets)${r.removed.length ? ` ; effacées : ${r.removed.join(', ')}` : ''}`);
  } finally { db.close(); }
} else if (cmd === 'list') {
  const all = await listBackups(dir);
  if (!all.length) console.log(`aucun instantané dans ${dir}`);
  for (const b of all) console.log(`${b.name}  ${(b.size / 1024).toFixed(0)} Kio  ${new Date(b.at).toISOString()}`);
} else if (cmd === 'restore' && arg) {
  const from = existsSync(arg) ? resolve(arg) : join(dir, basename(arg));
  if (!existsSync(from)) { console.error(`instantané introuvable : ${arg}`); process.exit(1); }
  const port = Number(process.env.PORT || 8787);
  const running = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  if (running) { console.error(`le serveur répond sur le port ${port} : arrêtez-le avant de restaurer`); process.exit(1); }
  const r = await restoreDb({ dataDir, from });
  console.log(`base restaurée depuis ${from}\nancienne base gardée : ${r.keepAside}`);
} else {
  console.error('usage : node scripts/backup.mjs [now | list | restore <instantané>]');
  process.exit(2);
}
