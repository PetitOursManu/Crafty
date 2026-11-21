// Journal de connexion (une ligne par événement, lisible par fail2ban) et journal d'audit (table audit).
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// Format : 2026-11-14T10:00:00.000Z craft-host AUTH_FAIL ip=203.0.113.7 user="bob" reason=password
// Filtre fail2ban : deploy/fail2ban/crafty.conf (AUTH_FAIL, AUTH_LOCKED, AUTH_RATELIMIT).
// Rotation : au-delà de maxBytes, auth.log devient auth.log.1 (puis .2, .3) ; fail2ban suit le nouveau fichier.
export function createLogger({ authLogFile, db, quiet = false, maxBytes = 5 * 1024 ** 2, keep = 3 }) {
  let size = 0;
  if (authLogFile) {
    mkdirSync(dirname(authLogFile), { recursive: true });
    try { size = statSync(authLogFile).size; } catch { size = 0; }
  }
  const rotate = () => {
    try {
      rmSync(`${authLogFile}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) { try { renameSync(`${authLogFile}.${i}`, `${authLogFile}.${i + 1}`); } catch {} }
      renameSync(authLogFile, `${authLogFile}.1`);
    } catch {}
    size = 0;
  };
  const clean = (v) => String(v ?? '').replace(/[\r\n"\\]/g, '_').slice(0, 64);
  const insert = db.prepare('INSERT INTO audit (at, user_id, username, ip, action, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  return {
    auth(event, { ip, user, reason } = {}) {
      const line = `${new Date().toISOString()} craft-host ${event} ip=${clean(ip)} user="${clean(user)}"${reason ? ` reason=${clean(reason)}` : ''}\n`;
      if (authLogFile) {
        if (size + line.length > maxBytes) rotate();
        appendFileSync(authLogFile, line);
        size += Buffer.byteLength(line);
      }
      if (!quiet) process.stdout.write(line);
    },
    // req.via : action faite par une autre interface que celle de Crafty (« kosmy-board » : admin dans le Board), notée dans le détail.
    audit(req, action, target = null, detail = null) {
      if (req.via) detail = { ...(detail == null ? {} : typeof detail === 'object' ? detail : { detail }), via: req.via };
      insert.run(Date.now(), req.user?.id ?? null, req.user?.username ?? null, req.ip ?? null, action,
        target, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail));
    },
  };
}
