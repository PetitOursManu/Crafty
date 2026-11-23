// Utilisateurs gérés par Kosmy Board (protocole kosmy.board-users.v1, docs/users-api.md du Board) : le serveur du Board appelle
//   GET    /api/kosmy-board/users          rôles et restrictions de Crafty, comptes reliés au Board
//   PUT    /api/kosmy-board/users/{sub}    créer, relier (par l'adresse e-mail) ou mettre à jour le compte de la personne {sub}
//   DELETE /api/kosmy-board/users/{sub}    désactiver ce compte (ses fichiers restent ; un PUT le réactive)
// avec le jeton de l'admin dans le Board (authenticate de src/kosmy-admin.js : typ kb-admin+jwt, iss, aud, exp, htm, htu, jti
// à usage unique ; sub du jeton → compte Crafty actif et administrateur). Le sub de l'adresse n'est que la personne gérée.
// Rôles : administrateur / utilisateur. Restrictions, toutes appliquées par Crafty : quota d'espace (files.js), applications
// autorisées (allowedApps de app.js), accès à l'assistant IA (ai.js). Les changements passent par createAdmin.updateUser et
// ai.updateConfig : mêmes contrôles, mêmes effets (sessions fermées à la désactivation) et même journal que la page
// d'administration, notés via: kosmy-board. À la connexion par le Board, la revendication kosmy_board_access est appliquée par
// provision(…, { atLogin: true }) depuis src/kosmy-board.js : création au besoin, jamais de liaison par l'e-mail, jamais de
// réactivation (un compte désactivé ne se connecte pas).
import { langOf, translate } from './i18n.js';
import { authenticate, BoardError, readJson, tr } from './kosmy-admin.js';
import { usernameFor } from './kosmy-board.js';
import { cleanEmail } from './admin.js';

export const BOARD_USERS_PATH = '/api/kosmy-board/users';
export const USERS_PROTOCOL = 'kosmy.board-users.v1';
const SUB_RE = /^[A-Za-z0-9-]{1,64}$/;
const GIB = 1024 ** 3, MAX_QUOTA_GIB = 100_000;
const MAX_APP_FIELDS = 27; // 30 champs au plus : quota, « toutes les applications », assistant IA, puis une case par application

