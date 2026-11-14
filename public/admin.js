// Administration : comptes, applications par compte, réglages (inscription, invités, versions, quotas), journal.
import { api, h, icon, toast, dialog, confirmDialog, openMenu, menuAt, appTile, formatSize, formatDateTime, accountButton, syncTheme } from '/ui.js';

const $ = (id) => document.getElementById(id);
let me, apps = [], users = [], settings = null;
const GIB = 1024 ** 3, MIB = 1024 ** 2;

function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(14));
  return [...r].map((x) => abc[x % abc.length]).join('');
}
const fail = (title) => (e) => toast({ type: 'error', title, detail: e.message });

// ---------- Onglets ----------
const TABS = ['users', 'settings', 'audit'];
function selectTab(name) {
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  history.replaceState(null, '', `#${name}`);
  if (name === 'audit') loadAudit();
}
for (const t of TABS) {
  $(`tab-${t}`).onclick = () => selectTab(t);
  $(`tab-${t}`).onkeydown = (e) => {
    const i = TABS.indexOf(t);
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
    el: h('div', {}, h('label', { class: 'check' }, allRadio, 'Toutes les applications (y compris celles ajoutées plus tard)'),
      h('label', { class: 'check' }, someRadio, 'Seulement celles-ci :'), list),
    value: () => ({ allApps: allRadio.checked, apps: boxes.filter((b) => b.checked).map((b) => b.value) }),
  };
}
const quotaInput = (bytes) => h('input', { type: 'number', min: 0, step: 0.5, placeholder: `par défaut (${formatSize(settings?.default_quota ?? GIB)})`,
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
  const more = h('button', { class: 'btn icon ghost', type: 'button', 'aria-label': `Actions pour ${u.username}`, 'aria-haspopup': 'menu' }, icon('more'));
  more.onclick = () => openMenu([
    { label: 'Modifier…', icon: 'edit', onClick: () => editUser(u) },
    { label: 'Nouveau mot de passe provisoire…', icon: 'key', onClick: () => resetPassword(u) },
    u.locked && { label: 'Déverrouiller', icon: 'key', onClick: () => patch(u, { unlock: true }, 'Compte déverrouillé.') },
    u.id !== me.user.id && (u.disabled
      ? { label: 'Réactiver', icon: 'check', onClick: () => patch(u, { disabled: false }, 'Compte réactivé.') }
      : { label: 'Désactiver', icon: 'logout', onClick: () => patch(u, { disabled: true }, 'Compte désactivé, ses sessions sont fermées.') }),
    { separator: true },
    u.id !== me.user.id && { label: 'Supprimer…', icon: 'trash', danger: true, onClick: () => deleteUser(u) },
  ], menuAt(more));
  const nameOf = (s) => apps.find((a) => a.slug === s)?.name || s;
  return h('tr', {},
    h('td', {}, h('div', { class: 'who' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, u.username.slice(0, 1).toUpperCase()),
      h('div', {}, h('strong', {}, u.username), h('div', { class: 'badges' },
        u.role === 'admin' ? h('span', { class: 'badge accent' }, 'admin') : null,
        u.disabled ? h('span', { class: 'badge danger' }, 'désactivé') : null,
        u.locked ? h('span', { class: 'badge danger' }, 'verrouillé') : null,
        u.mustChange ? h('span', { class: 'badge warn' }, 'mot de passe provisoire') : null)))),
    h('td', {}, u.role === 'admin' || u.allApps ? h('span', { class: 'badge' }, 'Toutes')
      : h('div', { class: 'apps-cell' }, u.apps.length ? u.apps.map((s) => h('span', { class: 'badge' }, nameOf(s))) : h('span', { class: 'badge danger' }, 'Aucune'))),
    h('td', {}, h('div', { class: 'space' }, `${formatSize(u.used)} / ${formatSize(quota)}${u.quota == null ? '' : ' (personnalisé)'}`, meter, `${u.files} fichier(s)`)),
    h('td', { class: 'mut' }, u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'jamais'),
    h('td', {}, more));
}
async function patch(u, body, ok) {
  try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); toast({ title: ok }); await loadUsers(); }
  catch (e) { fail('Modification impossible')(e); }
}
function showPassword(username, password) {
  const input = h('input', { type: 'text', value: password, readOnly: true });
  const copy = h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(password); copy.textContent = 'Copié'; } catch { input.select(); } } }, 'Copier');
  dialog({ title: 'Mot de passe provisoire', body: h('div', { class: 'form' },
    h('p', {}, `Transmettez ce mot de passe à ${username}. Il devra le changer à sa première connexion. Il ne sera plus affiché.`),
    h('div', { class: 'temp-pass' }, input, copy)),
  actions: [h('button', { class: 'btn primary', value: 'ok' }, 'J\'ai noté le mot de passe')] });
  input.select();
}
function newUser() {
  const username = h('input', { type: 'text', required: true, autocomplete: 'off', spellcheck: false, autocapitalize: 'none' });
  const role = h('select', {}, h('option', { value: 'user' }, 'Utilisateur'), h('option', { value: 'admin' }, 'Administrateur'));
  const quota = quotaInput(null);
  const chooser = appsChooser('new-apps', true);
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const dlg = dialog({ title: 'Nouveau compte', wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Identifiant', username, h('span', { class: 'hint' }, '3 à 32 caractères : lettres, chiffres, . _ -')),
        h('label', { class: 'field' }, 'Rôle', role)),
      h('fieldset', { class: 'card' }, h('legend', { class: 'visually-hidden' }, 'Applications'), h('h3', {}, 'Applications'), chooser.el),
      h('label', { class: 'field' }, 'Quota (Gio)', quota, h('span', { class: 'hint' }, 'Vide = quota par défaut des réglages. Les anciennes versions comptent.')),
      h('p', { class: 'mut' }, 'Un mot de passe provisoire sera généré ; il faudra le changer à la première connexion.'), errEl),
    actions: [h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Annuler'), h('button', { class: 'btn primary', value: 'ok' }, 'Créer le compte')] });
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
  const role = h('select', { disabled: u.id === me.user.id }, h('option', { value: 'user' }, 'Utilisateur'), h('option', { value: 'admin' }, 'Administrateur'));
  role.value = u.role;
  const quota = quotaInput(u.quota);
  const chooser = appsChooser('edit-apps', u.allApps, u.apps);
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const dlg = dialog({ title: `Modifier ${u.username}`, wide: true,
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, 'Rôle', role, h('span', { class: 'hint' }, 'Un administrateur a toujours accès à toutes les applications.')),
      h('fieldset', { class: 'card' }, h('legend', { class: 'visually-hidden' }, 'Applications'), h('h3', {}, 'Applications'), chooser.el),
      h('label', { class: 'field' }, 'Quota (Gio)', quota, h('span', { class: 'hint' }, 'Vide = quota par défaut.')), errEl),
    actions: [h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Annuler'), h('button', { class: 'btn primary', value: 'ok' }, 'Enregistrer')] });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const body = { ...chooser.value(), quota: quotaValue(quota) };
    if (u.id !== me.user.id) body.role = role.value;
    try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); dlg.close('done'); toast({ title: 'Compte modifié.' }); await loadUsers(); }
    catch (err) { errEl.textContent = err.message; }
  });
}
async function resetPassword(u) {
  if (!(await confirmDialog({ title: `Nouveau mot de passe pour ${u.username} ?`, message: 'Un mot de passe provisoire remplace l\'actuel ; ses sessions ouvertes sont fermées.', confirm: 'Générer' }))) return;
  const password = tempPassword();
  try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { password } }); await loadUsers(); showPassword(u.username, password); }
  catch (e) { fail('Réinitialisation impossible')(e); }
}
async function deleteUser(u) {
  if (!(await confirmDialog({ title: `Supprimer ${u.username} ?`, danger: true, confirm: 'Supprimer définitivement',
    message: `Le compte et ses ${u.files} fichier(s) (${formatSize(u.used)}, versions comprises) seront effacés. Cette action est définitive.` }))) return;
  try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast({ title: `${u.username} supprimé.` }); await loadUsers(); }
  catch (e) { fail('Suppression impossible')(e); }
}

