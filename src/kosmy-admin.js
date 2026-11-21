// Admin dans Kosmy Board (protocole kosmy.board-admin.v1, docs/admin-api.md du Board) : le serveur du Board appelle
//   GET  /api/kosmy-board/admin              sommaire (sections)
//   GET  /api/kosmy-board/admin/{section}    contenu d'une section (blocs : notice, stats, fields, form, table, actions)
//   POST /api/kosmy-board/admin/{section}    action ({ action, row?, values? })
// avec un jeton d'une seule requête signé par la clé OpenID Connect du Board (vérifié dans src/kosmy-board.js avec les réglages,
// la découverte et les clés de la connexion unique). Le Board dit seulement qui est la personne : son `sub` doit être relié
// à un compte Crafty actif et administrateur. Chaque action passe par les mêmes fonctions que la page d'administration
// (src/admin.js, src/ai.js, src/kosmy-board.js) : mêmes contrôles, mêmes effets, même journal (détail via: kosmy-board).
// Jamais de secret existant dans une réponse : seulement un mot de passe provisoire au moment où il est créé (reveal).
// Pas de session, pas de cookie, pas de contrôle d'origine (appel de serveur à serveur), pas de CORS, pas de redirection.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { langOf, translate } from './i18n.js';
import { BOARD_ADMIN } from './i18n-en.js';
import common from '../public/i18n/en-common.js';
import account from '../public/i18n/en-account.js';

export const BOARD_ADMIN_PATH = '/api/kosmy-board/admin';
export const PROTOCOL = 'kosmy.board-admin.v1';
const SECTION_RE = /^[a-z0-9-]{1,40}$/, ACTION_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const GIB = 1024 ** 3, MIB = 1024 ** 2, MAX_BODY = 256 * 1024;
const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return ''; } })();

// Textes : le français est la source ; anglais repris des dictionnaires de l'interface (public/i18n/) et du serveur
// (src/i18n-en.js : messages d'erreur, et BOARD_ADMIN pour les textes propres à cette API). test/i18n.test.js vérifie
// que chaque texte passé à t() dans ce fichier a sa traduction.
const EN = { ...account, ...common, ...BOARD_ADMIN };
function tr(lang, fr, vars) {
  let s = lang === 'fr' ? fr : (EN[fr] ?? translate('en', fr));
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// Libellés passés à t() par une variable : test/i18n.test.js vérifie aussi leur traduction.
export const SECTION_TITLES = { overview: 'Vue d\'ensemble', users: 'Comptes', settings: 'Réglages', ai: 'Assistant IA', system: 'Système', audit: 'Journal' };
export const EFFORT_LABELS = { auto: 'Auto (défaut du modèle)', off: 'Désactivée', low: 'Faible', medium: 'Moyenne', high: 'Élevée' };
// Libellés du journal (les mêmes que public/admin.js, traduits par les mêmes dictionnaires).
export const AUDIT_LABELS = { 'auth.login': 'Connexion', 'auth.logout': 'Déconnexion', 'auth.setup': 'Création du compte admin', 'auth.register': 'Inscription',
  'auth.password': 'Mot de passe changé', 'file.upload': 'Import', 'file.save': 'Enregistrement', 'file.autosave': 'Sauvegarde automatique', 'file.update': 'Fichier modifié',
  'file.delete': 'Fichier supprimé', 'file.restore': 'Version restaurée', 'folder.create': 'Dossier créé', 'folder.update': 'Dossier modifié',
  'folder.delete': 'Dossier supprimé', 'admin.user.create': 'Compte créé', 'admin.user.update': 'Compte modifié',
  'admin.user.delete': 'Compte supprimé', 'file.trash': 'Mis à la corbeille', 'folder.trash': 'Dossier à la corbeille', 'file.untrash': 'Restauré de la corbeille',
  'folder.restore': 'Dossier restauré', 'share.create': 'Lien de partage créé', 'share.revoke': 'Lien révoqué', 'share.access': 'Lien de partage ouvert',
  'admin.settings': 'Réglages modifiés', 'admin.ai': 'Assistant IA modifié', 'ai.error': "Erreur de l'assistant",
  'auth.2fa.enable': 'Double authentification activée', 'auth.2fa.disable': 'Double authentification désactivée', 'auth.2fa.recovery': 'Codes de secours renouvelés',
  'auth.sso': 'Connexion par Dashy', 'auth.sso.create': 'Compte créé par Dashy', 'auth.sso.link': 'Compte lié à Dashy',
  'auth.kosmy': 'Connexion par Kosmy Board', 'auth.kosmy.create': 'Compte créé par Kosmy Board', 'auth.kosmy.link': 'Compte relié à Kosmy Board',
  'auth.kosmy.unlink': 'Compte délié de Kosmy Board', 'admin.kosmy': 'Réglages Kosmy Board modifiés' };

class BoardError extends Error {
  constructor(status, code, message) { super(code); Object.assign(this, { status, code, userMessage: message }); }
}

// Mot de passe provisoire : même alphabet que la page d'administration (public/admin.js), tiré ici côté serveur.
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 14 }, () => abc[randomInt(abc.length)]).join('');
}
const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1;
const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
// Nombre saisi : '' ou absent → null ; sinon Number (NaN si illisible : refusé par les contrôles du service).
const num = (v) => (v === undefined || v === null || str(v) === '' ? null : Number(String(v).replace(',', '.')));

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new BoardError(413, 'too_large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return undefined; }
}