export function createBoardUsers({ db, log, admin, ai, apps }) {
  const q = {
    bySub: db.prepare('SELECT * FROM users WHERE kosmy_sub = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM users WHERE lower(email) = ?'),
    byName: db.prepare('SELECT 1 FROM users WHERE username = ?'),
    linked: db.prepare('SELECT * FROM users WHERE kosmy_sub IS NOT NULL ORDER BY username COLLATE NOCASE LIMIT 500'),
    userApps: db.prepare('SELECT slug FROM user_apps WHERE user_id = ? ORDER BY slug'),
    admins: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0"),
    // Compte géré par le Board : sans mot de passe (connexion par le Board seulement), simple utilisateur avant le rôle choisi.
    insert: db.prepare(`INSERT INTO users (username, pass_hash, role, must_change, all_apps, created_at, kosmy_sub, email)
      VALUES (?, '!kosmy', 'user', 0, 1, ?, ?, ?)`),
    link: db.prepare('UPDATE users SET kosmy_sub = ? WHERE id = ? AND kosmy_sub IS NULL'),
  };
  const appSlugs = () => Object.keys(apps).slice(0, MAX_APP_FIELDS);

  // Ce que Crafty propose au Board : rôles et restrictions, dans la langue demandée.
  function schema(lang) {
    const t = (fr, vars) => tr(lang, fr, vars);
    const n = +(db.settings().default_quota / GIB).toFixed(2);
    return {
      roles: [
        { value: 'admin', label: t('Administrateur'), admin: true,
          description: t('Gère Crafty (comptes, réglages, assistant IA) et a accès à toutes les applications.') },
        { value: 'user', label: t('Utilisateur'), description: t('Utilise les applications autorisées et son espace de fichiers.') },
      ],
      defaultRole: 'user',
      fields: [
        { name: 'quota', label: t('Quota (Gio)'), type: 'number', min: 0, max: MAX_QUOTA_GIB, step: 0.5,
          help: t('Vide : quota par défaut des réglages ({n} Gio). Les anciennes versions et la corbeille comptent.', { n: lang === 'fr' ? String(n).replace('.', ',') : n }) },
        { name: 'allApps', label: t('Toutes les applications (y compris celles ajoutées plus tard)'), type: 'checkbox', value: true, roles: ['user'],
          help: t('Sinon, seulement les applications cochées ci-dessous. Un administrateur a toujours accès à toutes.') },
        ...appSlugs().map((s) => ({ name: `app-${s}`, label: apps[s].name || s, type: 'checkbox', value: false, roles: ['user'] })),
        { name: 'ai', label: t('Assistant IA'), type: 'checkbox', value: false, roles: ['user'],
          help: t('Sans effet si l\'assistant est désactivé ou ouvert à tous les comptes (Assistant IA → Accès). Un administrateur y a toujours droit.') },
      ],
    };
  }

  // Valeurs actuelles d'un compte, au format des champs (quota absent = quota par défaut).
  function valuesOf(u, aiUsers) {
    const mine = new Set(q.userApps.all(u.id).map((r) => r.slug));
    const v = { allApps: !!u.all_apps };
    if (u.quota != null) v.quota = +(u.quota / GIB).toFixed(2);
    for (const s of appSlugs()) v[`app-${s}`] = !u.all_apps && mine.has(s);
    v.ai = aiUsers.includes(u.id);
    return v;
  }
  const list = () => {
    const aiUsers = ai.config().users;
    return q.linked.all().map((u) => ({ sub: u.kosmy_sub, role: u.role, values: valuesOf(u, aiUsers), active: !u.disabled, account: u.username }));
  };

  // Valeurs reçues : chacune revérifiée ici ; un champ absent garde sa valeur actuelle ; les noms inconnus sont ignorés.
  function readValues(raw, t) {
    const out = {};
    if (raw === undefined || raw === null) return out;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new BoardError(422, 'invalid', t('Restrictions illisibles.'));
    const has = (k) => Object.hasOwn(raw, k);
    const refused = (label) => new BoardError(422, 'invalid', t('Valeur refusée pour « {field} ».', { field: label }));
    const yesNo = (k, label) => { if (typeof raw[k] !== 'boolean') throw refused(label); return raw[k]; };
    if (has('quota')) {
      const v = raw.quota;
      if (v === null || v === '') out.quota = null;
      else {
        const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+([.,]\d+)?\s*$/.test(v) ? Number(v.trim().replace(',', '.')) : NaN;
        if (!Number.isFinite(n) || n < 0 || n > MAX_QUOTA_GIB) throw refused(t('Quota (Gio)'));
        out.quota = Math.round(n * GIB);
      }
    }
    if (has('allApps')) out.allApps = yesNo('allApps', t('Toutes les applications (y compris celles ajoutées plus tard)'));
    for (const s of appSlugs()) if (has(`app-${s}`)) (out.apps ??= {})[s] = yesNo(`app-${s}`, apps[s].name || s);
    if (has('ai')) out.ai = yesNo('ai', t('Assistant IA'));
    return out;
  }

  // Crée, relie ou met à jour le compte de la personne `sub`. actor : la requête de l'administrateur qui agit (journal,
  // « soi-même ») ; à la connexion (atLogin), { ip, via } : la personne elle-même devient l'acteur une fois son compte connu.
  async function provision(actor, sub, body, { atLogin = false, lang = 'fr' } = {}) {
    const t = (fr, vars) => tr(lang, fr, vars);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BoardError(400, 'invalid_request', t('Requête illisible.'));
    const role = body.role;
    if (role !== 'admin' && role !== 'user') throw new BoardError(422, 'invalid', t('Rôle inconnu.'));
    const values = readValues(body.values, t);
    const email = cleanEmail(body.email);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';

    let u = q.bySub.get(sub), status = 'updated';
    // Liaison par l'adresse e-mail : dans un PUT seulement (fait par un administrateur de Crafty), jamais à la connexion.
    if (!u && !atLogin && email) {
      const same = q.byEmail.all(email);
      if (same.some((x) => x.kosmy_sub)) throw new BoardError(409, 'conflict', t('Cette adresse e-mail est celle d\'un compte Crafty déjà relié à une autre personne du Board.'));
      if (same.length > 1) throw new BoardError(409, 'conflict', t('Plusieurs comptes Crafty portent cette adresse e-mail : gardez-la sur un seul (Administration → Comptes → Modifier).'));
      if (same.length === 1) { u = same[0]; status = 'linked'; }
    }
    // Ne pas se couper l'accès : ni retrait de ses propres droits, ni appli sans administrateur actif. À la connexion, le
    // dernier administrateur garde son rôle (la connexion n'est pas refusée pour autant).
    let keepAdmin = false;
    if (u && u.role === 'admin' && !u.disabled && role !== 'admin') {
      if (!atLogin && u.id === actor.user?.id) throw new BoardError(409, 'conflict', t('Vous ne pouvez pas vous retirer vos propres droits d\'administration.'));
      if (q.admins.get().n <= 1) {
        if (!atLogin) throw new BoardError(409, 'conflict', t('Il doit rester au moins un administrateur actif.'));
        keepAdmin = true;
      }
    }

    if (!u) {
      const id = Number(q.insert.run(usernameFor({ name, email }, (n) => !!q.byName.get(n)), Date.now(), sub, email).lastInsertRowid);
      u = q.byId.get(id);
      status = 'created';
      if (!atLogin) log.audit(actor, 'admin.user.create', String(id), { username: u.username, kosmy: true });
    } else if (status === 'linked') {
      if (q.link.run(sub, u.id).changes === 0) throw new BoardError(409, 'conflict', t('Cette adresse e-mail est celle d\'un compte Crafty déjà relié à une autre personne du Board.'));
      log.audit(actor, 'auth.kosmy.link', String(u.id), { username: u.username, email });
    }
    if (atLogin) actor = { ...actor, user: { id: u.id, username: u.username } };

    // Rôle, état, adresse, quota et applications : mêmes règles et même journal que la page d'administration.
    const patch = {};
    const finalRole = keepAdmin ? 'admin' : role;
    if (u.role !== finalRole) patch.role = finalRole;
    if (u.disabled && !atLogin) patch.disabled = false; // un PUT réactive
    if (email && email !== u.email) patch.email = email;
    if (Object.hasOwn(values, 'quota') && values.quota !== u.quota) patch.quota = values.quota;
    if (values.allApps !== undefined || values.apps) {
      const before = q.userApps.all(u.id).map((r) => r.slug);
      const chosen = new Set(before);
      for (const [s, on] of Object.entries(values.apps || {})) { if (on) chosen.add(s); else chosen.delete(s); }
      const allApps = values.allApps ?? !!u.all_apps, list = [...chosen].filter((s) => apps[s]).sort();
      if (allApps !== !!u.all_apps || (!allApps && list.join() !== before.join())) Object.assign(patch, { allApps, apps: list });
    }
    if (Object.keys(patch).length) await admin.updateUser(actor, u.id, patch);
    if (values.ai !== undefined) {
      const users = ai.config().users;
      if (values.ai !== users.includes(u.id)) ai.updateConfig(actor, { users: values.ai ? [...users, u.id] : users.filter((x) => x !== u.id) });
    }
    return { id: u.id, status, account: u.username };
  }

  // Retirer l'accès : le compte est désactivé (connexion refusée partout, sessions fermées), ses fichiers restent.
  async function deactivate(actor, sub, { lang = 'fr' } = {}) {
    const t = (fr, vars) => tr(lang, fr, vars);
    const u = q.bySub.get(sub);
    if (!u || u.disabled) return { changed: false };
    if (u.id === actor.user.id) throw new BoardError(409, 'conflict', t('Vous ne pouvez pas retirer votre propre accès.'));
    if (u.role === 'admin' && q.admins.get().n <= 1) throw new BoardError(409, 'conflict', t('Il doit rester au moins un administrateur actif.'));
    await admin.updateUser(actor, u.id, { disabled: true });
    return { changed: true };
  }

  return { schema, list, provision, deactivate };
}