// ---------- Réglages ----------
function switchRow(title, hint, checked) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked });
  return { input, el: h('label', { class: 'switch-row' }, h('div', {}, h('strong', {}, title), h('div', { class: 'mut' }, hint)),
    h('span', { class: 'switch' }, input, h('span')) ) };
}
function renderSettings() {
  const s = settings;
  const signup = switchRow('Inscription publique', 'Toute personne qui atteint la page peut créer un compte (rôle utilisateur, toutes les applications).', s.signup_open);
  const guest = switchRow('Mode invité', 'Bouton « Continuer en invité » : applications sans stockage, les enregistrements sont téléchargés.', s.guest_enabled);
  const guestApps = appsChooser('guest-apps', s.guest_apps === null, s.guest_apps || []);
  const guestBox = h('div', {}, h('div', { class: 'mut' }, 'Applications ouvertes aux invités :'), guestApps.el);
  const syncGuest = () => { guestBox.hidden = !guest.input.checked; };
  guest.input.onchange = syncGuest; syncGuest();
  const versions = h('input', { type: 'number', min: 1, max: 100, step: 1, value: String(s.max_versions), required: true });
  const quota = h('input', { type: 'number', min: 0, step: 0.5, value: String(+(s.default_quota / GIB).toFixed(2)), required: true });
  const maxSize = h('input', { type: 'number', min: 1, max: 512, step: 1, value: String(Math.round(s.max_file_size / MIB)), required: true });
  const autosave = h('input', { type: 'number', min: 0, max: 3600, step: 5, value: String(s.autosave_seconds), required: true });
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const form = $('settings');
  form.replaceChildren(
    h('div', { class: 'card' }, h('h3', {}, 'Accès'), signup.el, guest.el, guestBox),
    h('div', { class: 'card' }, h('h3', {}, 'Fichiers'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Versions conservées par fichier', versions, h('span', { class: 'hint' }, 'Les plus anciennes sont effacées au prochain enregistrement.')),
        h('label', { class: 'field' }, 'Quota par défaut (Gio)', quota, h('span', { class: 'hint' }, 'Par compte, versions comprises.')),
        h('label', { class: 'field' }, 'Taille max. d\'un fichier (Mio)', maxSize, h('span', { class: 'hint' }, '512 au plus (limite des applications).'))),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Sauvegarde automatique (secondes)', autosave, h('span', { class: 'hint' },
          'Délai après une modification ; 0 = désactivée. Les sauvegardes automatiques successives mettent à jour une seule version ; seuls les « Enregistrer » ajoutent des versions.')))),
    errEl, h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer les réglages')));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const g = guestApps.value();
    try {
      settings = await api('/api/admin/settings', { method: 'PATCH', body: {
        signup_open: signup.input.checked, guest_enabled: guest.input.checked, guest_apps: g.allApps ? null : g.apps,
        max_versions: Number(versions.value), default_quota: Math.round(Number(quota.value) * GIB), max_file_size: Math.round(Number(maxSize.value) * MIB), autosave_seconds: Number(autosave.value) } });
      errEl.textContent = '';
      toast({ title: 'Réglages enregistrés.' });
      await loadUsers();
    } catch (err) { errEl.textContent = err.message; }
  };
}

