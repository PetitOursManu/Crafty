// craft-host : point d'entrée. Toute la logique est dans src/.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, tuneServer } from './src/app.js';
import { scheduleBackups } from './src/backup.js';

export { createApp };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // HOST : 127.0.0.1 par défaut (rien n'est exposé hors de la machine) ; dans le conteneur, HOST=0.0.0.0.
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1', app = createApp();
  const servers = [tuneServer(app.listen(port, host, () => console.log(`craft-host : http://localhost:${port}/`)))];
  // Instantané de la base toutes les BACKUP_EVERY_HOURS heures (0 = désactivé ; 24 dans l'image Docker).
  scheduleBackups(app.locals.db, { dir: process.env.BACKUP_DIR || join(app.locals.dataDir, 'backups'),
    hours: Number(process.env.BACKUP_EVERY_HOURS || 0), keep: Number(process.env.BACKUP_KEEP || 14) });
  if (host === '127.0.0.1') servers.push(tuneServer(app.listen(port, '::1')).on('error', (e) => console.warn(`[::1]:${port} indisponible : ${e.code}`)));
  // Arrêt propre (docker stop, redéploiement Coolify) : plus de nouvelles connexions, requêtes en cours terminées,
  // base fermée (WAL intégré). Au-delà de 8 s, sortie forcée (Docker tue le processus à 10 s).
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`craft-host : ${sig}, arrêt`);
    setTimeout(() => process.exit(1), 8000).unref();
    let open = servers.length;
    for (const s of servers) {
      s.close(() => { if (--open === 0) { try { app.locals.db.close(); } catch {} process.exit(0); } });
      s.closeIdleConnections?.();
    }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
