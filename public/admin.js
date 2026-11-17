// Administration : comptes, applications par compte, réglages (inscription, invités, versions, quotas), journal.
import { renderAi } from '/admin-ai.js';
import { renderSystem } from '/admin-system.js';
import { api, h, icon, toast, dialog, confirmDialog, openMenu, menuAt, appTile, formatSize, formatDateTime, accountButton, syncTheme } from '/ui.js';
import { t, translateDom } from '/i18n.js';

translateDom();

const $ = (id) => document.getElementById(id);
let me, apps = [], users = [], settings = null, ssoEnabled = false;
const GIB = 1024 ** 3, MIB = 1024 ** 2;

function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(14));
  return [...r].map((x) => abc[x % abc.length]).join('');
}
const fail = (title) => (e) => toast({ type: 'error', title, detail: e.message });

// ---------- Onglets ----------
const TABS = ['users', 'settings', 'ai', 'system', 'audit'];
function selectTab(name) {
  for (const tb of TABS) {
    const on = tb === name;
    $(`tab-${tb}`).setAttribute('aria-selected', String(on));
    $(`tab-${tb}`).tabIndex = on ? 0 : -1;
    $(`panel-${tb}`).hidden = !on;
  }
  history.replaceState(null, '', `#${name}`);
  if (name === 'audit') loadAudit();
  if (name === 'ai') renderAi($('ai'), users);
  if (name === 'system') renderSystem($('system')).catch(fail(t('Chargement impossible')));
}
for (const tb of TABS) {
  $(`tab-${tb}`).onclick = () => selectTab(tb);
  $(`tab-${tb}`).onkeydown = (e) => {
    const i = TABS.indexOf(tb);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      selectTab(n); $(`tab-${n}`).focus();
    }
  };
}

// ---------- Choix des applications (toutes / sélection) ----------
function appsChooser(name, all, selected = []) {
  const allRadio = h('input', { type: 'radio', name, checked: all });
  const someRadio = h('input', { type: 'radio', name, checked: !all });
  const boxes = apps.map((a) => h('input', { type: 'checkbox', value: a.slug, checked: selected.includes(a.slug) }));
  const list = h('div', { class: 'app-checks' }, apps.map((a, i) => h('label', { class: 'check' }, boxes[i], appTile(a, 'app-tile mini'), a.name)));
  const sync = () => { list.hidden = allRadio.checked; };
  allRadio.onchange = sync; someRadio.onchange = sync; sync();
  return {
    el: h('div', {}, h('label', { class: 'check' }, allRadio, t('Toutes les applications (y compris celles ajoutées plus tard)')),
      h('label', { class: 'check' }, someRadio, t('Seulement celles-ci :')), list),
    value: () => ({ allApps: allRadio.checked, apps: boxes.filter((b) => b.checked).map((b) => b.value) }),
  };
}
const quotaInput = (bytes) => h('input', { type: 'number', min: 0, step: 0.5, placeholder: t('par défaut ({size})', { size: formatSize(settings?.default_quota ?? GIB) }),
  value: bytes == null ? '' : String(+(bytes / GIB).toFixed(2)) });
const quotaValue = (input) => (input.value === '' ? null : Math.round(Number(input.value) * GIB));

