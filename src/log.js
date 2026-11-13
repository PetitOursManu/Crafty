// Journal de connexion (une ligne par événement, lisible par fail2ban) et journal d'audit (table audit).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Format : 2026-11-14T10:00:00.000Z craft-host AUTH_FAIL ip=203.0.113.7 user="bob" reason=password
// Regex fail2ban : ^<F-TIME>\S+</F-TIME> craft-host AUTH_FAIL ip=<HOST>
export function createLogger({ authLogFile, db, quiet = false }) {
  if (authLogFile) mkdirSync(dirname(authLogFile), { recursive: true });
  const clean = (v) => String(v ?? '').replace(/[\r\n"\\]/g, '_').slice(0, 64);
  const insert = db.prepare('INSERT INTO audit (at, user_id, username, ip, action, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  return {
    auth(event, { ip, user, reason } = {}) {
      const line = `${new Date().toISOString()} craft-host ${event} ip=${clean(ip)} user="${clean(user)}"${reason ? ` reason=${clean(reason)}` : ''}`;
      if (authLogFile) appendFileSync(authLogFile, line + '\n');
      if (!quiet) console.log(line);
    },
    audit(req, action, target = null, detail = null) {
      insert.run(Date.now(), req.user?.id ?? null, req.user?.username ?? null, req.ip ?? null, action,
        target, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail));
    },
  };
}