// ---------- Journal ----------
const ACTIONS = { 'auth.login': 'Connexion', 'auth.logout': 'Déconnexion', 'auth.setup': 'Création du compte admin', 'auth.register': 'Inscription',
  'auth.password': 'Mot de passe changé', 'file.upload': 'Import', 'file.save': 'Enregistrement', 'file.autosave': 'Sauvegarde automatique', 'file.update': 'Fichier modifié',
  'file.delete': 'Fichier supprimé', 'file.restore': 'Version restaurée', 'folder.create': 'Dossier créé', 'folder.update': 'Dossier modifié',
  'folder.delete': 'Dossier supprimé', 'admin.user.create': 'Compte créé', 'admin.user.update': 'Compte modifié',
  'admin.user.delete': 'Compte supprimé', 'admin.settings': 'Réglages modifiés' };
async function loadAudit() {
  try {
    const rows = await api('/api/admin/audit?limit=200');
    $('audit').replaceChildren(...rows.map((r) => h('tr', {},
      h('td', { class: 'mut' }, formatDateTime(r.at)), h('td', {}, r.username ?? '—'), h('td', {}, ACTIONS[r.action] || r.action),
      h('td', { class: 'wrap mut' }, r.target ?? ''), h('td', { class: 'wrap mut' }, r.detail ?? ''), h('td', { class: 'mut' }, r.ip ?? ''))));
  } catch (e) { fail('Journal indisponible')(e); }
}

async function main() {
  me = await api('/api/me');
  syncTheme(me);
  apps = me.apps;
  $('account').replaceWith(accountButton(me));
  $('newUser').onclick = newUser;
  $('refreshAudit').onclick = loadAudit;
  settings = await api('/api/admin/settings');
  renderSettings();
  await loadUsers();
  const tab = location.hash.slice(1);
  selectTab(TABS.includes(tab) ? tab : 'users');
}
main().catch((e) => { if (e.status !== 401) toast({ type: 'error', title: 'Chargement impossible', detail: e.message }); });