// ---------- Comptes ----------
async function loadUsers() {
  users = await api('/api/admin/users');
  $('users').replaceChildren(...users.map(userRow));
}
function userRow(u) {
  const quota = u.quota ?? settings?.default_quota ?? GIB;
  const ratio = quota ? Math.min(1, u.used / quota) : 0;
  const meter = h('div', { class: `meter${ratio > .95 ? ' full' : ''}` }, h('span'));
  meter.firstChild.style.width = `${(ratio * 100).toFixed(1)}%`;
  const more = h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': t('Actions pour {name}', { name: u.username }), 'aria-haspopup': 'menu' }, icon('more'));
  more.onclick = () => openMenu([
    { label: t('Modifier…'), icon: 'edit', onClick: () => editUser(u) },
    { label: t('Nouveau mot de passe provisoire…'), icon: 'key', onClick: () => resetPassword(u) },
    u.locked && { label: t('Déverrouiller'), icon: 'key', onClick: () => patch(u, { unlock: true }, t('Compte déverrouillé.')) },
    u.twoFactor && { label: t('Retirer la double authentification…'), icon: 'shield', onClick: () => reset2fa(u) },
    u.dashy && u.hasPassword && { label: t('Délier de Dashy'), icon: 'user', onClick: () => patch(u, { unlinkDashy: true }, t('Compte délié de Dashy.')) },
    u.kosmy && u.hasPassword && { label: t('Délier de Kosmy Board'), icon: 'grid', onClick: () => patch(u, { unlinkKosmy: true }, t('Compte délié de Kosmy Board.')) },
    u.id !== me.user.id && (u.disabled
      ? { label: t('Réactiver'), icon: 'check', onClick: () => patch(u, { disabled: false }, t('Compte réactivé.')) }
      : { label: t('Désactiver'), icon: 'logout', onClick: () => patch(u, { disabled: true }, t('Compte désactivé, ses sessions sont fermées.')) }),
    { separator: true },
    u.id !== me.user.id && { label: t('Supprimer…'), icon: 'trash', danger: true, onClick: () => deleteUser(u) },
  ], menuAt(more));
  const nameOf = (s) => apps.find((a) => a.slug === s)?.name || s;
  return h('tr', {},
    h('td', {}, h('div', { class: 'who' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, u.username.slice(0, 1).toUpperCase()),
      h('div', {}, h('strong', {}, u.username), h('div', { class: 'badges' },
        u.role === 'admin' ? h('span', { class: 'badge accent' }, t('admin')) : null,
        u.disabled ? h('span', { class: 'badge danger' }, t('désactivé')) : null,
        u.locked ? h('span', { class: 'badge danger' }, t('verrouillé')) : null,
        u.mustChange ? h('span', { class: 'badge warn' }, t('mot de passe provisoire')) : null,
        u.twoFactor ? h('span', { class: 'badge' }, t('double authentification')) : null,
        u.dashy ? h('span', { class: 'badge' }, u.hasPassword ? t('lié à Dashy') : t('Dashy seulement')) : null,
        u.kosmy ? h('span', { class: 'badge' }, u.hasPassword ? t('relié à Kosmy Board') : t('Kosmy Board seulement')) : null)))),
    h('td', {}, u.role === 'admin' || u.allApps ? h('span', { class: 'badge' }, t('Toutes'))
      : h('div', { class: 'apps-cell' }, u.apps.length ? u.apps.map((s) => h('span', { class: 'badge' }, nameOf(s))) : h('span', { class: 'badge danger' }, t('Aucune')))),
    h('td', {}, h('div', { class: 'space' },
      u.quota == null ? `${formatSize(u.used)} / ${formatSize(quota)}` : t('{used} / {quota} (personnalisé)', { used: formatSize(u.used), quota: formatSize(quota) }),
      meter, u.files === 1 ? t('1 fichier(s)') : t('{n} fichier(s)', { n: u.files }))),
    h('td', { class: 'mut' }, u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('jamais')),
    h('td', {}, more));
}
async function patch(u, body, ok) {
  try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); toast({ title: ok }); await loadUsers(); }
  catch (e) { fail(t('Modification impossible'))(e); }
}
function showPassword(username, password) {
  const input = h('input', { type: 'text', value: password, readOnly: true });
  const copy = h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(password); copy.textContent = t('Copié'); } catch { input.select(); } } }, t('Copier'));
  dialog({ title: t('Mot de passe provisoire'), body: h('div', { class: 'form' },
    h('p', {}, t('Transmettez ce mot de passe à {name}. Il devra le changer à sa première connexion. Il ne sera plus affiché.', { name: username })),
    h('div', { class: 'temp-pass' }, input, copy)),
  actions: [h('button', { class: 'btn primary', value: 'ok' }, t('J\'ai noté le mot de passe'))] });
  input.select();
}
function newUser() {
  const username = h('input', { type: 'text', required: true, autocomplete: 'off', spellcheck: false, autocapitalize: 'none' });
  const role = h('select', {}, h('option', { value: 'user' }, t('Utilisateur')), h('option', { value: 'admin' }, t('Administrateur')));
  const quota = quotaInput(null);
  const chooser = appsChooser('new-apps', true);
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const dlg = dialog({ title: t('Nouveau compte'), wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'row' }, h('label', { class: 'field' }, t('Identifiant'), username, h('span', { class: 'hint' }, t('3 à 32 caractères : lettres, chiffres, . _ -'))),
        h('label', { class: 'field' }, t('Rôle'), role)),
      h('fieldset', { class: 'card' }, h('legend', { class: 'visually-hidden' }, t('Applications')), h('h3', {}, t('Applications')), chooser.el),
      h('label', { class: 'field' }, t('Quota (Gio)'), quota, h('span', { class: 'hint' }, t('Vide = quota par défaut des réglages. Les anciennes versions comptent.'))),
      h('p', { class: 'mut' }, t('Un mot de passe provisoire sera généré ; il faudra le changer à la première connexion.')), errEl),
    actions: [h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, t('Annuler')), h('button', { class: 'btn primary', value: 'ok' }, t('Créer le compte'))] });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const password = tempPassword();
    const { allApps, apps: list } = chooser.value();
    try {
      await api('/api/admin/users', { method: 'POST', body: { username: username.value.trim(), password, role: role.value, allApps, apps: list, quota: quotaValue(quota) } });
      dlg.close('done');
      await loadUsers();
      showPassword(username.value.trim(), password);
    } catch (err) { errEl.textContent = err.message; }
  });
  username.focus();
}
function editUser(u) {
  const role = h('select', { disabled: u.id === me.user.id }, h('option', { value: 'user' }, t('Utilisateur')), h('option', { value: 'admin' }, t('Administrateur')));
  role.value = u.role;
  const quota = quotaInput(u.quota);
  const chooser = appsChooser('edit-apps', u.allApps, u.apps);
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const dlg = dialog({ title: t('Modifier {name}', { name: u.username }), wide: true,
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, t('Rôle'), role, h('span', { class: 'hint' }, t('Un administrateur a toujours accès à toutes les applications.'))),
      h('fieldset', { class: 'card' }, h('legend', { class: 'visually-hidden' }, t('Applications')), h('h3', {}, t('Applications')), chooser.el),
      h('label', { class: 'field' }, t('Quota (Gio)'), quota, h('span', { class: 'hint' }, t('Vide = quota par défaut.'))), errEl),
    actions: [h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, t('Annuler')), h('button', { class: 'btn primary', value: 'ok' }, t('Enregistrer'))] });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const body = { ...chooser.value(), quota: quotaValue(quota) };
    if (u.id !== me.user.id) body.role = role.value;
    try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); dlg.close('done'); toast({ title: t('Compte modifié.') }); await loadUsers(); }
    catch (err) { errEl.textContent = err.message; }
  });
}
async function resetPassword(u) {
  if (!(await confirmDialog({ title: t('Nouveau mot de passe pour {name} ?', { name: u.username }), message: t('Un mot de passe provisoire remplace l\'actuel ; ses sessions ouvertes sont fermées.'), confirm: t('Générer') }))) return;
  const password = tempPassword();
  try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { password } }); await loadUsers(); showPassword(u.username, password); }
  catch (e) { fail(t('Réinitialisation impossible'))(e); }
}
async function reset2fa(u) {
  if (!(await confirmDialog({ title: t('Retirer la double authentification de {name} ?', { name: u.username }), danger: true, confirm: t('Retirer'),
    message: t('À faire seulement si la personne a perdu son téléphone et ses codes de secours, après avoir vérifié son identité. Elle pourra la réactiver depuis son compte.') }))) return;
  await patch(u, { reset2fa: true }, t('Double authentification retirée.'));
}
async function deleteUser(u) {
  const size = formatSize(u.used);
  if (!(await confirmDialog({ title: t('Supprimer {name} ?', { name: u.username }), danger: true, confirm: t('Supprimer définitivement'),
    message: u.files === 1 ? t('Le compte et ses 1 fichier(s) ({size}, versions comprises) seront effacés. Cette action est définitive.', { size })
      : t('Le compte et ses {n} fichier(s) ({size}, versions comprises) seront effacés. Cette action est définitive.', { n: u.files, size }) }))) return;
  try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast({ title: t('{name} supprimé.', { name: u.username }) }); await loadUsers(); }
  catch (e) { fail(t('Suppression impossible'))(e); }
}