export function kosmyUsersRoutes(app, { kosmy, boardUsers }) {
  async function handle(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const lang = langOf(req), t = (fr, vars) => tr(lang, fr, vars);
    const send = (status, body) => res.status(status).json(body);
    try {
      const u = await authenticate(kosmy, req, t);
      // L'acteur des fonctions d'administration (journal, contrôles « soi-même ») : le compte relié, pas de session.
      req.user = { id: u.id, username: u.username, role: u.role };
      req.sessionHash = '';
      req.via = 'kosmy-board';
      const sub = req.params.sub;
      if (sub === undefined) {
        if (req.method !== 'GET') throw new BoardError(405, 'method_not_allowed');
        return send(200, { protocol: USERS_PROTOCOL, ...boardUsers.schema(lang), users: boardUsers.list() });
      }
      if (!SUB_RE.test(sub)) throw new BoardError(404, 'not_found');
      if (req.method === 'PUT') {
        const r = await boardUsers.provision(req, sub, await readJson(req), { lang });
        const message = r.status === 'created' ? t('Compte créé.') : r.status === 'linked' ? t('Compte existant relié.') : t('Compte mis à jour.');
        return send(200, { ok: true, status: r.status, account: r.account, message });
      }
      if (req.method === 'DELETE') {
        const r = await boardUsers.deactivate(req, sub, { lang });
        return send(200, { ok: true, ...(r.changed ? { message: t('Compte désactivé, ses sessions sont fermées.') } : {}) });
      }
      throw new BoardError(405, 'method_not_allowed');
    } catch (e) {
      let f = e;
      // Refus des fonctions d'administration : même message que dans Crafty, dans la langue demandée.
      if (!(e instanceof BoardError) && e.expose) f = new BoardError(e.status === 404 || e.status === 409 ? e.status : 422, e.status === 409 ? 'conflict' : 'invalid', translate(lang, e.message));
      if (!(f instanceof BoardError)) { console.error('Utilisateurs gérés par Kosmy Board :', e); f = new BoardError(500, 'server_error'); }
      return send(f.status, { error: f.code, ...(f.userMessage ? { message: f.userMessage } : {}) });
    }
  }
  app.all(BOARD_USERS_PATH, handle);
  app.all(`${BOARD_USERS_PATH}/:sub`, handle);
}
