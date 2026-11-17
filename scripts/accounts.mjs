#!/usr/bin/env node
// Comptes en ligne de commande, directement dans la base (DATA_DIR) : pour le jour où plus aucun administrateur ne peut
// se connecter (mot de passe oublié, téléphone perdu, compte verrouillé). Dans le conteneur :
//   docker exec -it crafty node scripts/accounts.mjs <commande>
// Commandes :
//   list                         comptes, rôle, état, double authentification, Dashy
//   create <nom> [--admin]       compte avec mot de passe provisoire (affiché une fois, à changer à la connexion)
//   reset-password <nom>         nouveau mot de passe provisoire ; sessions du compte fermées
//   unlock <nom>                 lève le verrouillage après trop d'échecs
//   disable <nom> | enable <nom> désactive (sessions fermées) ou réactive
//   role <nom> admin|user        change le rôle (il reste toujours au moins un administrateur actif)
//   reset-2fa <nom>              retire la double authentification (téléphone et codes de secours perdus)
// Chaque action est inscrite au journal d'audit (compte « cli »).
import { randomInt } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { hashPassword, checkCredentials } from '../src/auth.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const [cmd, name, opt] = process.argv.slice(2);
const db = openDb(join(dataDir, 'craft.db'));
const die = (msg, code = 1) => { console.error(msg); db.close(); process.exit(code); };
const audit = (action, target, detail) => db.prepare('INSERT INTO audit (at, user_id, username, ip, action, target, detail) VALUES (?, NULL, ?, NULL, ?, ?, ?)')
  .run(Date.now(), 'cli', action, target, detail ? JSON.stringify(detail) : null);
const user = () => {
  if (!name) die('nom de compte manquant', 2);
  return db.prepare('SELECT * FROM users WHERE username = ?').get(name) || die(`compte introuvable : ${name}`);
};
const tempPassword = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 14 }, () => abc[randomInt(abc.length)]).join('');
};
const activeAdmins = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
const killSessions = (id) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;

switch (cmd) {
  case 'list': {
    const rows = db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all();
    if (!rows.length) console.log('aucun compte (le premier inscrit deviendra administrateur)');
    for (const u of rows) {
      const flags = [u.role === 'admin' && 'admin', u.disabled && 'désactivé', u.locked_until > Date.now() && 'verrouillé',
        u.must_change && 'mot de passe provisoire', u.totp_enabled && '2FA', u.dashy_sub && (String(u.pass_hash).startsWith('scrypt$') ? 'lié à Dashy' : 'Dashy seulement')].filter(Boolean);
      console.log(`${u.username.padEnd(24)} ${flags.join(', ') || '—'}${u.last_login_at ? `  (dernière connexion ${new Date(u.last_login_at).toISOString().slice(0, 16)})` : ''}`);
    }
    break;
  }
  case 'create': {
    const role = opt === '--admin' ? 'admin' : 'user';
    const password = tempPassword();
    const e = checkCredentials(name, password);
    if (e) die(e, 2);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) die(`existe déjà : ${name}`);
    db.prepare(`INSERT INTO users (username, pass_hash, role, must_change, all_apps, created_at) VALUES (?, ?, ?, 1, 1, ?)`)
      .run(name, await hashPassword(password), role, Date.now());
    audit('cli.user.create', name, { role });
    console.log(`compte ${name} créé (${role}). Mot de passe provisoire, à changer à la première connexion :\n${password}`);
    break;
  }
  case 'reset-password': {
    const u = user(), password = tempPassword();
    db.prepare('UPDATE users SET pass_hash = ?, must_change = 1, failed_count = 0, locked_until = 0 WHERE id = ?').run(await hashPassword(password), u.id);
    const n = killSessions(u.id);
    audit('cli.user.password', u.username);
    console.log(`nouveau mot de passe provisoire pour ${u.username} (${n} session(s) fermée(s)) :\n${password}`);
    break;
  }
  case 'unlock': {
    const u = user();
    db.prepare('UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?').run(u.id);
    audit('cli.user.unlock', u.username);
    console.log(`${u.username} déverrouillé`);
    break;
  }
  case 'disable': case 'enable': {
    const u = user();
    if (cmd === 'disable' && u.role === 'admin' && !u.disabled && activeAdmins() <= 1) die('c\'est le dernier administrateur actif');
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(cmd === 'disable' ? 1 : 0, u.id);
    if (cmd === 'disable') killSessions(u.id);
    audit(`cli.user.${cmd}`, u.username);
    console.log(`${u.username} ${cmd === 'disable' ? 'désactivé (sessions fermées)' : 'réactivé'}`);
    break;
  }
  case 'role': {
    const u = user();
    if (!['admin', 'user'].includes(opt)) die('rôle : admin ou user', 2);
    if (opt === 'user' && u.role === 'admin' && !u.disabled && activeAdmins() <= 1) die('c\'est le dernier administrateur actif');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(opt, u.id);
    audit('cli.user.role', u.username, { role: opt });
    console.log(`${u.username} : ${opt}`);
    break;
  }
  case 'reset-2fa': {
    const u = user();
    db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
    audit('cli.user.2fa.reset', u.username);
    console.log(`double authentification retirée pour ${u.username}`);
    break;
  }
  default:
    die('usage : node scripts/accounts.mjs list | create <nom> [--admin] | reset-password <nom> | unlock <nom> | disable <nom> | enable <nom> | role <nom> admin|user | reset-2fa <nom>', 2);
}
db.close();