// ---------- Réglages ----------
function switchRow(title, hint, checked) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked });
  return { input, el: h('label', { class: 'switch-row' }, h('div', {}, h('strong', {}, title), h('div', { class: 'mut' }, hint)),
    h('span', { class: 'switch' }, input, h('span')) ) };
}
function renderSettings() {
  const s = settings;
  const signup = switchRow(t('Inscription publique'), t('Toute personne qui atteint la page peut créer un compte (rôle utilisateur, toutes les applications).'), s.signup_open);
  const guest = switchRow(t('Mode invité'), t('Bouton « Continuer en invité » : applications sans stockage, les enregistrements sont téléchargés.'), s.guest_enabled);
  const guestApps = appsChooser('guest-apps', s.guest_apps === null, s.guest_apps || []);
  const guestBox = h('div', {}, h('div', { class: 'mut' }, t('Applications ouvertes aux invités :')), guestApps.el);
  const syncGuest = () => { guestBox.hidden = !guest.input.checked; };
  guest.input.onchange = syncGuest; syncGuest();
  const versions = h('input', { type: 'number', min: 1, max: 100, step: 1, value: String(s.max_versions), required: true });
  const quota = h('input', { type: 'number', min: 0, step: 0.5, value: String(+(s.default_quota / GIB).toFixed(2)), required: true });
  const maxSize = h('input', { type: 'number', min: 1, max: 512, step: 1, value: String(Math.round(s.max_file_size / MIB)), required: true });
  const autosave = h('input', { type: 'number', min: 0, max: 3600, step: 5, value: String(s.autosave_seconds), required: true });
  const trashDays = h('input', { type: 'number', min: 0, max: 365, step: 1, value: String(s.trash_days), required: true });
  const ssoCreate = switchRow(t('Comptes créés par Dashy'), t("Une identité Dashy inconnue obtient un compte Crafty à sa première connexion (administrateur si elle l'est dans Dashy). Sinon, seuls les comptes déjà liés peuvent se connecter avec Dashy."), s.sso_create_accounts);
  ssoCreate.el.hidden = !ssoEnabled;
  const sharing = switchRow(t('Liens de partage'), t('Les comptes peuvent créer un lien public (avec expiration) vers un fichier. Désactiver coupe aussi les liens existants.'), s.sharing_enabled);
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const form = $('settings');
  form.replaceChildren(
    h('div', { class: 'card' }, h('h3', {}, t('Accès')), signup.el, guest.el, guestBox, sharing.el, ssoCreate.el),
    h('div', { class: 'card' }, h('h3', {}, t('Fichiers')),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, t('Versions conservées par fichier'), versions, h('span', { class: 'hint' }, t('Les plus anciennes sont effacées au prochain enregistrement.'))),
        h('label', { class: 'field' }, t('Quota par défaut (Gio)'), quota, h('span', { class: 'hint' }, t('Par compte, versions comprises.'))),
        h('label', { class: 'field' }, t('Taille max. d\'un fichier (Mio)'), maxSize, h('span', { class: 'hint' }, t('512 au plus (limite des applications).')))),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, t('Sauvegarde automatique (secondes)'), autosave, h('span', { class: 'hint' },
          t('Délai après une modification ; 0 = désactivée. Les sauvegardes automatiques successives mettent à jour une seule version ; seuls les « Enregistrer » ajoutent des versions.'))),
        h('label', { class: 'field' }, t('Corbeille (jours)'), trashDays, h('span', { class: 'hint' }, t('Durée avant effacement définitif ; 0 = pas de corbeille (suppression immédiate). Compte dans le quota.'))))),
    errEl, h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, t('Enregistrer les réglages'))));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const g = guestApps.value();
    try {
      settings = await api('/api/admin/settings', { method: 'PATCH', body: {
        signup_open: signup.input.checked, guest_enabled: guest.input.checked, guest_apps: g.allApps ? null : g.apps,
        max_versions: Number(versions.value), default_quota: Math.round(Number(quota.value) * GIB), max_file_size: Math.round(Number(maxSize.value) * MIB), autosave_seconds: Number(autosave.value), trash_days: Number(trashDays.value), sharing_enabled: sharing.input.checked, sso_create_accounts: ssoCreate.input.checked } });
      errEl.textContent = '';
      toast({ title: t('Réglages enregistrés.') });
      await loadUsers();
    } catch (err) { errEl.textContent = err.message; }
  };
}