export function kosmyAdminRoutes(app, { kosmy, admin, ai, apps, db, sso }) {
  const q = {
    shares: db.prepare('SELECT COUNT(*) n FROM shares WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?)'),
    sessions: db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id IS NOT NULL AND expires_at > ?'),
  };
  const appList = () => Object.entries(apps).map(([slug, a]) => ({ slug, name: a.name || slug, version: a.version }));

  // Présentation commune à une requête : langue, dates, tailles.
  function view(req, me) {
    const lang = langOf(req), locale = lang === 'fr' ? 'fr-FR' : 'en-US';
    const t = (fr, vars) => tr(lang, fr, vars);
    const size = (n) => {
      if (n < 1024) return lang === 'fr' ? `${n} o` : `${n} B`;
      const u = lang === 'fr' ? ['Kio', 'Mio', 'Gio', 'Tio'] : ['KiB', 'MiB', 'GiB', 'TiB'];
      let i = -1;
      do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
      const v = n.toFixed(n < 10 ? 1 : 0);
      return `${lang === 'fr' ? v.replace('.', ',') : v} ${u[i]}`;
    };
    const date = (ms) => (ms ? new Date(ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : t('jamais'));
    return { req, me, lang, t, size, date };
  }

  // Champs « applications » : toutes, ou une case par application.
  const appFields = (v, all, selected, help) => [
    { name: 'allApps', label: v.t('Toutes les applications (y compris celles ajoutées plus tard)'), type: 'checkbox', value: all, ...(help ? { help } : {}) },
    ...appList().map((a) => ({ name: `app-${a.slug}`, label: a.name, type: 'checkbox', value: selected.includes(a.slug) })),
  ];
  const readApps = (values) => ({ allApps: bool(values.allApps), apps: appList().map((a) => a.slug).filter((s) => bool(values[`app-${s}`])) });
  const quotaBytes = (v, value) => {
    const n = num(value);
    if (n === null) return null;
    if (!Number.isFinite(n) || n < 0) throw new BoardError(422, 'invalid', v.t('Quota invalide.'));
    return Math.round(n * GIB);
  };

  // ---------- Comptes ----------
  // Actions possibles sur une ligne : comme le menu de la page d'administration ; depuis le Board, on ne change ni le rôle,
  // ni le mot de passe, ni le lien Kosmy Board, ni l'état de son propre compte (l'accès du Board passe par lui).
  function userActions(u, me) {
    const self = u.id === me.id, out = [];
    if (!self) out.push(u.role === 'admin' ? 'make-user' : 'make-admin');
    out.push('apps', 'quota');
    if (!self) out.push('reset-password');
    if (u.locked) out.push('unlock');
    if (u.twoFactor) out.push('reset-2fa');
    if (u.dashy && u.hasPassword) out.push('unlink-dashy');
    if (u.kosmy && u.hasPassword && !self) out.push('unlink-kosmy');
    if (!self) out.push(u.disabled ? 'enable' : 'disable', 'delete');
    return out;
  }
  const USER_PATCH = { 'make-admin': { role: 'admin' }, 'make-user': { role: 'user' }, unlock: { unlock: true }, 'reset-2fa': { reset2fa: true },
    'unlink-dashy': { unlinkDashy: true }, 'unlink-kosmy': { unlinkKosmy: true }, disable: { disabled: true }, enable: { disabled: false } };

  function usersSection(v) {
    const { t } = v, s = admin.settings(), users = admin.listUsers();
    const names = Object.fromEntries(appList().map((a) => [a.slug, a.name]));
    const state = (u) => (u.disabled ? { text: t('désactivé'), tone: 'danger' } : u.locked ? { text: t('verrouillé'), tone: 'danger' }
      : u.mustChange ? { text: t('mot de passe provisoire'), tone: 'warning' } : { text: t('actif'), tone: 'success' });
    const signIn = (u) => [u.hasPassword ? t('mot de passe') : null, u.twoFactor ? t('double authentification') : null,
      u.dashy ? (u.hasPassword ? t('lié à Dashy') : t('Dashy seulement')) : null,
      u.kosmy ? (u.hasPassword ? t('relié à Kosmy Board') : t('Kosmy Board seulement')) : null].filter(Boolean).join(', ');
    return {
      title: t('Comptes'),
      description: t('Créez des comptes (mot de passe provisoire à changer) et choisissez leurs applications.'),
      blocks: [
        ...(users.length > 500 ? [{ type: 'notice', tone: 'warning', text: t('Seuls les 500 premiers comptes sont affichés ici ; les autres sont dans l\'administration de Crafty.') }] : []),
        {
          type: 'table', id: 'users',
          columns: [{ key: 'name', label: t('Compte') }, { key: 'role', label: t('Rôle') }, { key: 'state', label: t('État') },
            { key: 'signin', label: t('Connexion') }, { key: 'apps', label: t('Applications') }, { key: 'space', label: t('Espace') },
            { key: 'files', label: t('Fichiers') }, { key: 'last', label: t('Dernière connexion') }],
          rows: users.slice(0, 500).map((u) => {
            const quota = u.quota ?? s.default_quota;
            return {
              id: String(u.id),
              cells: {
                name: u.id === v.me.id ? t('{name} (vous)', { name: u.username }) : u.username,
                role: u.role === 'admin' ? { text: t('Administrateur'), tone: 'success' } : { text: t('Utilisateur'), tone: 'muted' },
                state: state(u),
                signin: signIn(u),
                apps: u.role === 'admin' || u.allApps ? t('Toutes') : u.apps.length ? u.apps.map((a) => names[a] || a).join(', ') : t('Aucune'),
                space: u.quota == null ? `${v.size(u.used)} / ${v.size(quota)}` : t('{used} / {quota} (personnalisé)', { used: v.size(u.used), quota: v.size(quota) }),
                files: u.files,
                last: v.date(u.lastLoginAt),
              },
              actions: userActions(u, v.me),
            };
          }),
          rowActions: [
            { id: 'make-admin', label: t('Rendre administrateur') },
            { id: 'make-user', label: t('Retirer les droits d\'administration') },
            { id: 'apps', label: t('Applications…'), fields: appFields(v, true, [],
              t('Sinon, seulement les applications cochées. La sélection actuelle est dans la colonne Applications ; un administrateur a toujours accès à toutes.')) },
            { id: 'quota', label: t('Quota…'), fields: [{ name: 'quota', label: t('Quota (Gio)'), type: 'number', min: 0, step: 0.5, help: t('Vide = quota par défaut.') }] },
            { id: 'reset-password', label: t('Nouveau mot de passe provisoire…'), confirm: t('Un mot de passe provisoire remplace l\'actuel ; ses sessions ouvertes sont fermées.') },
            { id: 'unlock', label: t('Déverrouiller') },
            { id: 'reset-2fa', label: t('Retirer la double authentification…'), danger: true,
              confirm: t('À faire seulement si la personne a perdu son téléphone et ses codes de secours, après avoir vérifié son identité. Elle pourra la réactiver depuis son compte.') },
            { id: 'unlink-dashy', label: t('Délier de Dashy') },
            { id: 'unlink-kosmy', label: t('Délier de Kosmy Board') },
            { id: 'disable', label: t('Désactiver'), confirm: t('Le compte ne pourra plus se connecter ; ses sessions sont fermées.') },
            { id: 'enable', label: t('Réactiver') },
            { id: 'delete', label: t('Supprimer…'), danger: true, confirm: t('Le compte, ses fichiers et leurs versions seront effacés. Cette action est définitive.') },
          ],
          actions: [{ id: 'create', label: t('Nouveau compte'), fields: [
            { name: 'username', label: t('Identifiant'), type: 'text', required: true, maxLength: 32, help: t('3 à 32 caractères : lettres, chiffres, . _ -') },
            { name: 'role', label: t('Rôle'), type: 'select', value: 'user', options: [{ value: 'user', label: t('Utilisateur') }, { value: 'admin', label: t('Administrateur') }] },
            { name: 'quota', label: t('Quota (Gio)'), type: 'number', min: 0, step: 0.5, help: t('Vide = quota par défaut des réglages. Les anciennes versions comptent.') },
            ...appFields(v, true, []),
          ] }],
          empty: t('Aucun compte.'),
        },
      ],
    };
  }

  async function usersAct(v, { action, row, values }) {
    const { t, req } = v;
    if (action === 'create') {
      const username = str(values.username), password = tempPassword();
      await admin.createUser(req, { username, password, role: str(values.role) || 'user', ...readApps(values), quota: quotaBytes(v, values.quota) });
      return { message: t('Compte créé. Il faudra changer ce mot de passe à la première connexion.'),
        reveal: { label: t('Mot de passe provisoire de {name}', { name: username }), value: password } };
    }
    const known = ['apps', 'quota', 'reset-password', 'delete', ...Object.keys(USER_PATCH)];
    if (!known.includes(action)) throw new BoardError(404, 'not_found');
    const u = /^\d{1,15}$/.test(String(row ?? '')) ? admin.userById(Number(row)) : null;
    if (!u) throw new BoardError(404, 'not_found', t('Compte introuvable.'));
    if (!userActions(u, v.me).includes(action)) throw new BoardError(409, 'conflict', t('Cette action n\'est pas possible pour ce compte.'));
    if (action === 'delete') {
      await admin.deleteUser(req, u.id);
      return { message: t('{name} supprimé.', { name: u.username }) };
    }
    if (action === 'reset-password') {
      const password = tempPassword();
      await admin.updateUser(req, u.id, { password });
      return { message: t('Il devra le changer à sa première connexion.'), reveal: { label: t('Mot de passe provisoire de {name}', { name: u.username }), value: password } };
    }
    const patch = action === 'apps' ? readApps(values) : action === 'quota' ? { quota: quotaBytes(v, values.quota) } : USER_PATCH[action];
    await admin.updateUser(req, u.id, patch);
    switch (action) {
      case 'unlock': return { message: t('Compte déverrouillé.') };
      case 'reset-2fa': return { message: t('Double authentification retirée.') };
      case 'unlink-dashy': return { message: t('Compte délié de Dashy.') };
      case 'unlink-kosmy': return { message: t('Compte délié de Kosmy Board.') };
      case 'disable': return { message: t('Compte désactivé, ses sessions sont fermées.') };
      case 'enable': return { message: t('Compte réactivé.') };
      default: return { message: t('Compte modifié.') };
    }
  }

  // ---------- Réglages ----------
  function settingsSection(v) {
    const { t } = v, s = admin.settings();
    return {
      title: t('Réglages'),
      description: t('S\'appliquent à tout le service.'),
      blocks: [
        { type: 'form', id: 'access', title: t('Accès'), action: 'save-access', submit: t('Enregistrer'), fields: [
          { name: 'signup_open', label: t('Inscription publique'), type: 'checkbox', value: !!s.signup_open,
            help: t('Toute personne qui atteint la page peut créer un compte (rôle utilisateur, toutes les applications).') },
          { name: 'guest_enabled', label: t('Mode invité'), type: 'checkbox', value: !!s.guest_enabled,
            help: t('Bouton « Continuer en invité » : applications sans stockage, les enregistrements sont téléchargés.') },
          { name: 'sharing_enabled', label: t('Liens de partage'), type: 'checkbox', value: !!s.sharing_enabled,
            help: t('Les comptes peuvent créer un lien public (avec expiration) vers un fichier. Désactiver coupe aussi les liens existants.') },
          ...(sso.enabled ? [{ name: 'sso_create_accounts', label: t('Comptes créés par Dashy'), type: 'checkbox', value: !!s.sso_create_accounts,
            help: t("Une identité Dashy inconnue obtient un compte Crafty à sa première connexion (administrateur si elle l'est dans Dashy). Sinon, seuls les comptes déjà liés peuvent se connecter avec Dashy.") }] : []),
        ] },
        { type: 'form', id: 'guest-apps', title: t('Applications des invités'), action: 'save-guest-apps', submit: t('Enregistrer'),
          description: t('Utilisées seulement si le mode invité est activé.'),
          fields: appFields(v, s.guest_apps === null, s.guest_apps || []) },
        { type: 'form', id: 'files', title: t('Fichiers'), action: 'save-files', submit: t('Enregistrer'), fields: [
          { name: 'max_versions', label: t('Versions conservées par fichier'), type: 'number', value: s.max_versions, min: 1, max: 100, step: 1, required: true,
            help: t('Les plus anciennes sont effacées au prochain enregistrement.') },
          { name: 'default_quota', label: t('Quota par défaut (Gio)'), type: 'number', value: +(s.default_quota / GIB).toFixed(2), min: 0, step: 0.5, required: true,
            help: t('Par compte, versions comprises.') },
          { name: 'max_file_size', label: t('Taille max. d\'un fichier (Mio)'), type: 'number', value: Math.round(s.max_file_size / MIB), min: 1, max: 512, step: 1, required: true,
            help: t('512 au plus (limite des applications).') },
          { name: 'autosave_seconds', label: t('Sauvegarde automatique (secondes)'), type: 'number', value: s.autosave_seconds, min: 0, max: 3600, step: 5, required: true,
            help: t('Délai après une modification ; 0 = désactivée. Les sauvegardes automatiques successives mettent à jour une seule version ; seuls les « Enregistrer » ajoutent des versions.') },
          { name: 'trash_days', label: t('Corbeille (jours)'), type: 'number', value: s.trash_days, min: 0, max: 365, step: 1, required: true,
            help: t('Durée avant effacement définitif ; 0 = pas de corbeille (suppression immédiate). Compte dans le quota.') },
        ] },
      ],
    };
  }

  function settingsAct(v, { action, values }) {
    let patch;
    if (action === 'save-access') {
      patch = { signup_open: bool(values.signup_open), guest_enabled: bool(values.guest_enabled), sharing_enabled: bool(values.sharing_enabled) };
      if (sso.enabled) patch.sso_create_accounts = bool(values.sso_create_accounts);
    } else if (action === 'save-guest-apps') {
      const g = readApps(values);
      patch = { guest_apps: g.allApps ? null : g.apps };
    } else if (action === 'save-files') {
      const n = (k, unit = 1) => { const x = num(values[k]); return x === null ? NaN : Math.round(x * unit); };
      patch = { max_versions: n('max_versions'), default_quota: n('default_quota', GIB), max_file_size: n('max_file_size', MIB),
        autosave_seconds: n('autosave_seconds'), trash_days: n('trash_days') };
    } else throw new BoardError(404, 'not_found');
    admin.patchSettings(v.req, patch);
    return { message: v.t('Réglages enregistrés.') };
  }

  // ---------- Assistant IA ----------
  function aiSection(v) {
    const { t } = v, c = ai.adminView();
    const others = admin.listUsers().filter((u) => u.role !== 'admin');
    const ready = c.providers.filter((p) => p.ready);
    const status = (p) => (p.ready ? t('Prêt') : p.enabled ? t('Incomplet') : t('Désactivé'));
    return {
      title: t('Assistant IA'),
      description: t('Fournisseurs, modèles et comptes autorisés. Les conversations ne sont pas conservées.'),
      blocks: [
        ...(c.encrypted ? [] : [{ type: 'notice', tone: 'warning', title: t('Clés non chiffrées. ').trim(),
          text: t('Elles sont gardées en clair dans la base. Définissez la variable d\'environnement CRAFTY_SECRET (longue valeur aléatoire) puis ressaisissez les clés.') }]),
        { type: 'form', id: 'access', title: t('Accès'), action: 'save-access', submit: t('Enregistrer'),
          description: t('Les administrateurs y ont toujours droit.'),
          fields: [
            { name: 'enabled', label: t('Assistant activé'), type: 'checkbox', value: c.enabled,
              help: t('Bouton « Assistant » sur l\'accueil et dans la barre du haut de chaque application.') },
            { name: 'everyone', label: t('Tous les comptes'), type: 'checkbox', value: c.everyone, help: t('Sinon, seulement les comptes cochés ci-dessous.') },
            ...others.map((u) => ({ name: `user-${u.id}`, label: u.disabled ? `${u.username} ${t('(désactivé)')}` : u.username, type: 'checkbox', value: c.users.includes(u.id) })),
            { name: 'maxPerHour', label: t('Échanges par heure et par compte'), type: 'number', value: c.maxPerHour, min: 1, max: 10000, step: 1, required: true,
              help: t('Chaque étape d\'une demande compte pour un échange.') },
            { name: 'maxSteps', label: t('Étapes par demande'), type: 'number', value: c.maxSteps, min: 1, max: 100, step: 1, required: true,
              help: t('Appels d\'outils enchaînés avant de rendre la main.') },
            { name: 'defaultProvider', label: t('Fournisseur par défaut'), type: 'select', value: ready.some((p) => p.id === c.defaultProvider) ? c.defaultProvider : '',
              options: [{ value: '', label: t('— premier fournisseur prêt —') }, ...ready.map((p) => ({ value: p.id, label: p.label }))],
              help: t('Les comptes peuvent choisir parmi les fournisseurs prêts.') },
          ] },
        ...c.providers.map((p) => ({
          type: 'form', id: `provider-${p.id}`, title: p.label, description: t('État : {state}', { state: status(p) }),
          action: `save-provider:${p.id}`, submit: t('Enregistrer'),
          fields: [
            { name: 'enabled', label: t('Activé'), type: 'checkbox', value: p.enabled },
            { name: 'model', label: t('Modèle'), type: 'text', value: p.model, maxLength: 200,
              placeholder: p.suggestedModel ? t('ex. {model}', { model: p.suggestedModel }) : t('identifiant du modèle'),
              help: t('Choisir un modèle qui sait appeler des outils (function calling).') },
            { name: 'effort', label: t('Effort (réflexion)'), type: 'select', value: p.effort,
              options: c.efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] ? t(EFFORT_LABELS[e]) : e })), help: t('Ignoré par les modèles qui ne le prennent pas en charge.') },
            { name: 'apiKey', label: t('Clé API'), type: 'password',
              placeholder: p.hasKey ? t('Clé enregistrée : laisser vide pour la garder') : p.keyUnreadable ? t('Clé illisible (CRAFTY_SECRET changé) : la ressaisir')
                : ['ollama', 'custom'].includes(p.id) ? t('Facultative') : t('Clé API'),
              help: t('Gardée sur le serveur, jamais renvoyée au navigateur.') },
            ...(p.hasKey || p.keyUnreadable ? [{ name: 'removeKey', label: t('Retirer la clé'), type: 'checkbox', value: false }] : []),
            { name: 'baseUrl', label: t('Adresse'), type: 'url', value: p.baseUrl, placeholder: p.defaultBaseUrl || 'https://…/v1',
              help: t('Vide : {url}', { url: p.defaultBaseUrl || t('à renseigner') }) },
          ],
        })),
        ...(ready.length ? [{ type: 'actions', title: t('Essai'), items: ready.map((p) => ({ id: `test:${p.id}`, label: `${t('Tester')} · ${p.label}`, description: p.model })) }] : []),
        { type: 'table', id: 'usage', title: t('Consommation (30 derniers jours)'),
          columns: [{ key: 'user', label: t('Compte') }, { key: 'provider', label: t('Fournisseur') }, { key: 'requests', label: t('Échanges') },
            { key: 'sent', label: t('Jetons envoyés') }, { key: 'received', label: t('Jetons reçus') }],
          rows: ai.usage().slice(0, 500).map((r, i) => ({ id: String(i), cells: { user: r.username, provider: c.providers.find((p) => p.id === r.provider)?.label || r.provider,
            requests: r.requests, sent: r.prompt_tokens, received: r.completion_tokens } })),
          empty: t('Aucun échange.') },
      ],
    };
  }

  async function aiAct(v, { action, values }) {
    const { t, req } = v;
    if (action === 'save-access') {
      const others = admin.listUsers().filter((u) => u.role !== 'admin');
      ai.updateConfig(req, { enabled: bool(values.enabled), everyone: bool(values.everyone), users: others.filter((u) => bool(values[`user-${u.id}`])).map((u) => u.id),
        maxPerHour: num(values.maxPerHour), maxSteps: num(values.maxSteps), defaultProvider: str(values.defaultProvider) || null });
      return { message: t('Assistant enregistré.') };
    }
    const [kind, id] = action.split(':');
    if (!id || !ai.providers.some((p) => p.id === id) || !['save-provider', 'test'].includes(kind)) throw new BoardError(404, 'not_found');
    if (kind === 'test') {
      // Le Board attend 15 s au plus : essai limité à 12 s.
      const r = await ai.testProvider(id, 12_000);
      return { message: t('Réponse en {ms} ms ({model}) : « {answer} »', { ms: r.ms, model: r.model, answer: r.answer }) };
    }
    const key = str(values.apiKey);
    ai.updateConfig(req, { providers: { [id]: { enabled: bool(values.enabled), baseUrl: str(values.baseUrl), model: str(values.model), effort: str(values.effort) || 'auto',
      ...(key ? { apiKey: key } : bool(values.removeKey) ? { apiKey: '' } : {}) } } });
    return { message: t('Assistant enregistré.') };
  }

  // ---------- Système ----------
  async function systemSection(v) {
    const { t, req } = v, s = await admin.system(), k = kosmy.adminJson(req);
    return {
      title: t('Système'),
      description: t('Connexion unique, secrets et sauvegardes.'),
      blocks: [
        { type: 'fields', title: t('Connexion avec Kosmy Board'), items: [
          { label: t('État'), value: k.enabled ? t('activée') : t('non réglée') },
          { label: t('Émetteur (issuer)'), value: k.issuer },
          { label: t('Identifiant client'), value: k.clientId },
          { label: t('Adresse de retour'), value: k.redirectUri },
          { label: t('Adresse de lancement'), value: k.loginUri },
        ] },
        { type: 'notice', tone: 'info', text: t('L\'émetteur, l\'identifiant et le secret client se changent dans Crafty (Administration → Système) : les modifier d\'ici couperait l\'accès du Board.') },
        { type: 'form', id: 'kosmy', title: t('Création automatique de compte'), action: 'save-kosmy', submit: t('Enregistrer'), fields: [
          { name: 'createAccounts', label: t('Création automatique de compte'), type: 'checkbox', value: k.createAccounts,
            help: t('Un compte Kosmy Board inconnu obtient un compte Crafty (simple utilisateur) à sa première connexion. Sinon, seuls les comptes reliés peuvent se connecter.') },
        ] },
        s.sso.dashy
          ? { type: 'fields', title: t('Connexion unique (Dashy)'), items: [
            { label: t('État'), value: t('activée') }, { label: t('Dashy'), value: s.sso.dashyUrl },
            { label: t('Adresse de retour à autoriser dans Dashy'), value: s.sso.callback }] }
          : { type: 'notice', tone: 'info', title: t('Connexion unique (Dashy)'),
            text: t('Désactivée. Pour l\'activer : SSO_SHARED_SECRET (le même que dans Dashy), SSO_DASHY_URL et PUBLIC_ORIGIN dans l\'environnement du conteneur (docs/DEPLOIEMENT.md).') },
        s.secretsEncrypted
          ? { type: 'notice', tone: 'success', title: t('Secrets'), text: t('Clés des fournisseurs d\'IA et secrets de double authentification chiffrés avec CRAFTY_SECRET.') }
          : { type: 'notice', tone: 'warning', title: t('Secrets'),
            text: t('CRAFTY_SECRET n\'est pas défini : clés d\'IA et secrets de double authentification sont gardés en clair dans la base.') },
        { type: 'table', id: 'backups', title: t('Sauvegardes de la base'),
          description: s.backupEveryHours
            ? t('Instantané automatique toutes les {n} h dans DATA_DIR/backups (à copier hors du serveur avec le reste du volume).', { n: s.backupEveryHours })
            : t('Instantané automatique désactivé (BACKUP_EVERY_HOURS). À la main : node scripts/backup.mjs'),
          columns: [{ key: 'name', label: t('Instantané') }, { key: 'size', label: t('Taille') }, { key: 'at', label: t('Date') }],
          rows: s.backups.map((b) => ({ id: b.name, cells: { name: b.name, size: v.size(b.size), at: v.date(b.at) } })),
          empty: t('Aucun instantané pour l\'instant.') },
      ],
    };
  }

  function systemAct(v, { action, values }) {
    if (action !== 'save-kosmy') throw new BoardError(404, 'not_found');
    kosmy.saveSettings(v.req, { createAccounts: bool(values.createAccounts) });
    return { message: v.t('Réglages enregistrés.') };
  }

  // ---------- Journal ----------
  function auditSection(v) {
    const { t } = v;
    return {
      title: t('Journal'),
      description: t('200 derniers événements : connexions, fichiers, administration.'),
      blocks: [{ type: 'table', id: 'audit',
        columns: [{ key: 'at', label: t('Date') }, { key: 'user', label: t('Compte') }, { key: 'action', label: t('Action') },
          { key: 'target', label: t('Cible') }, { key: 'detail', label: t('Détail') }, { key: 'ip', label: 'IP' }],
        rows: admin.audit(200).map((r) => ({ id: String(r.id), cells: { at: v.date(r.at), user: r.username ?? '—',
          action: AUDIT_LABELS[r.action] ? t(AUDIT_LABELS[r.action]) : r.action, target: r.target ?? '', detail: String(r.detail ?? '').slice(0, 500), ip: r.ip ?? '' } })),
        empty: t('Aucun événement.') }],
    };
  }

  // ---------- Vue d'ensemble ----------
  async function overviewSection(v) {
    const { t, req } = v, s = admin.settings(), sys = await admin.system(), users = admin.listUsers(), k = kosmy.adminJson(req), now = Date.now();
    const used = users.reduce((n, u) => n + u.used, 0), files = users.reduce((n, u) => n + u.files, 0);
    const admins = users.filter((u) => u.role === 'admin' && !u.disabled).length, disabled = users.filter((u) => u.disabled).length;
    return {
      title: t('Vue d\'ensemble'),
      blocks: [
        ...(sys.secretsEncrypted ? [] : [{ type: 'notice', tone: 'warning', title: t('Secrets'),
          text: t('CRAFTY_SECRET n\'est pas défini : clés d\'IA et secrets de double authentification sont gardés en clair dans la base.') }]),
        ...(s.signup_open ? [{ type: 'notice', tone: 'warning', title: t('Inscription publique'),
          text: t('Toute personne qui atteint la page peut créer un compte (rôle utilisateur, toutes les applications).') }] : []),
        ...(sys.backupEveryHours ? [] : [{ type: 'notice', tone: 'info', title: t('Sauvegardes de la base'),
          text: t('Instantané automatique désactivé (BACKUP_EVERY_HOURS). À la main : node scripts/backup.mjs') }]),
        { type: 'stats', title: t('En bref'), items: [
          { label: t('Comptes'), value: users.length, hint: t('{n} administrateur(s) actif(s)', { n: admins }) },
          { label: t('Comptes désactivés'), value: disabled },
          { label: t('Sessions ouvertes'), value: q.sessions.get(now).n },
          { label: t('Fichiers'), value: files },
          { label: t('Espace utilisé'), value: v.size(used), hint: t('versions et corbeille comprises') },
          { label: t('Liens de partage actifs'), value: s.sharing_enabled ? q.shares.get(now).n : 0, hint: s.sharing_enabled ? undefined : t('liens de partage désactivés') },
        ] },
        { type: 'fields', title: t('Instance'), items: [
          { label: t('Version de Crafty'), value: VERSION || '—' },
          { label: 'Node.js', value: process.version },
          { label: t('Adresse'), value: new URL(k.loginUri).origin },
          { label: t('Mode invité'), value: s.guest_enabled ? t('oui') : t('non') },
          { label: t('Sauvegarde automatique de la base'), value: sys.backupEveryHours ? t('toutes les {n} h', { n: sys.backupEveryHours }) : t('désactivée') },
        ] },
        { type: 'table', id: 'apps', title: t('Applications'),
          columns: [{ key: 'name', label: t('Application') }, { key: 'version', label: t('Version') }],
          rows: appList().map((a) => ({ id: a.slug, cells: { name: a.name, version: a.version } })),
          empty: t('Aucune application.') },
      ],
    };
  }

  const SECTIONS = {
    overview: { build: overviewSection },
    users: { build: usersSection, act: usersAct },
    settings: { build: settingsSection, act: settingsAct },
    ai: { build: aiSection, act: aiAct },
    system: { build: systemSection, act: systemAct },
    audit: { build: auditSection },
  };
  const build = async (v, id) => ({ id, ...(await SECTIONS[id].build(v)) });

  // Jeton du Board → compte Crafty administrateur, ou refus (401 invalid_token, 403 not_linked / forbidden).
  async function authenticate(req, t) {
    const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) throw new BoardError(401, 'invalid_token');
    let id;
    try { id = await kosmy.adminIdentity(m[1], { method: req.method, path: req.path.replace(/\/+$/, '') }); }
    catch (e) {
      if (e.message === 'unreachable') throw new BoardError(503, 'unavailable', t('Kosmy Board ne répond pas : réessayez plus tard.'));
      throw new BoardError(401, 'invalid_token');
    }
    const u = id.user;
    if (!u) throw new BoardError(403, 'not_linked', t('Ce compte Kosmy Board n\'est relié à aucun compte Crafty. Connectez-vous à Crafty avec votre mot de passe, puis menu du compte → Relier à Kosmy Board.'));
    if (u.disabled) throw new BoardError(403, 'forbidden', t('Votre compte Crafty est désactivé.'));
    if (u.role !== 'admin') throw new BoardError(403, 'forbidden', t('Votre compte Crafty n\'a pas les droits d\'administration.'));
    if (u.must_change) throw new BoardError(403, 'forbidden', t('Changez d\'abord le mot de passe provisoire de votre compte Crafty.'));
    return u;
  }

  async function handle(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const send = (status, body) => res.status(status).json(body);
    const t0 = (fr, vars) => tr(langOf(req), fr, vars);
    try {
      const u = await authenticate(req, t0);
      // L'acteur des fonctions d'administration (journal, contrôles « soi-même ») : le compte relié, pas de session.
      req.user = { id: u.id, username: u.username, role: u.role };
      req.sessionHash = '';
      req.via = 'kosmy-board';
      const v = view(req, u);
      const section = req.params.section;
      if (section === undefined) {
        if (req.method !== 'GET') throw new BoardError(405, 'method_not_allowed');
        return send(200, { protocol: PROTOCOL, app: { name: 'Crafty', ...(VERSION ? { version: VERSION } : {}) },
          user: { name: u.username, role: v.t('Administrateur') },
          sections: Object.keys(SECTIONS).map((id) => ({ id, title: v.t(SECTION_TITLES[id]) })) });
      }
      if (!SECTION_RE.test(section) || !Object.hasOwn(SECTIONS, section)) throw new BoardError(404, 'not_found');
      if (req.method === 'GET') return send(200, await build(v, section));
      if (req.method !== 'POST') throw new BoardError(405, 'method_not_allowed');
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string' || !ACTION_RE.test(body.action)
        || (body.values !== undefined && (body.values === null || typeof body.values !== 'object' || Array.isArray(body.values)))) {
        throw new BoardError(400, 'invalid_request', v.t('Requête illisible.'));
      }
      if (!SECTIONS[section].act) throw new BoardError(404, 'not_found');
      let result;
      try { result = await SECTIONS[section].act(v, { action: body.action, row: body.row, values: body.values ?? {} }); }
      catch (e) {
        if (!e.expose) throw e;
        // Refus des fonctions d'administration : même message que dans Crafty, dans la langue demandée.
        const code = e.status === 404 ? 'not_found' : e.status === 409 ? 'conflict' : e.status === 502 ? 'failed' : 'invalid';
        throw new BoardError(e.status === 404 || e.status === 409 ? e.status : 422, code, translate(v.lang, e.message));
      }
      return send(200, { ok: true, ...result, section: await build(v, section) });
    } catch (e) {
      if (!(e instanceof BoardError)) console.error('Admin dans Kosmy Board :', e);
      const f = e instanceof BoardError ? e : new BoardError(500, 'server_error');
      return send(f.status, { error: f.code, ...(f.userMessage ? { message: f.userMessage } : {}) });
    }
  }

  app.all(BOARD_ADMIN_PATH, handle);
  app.all(`${BOARD_ADMIN_PATH}/:section`, handle);
}