// ---------- Journal ----------
const ACTIONS = { 'auth.login': t('Connexion'), 'auth.logout': t('Déconnexion'), 'auth.setup': t('Création du compte admin'), 'auth.register': t('Inscription'),
  'auth.password': t('Mot de passe changé'), 'file.upload': t('Import'), 'file.save': t('Enregistrement'), 'file.autosave': t('Sauvegarde automatique'), 'file.update': t('Fichier modifié'),
  'file.delete': t('Fichier supprimé'), 'file.restore': t('Version restaurée'), 'folder.create': t('Dossier créé'), 'folder.update': t('Dossier modifié'),
  'folder.delete': t('Dossier supprimé'), 'admin.user.create': t('Compte créé'), 'admin.user.update': t('Compte modifié'),
  'admin.user.delete': t('Compte supprimé'), 'file.trash': t('Mis à la corbeille'), 'folder.trash': t('Dossier à la corbeille'), 'file.untrash': t('Restauré de la corbeille'), 'folder.restore': t('Dossier restauré'), 'share.create': t('Lien de partage créé'), 'share.revoke': t('Lien révoqué'), 'share.access': t('Lien de partage ouvert'), 'admin.settings': t('Réglages modifiés'), 'admin.ai': t('Assistant IA modifié'), 'ai.error': t("Erreur de l'assistant"),
  'auth.2fa.enable': t('Double authentification activée'), 'auth.2fa.disable': t('Double authentification désactivée'), 'auth.2fa.recovery': t('Codes de secours renouvelés'),
  'auth.sso': t('Connexion par Dashy'), 'auth.sso.create': t('Compte créé par Dashy'), 'auth.sso.link': t('Compte lié à Dashy'),
  'auth.kosmy': t('Connexion par Kosmy Board'), 'auth.kosmy.create': t('Compte créé par Kosmy Board'), 'auth.kosmy.link': t('Compte relié à Kosmy Board'),
  'auth.kosmy.unlink': t('Compte délié de Kosmy Board'), 'admin.kosmy': t('Réglages Kosmy Board modifiés') };
async function loadAudit() {
  try {
    const rows = await api('/api/admin/audit?limit=200');
    $('audit').replaceChildren(...rows.map((r) => h('tr', {},
      h('td', { class: 'mut' }, formatDateTime(r.at)), h('td', {}, r.username ?? '—'), h('td', {}, ACTIONS[r.action] || r.action),
      h('td', { class: 'wrap mut' }, r.target ?? ''), h('td', { class: 'wrap mut' }, r.detail ?? ''), h('td', { class: 'mut' }, r.ip ?? ''))));
  } catch (e) { fail(t('Journal indisponible'))(e); }
}

async function main() {
  me = await api('/api/me');
  syncTheme(me);
  apps = me.apps;
  $('account').replaceWith(accountButton(me));
  $('newUser').onclick = newUser;
  $('refreshAudit').onclick = loadAudit;
  settings = await api('/api/admin/settings');
  ssoEnabled = !!me.user.ssoDashy;
  renderSettings();
  await loadUsers();
  const tab = location.hash.slice(1);
  selectTab(TABS.includes(tab) ? tab : 'users');
}
main().catch((e) => { if (e.status !== 401) toast({ type: 'error', title: t('Chargement impossible'), detail: e.message }); });
