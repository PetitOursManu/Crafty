// Accueil : applications + explorateur de fichiers (dossiers, import, glisser-déposer, clic droit, versions).
import {
  api, h, icon, toast, openMenu, menuAt, closeMenus, dialog, confirmDialog, promptDialog, validName,
  appTile, extOf, extColor, formatSize, formatDate, formatDateTime, accountButton, syncTheme,
} from '/ui.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const state = { me: null, apps: [], folder: null, path: [], folders: [], files: [], selected: null,
  view: localStorage.getItem('craft-view') || 'grid', sort: localStorage.getItem('craft-sort') || 'name', filter: '' };

// ---------- Icônes de type ----------
function svg(markup, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = markup;
  return s;
}
function docIcon(name) {
  const ext = extOf(name).slice(0, 4).toUpperCase();
  const s = svg(`<path class="sheet" d="M8 2h28l14 14v46a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z"/>
    <path class="fold" d="M36 2v10a4 4 0 0 0 4 4h10"/>
    <path class="lines" d="M13 28h28M13 35h28M13 42h20"/>
    ${ext ? `<rect x="4" y="48" width="${Math.max(24, ext.length * 7 + 10)}" height="14" rx="3" fill="${extColor(extOf(name))}"/>
    <text class="label" x="9" y="58.5"></text>` : ''}`, 'doc');
  s.setAttribute('viewBox', '0 0 54 68');
  const t = s.querySelector('text'); if (t) t.textContent = ext;
  return s;
}
function folderIcon() {
  const s = svg('<path class="back" d="M4 10a4 4 0 0 1 4-4h14l6 6h30a4 4 0 0 1 4 4v4H4z"/><rect class="front" x="4" y="16" width="60" height="38" rx="4"/>', 'folder-ic');
  s.setAttribute('viewBox', '0 0 68 58');
  return s;
}

// ---------- Applications ----------
const appBySlug = (s) => state.apps.find((a) => a.slug === s);
// extensions : formats que l'application édite ; imports : formats qu'elle sait seulement ouvrir (conversion).
const appsFor = (name) => state.apps.filter((a) => a.extensions.includes(extOf(name)));
const importersFor = (name) => state.apps.filter((a) => (a.imports || []).includes(extOf(name)) && !a.extensions.includes(extOf(name)));
// Ouvrir = la dernière application utilisée pour ce fichier si elle lit encore ce format, sinon celle qui l'édite.
function defaultApp(file) {
  const last = appBySlug(file.lastApp);
  if (last && (appsFor(file.name).includes(last) || importersFor(file.name).includes(last))) return last;
  return appsFor(file.name)[0] || null;
}
function hostUrl(slug, params) {
  const p = new URLSearchParams({ app: slug, ...params });
  return `/host.html?${p}`;
}
function openFile(file, slug = defaultApp(file)?.slug) {
  if (!slug) return downloadFile(file);
  location.href = hostUrl(slug, { file: file.id });
}
function downloadFile(file, versionId) {
  const a = h('a', { href: `/api/files/${file.id}/content${versionId ? `?version=${versionId}` : ''}`, download: file.name });
  document.body.append(a); a.click(); a.remove();
}
function renderApps() {
  $('apps').replaceChildren(...state.apps.map((a) => h('li', {},
    h('a', { class: 'app-card', href: hostUrl(a.slug, state.me.guest ? {} : { folder: state.folder?.id || '' }) },
      appTile(a), h('div', {}, h('div', { class: 'name' }, a.name), h('div', { class: 'desc' }, a.description))))));
  if (!state.apps.length) $('apps').replaceChildren(h('li', { class: 'mut' }, 'Aucune application ne vous est attribuée. Contactez l\'administrateur.'));
}

// ---------- Chargement d'un dossier ----------
async function load(folderId = state.folder?.id ?? null, { push = false } = {}) {
  const data = await api(`/api/fs?folder=${encodeURIComponent(folderId || 'root')}`);
  Object.assign(state, { folder: data.folder, path: data.path, folders: data.folders, files: data.files });
  if (state.selected && !findItem(state.selected)) state.selected = null;
  renderUsage(data.usage);
  renderCrumbs();
  render();
  const url = data.folder ? `/?folder=${data.folder.id}` : '/';
  if (push) history.pushState({ folder: data.folder?.id ?? null }, '', url);
  else history.replaceState({ folder: data.folder?.id ?? null }, '', url);
  document.title = `${data.folder ? data.folder.name : 'Mes fichiers'} · Craft`;
}
const findItem = (key) => {
  const [kind, id] = key.split(':');
  return kind === 'd' ? state.folders.find((f) => f.id === id) : state.files.find((f) => f.id === id);
};
function renderUsage(u) {
  if (!u) return;
  const ratio = u.quota ? Math.min(1, u.used / u.quota) : 0;
  const bar = h('div', { class: `meter${ratio > .95 ? ' full' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': u.quota, 'aria-valuenow': u.used,
    'aria-label': 'Espace utilisé' }, h('span'));
  bar.firstChild.style.width = `${(ratio * 100).toFixed(1)}%`;
  $('usage').replaceChildren(h('span', {}, `${formatSize(u.used)} sur ${formatSize(u.quota)}`), bar);
  $('usage').hidden = false;
}
function renderCrumbs() {
  const parts = [{ id: null, name: 'Mes fichiers' }, ...state.path];
  const nav = $('crumbs');
  nav.replaceChildren();
  parts.forEach((p, i) => {
    if (i) nav.append(icon('chevron', 'sep'));
    const b = h('button', { type: 'button', 'aria-current': i === parts.length - 1 ? 'location' : null, onclick: () => load(p.id, { push: true }) }, p.name);
    dropTarget(b, p.id);
    nav.append(b);
  });
}

// ---------- Rendu des éléments ----------
function sorted(list, isFolder) {
  const by = state.sort, f = state.filter.toLowerCase();
  const out = list.filter((x) => !f || x.name.toLowerCase().includes(f));
  out.sort((a, b) => by === 'date' ? b.updatedAt - a.updatedAt : by === 'size' && !isFolder ? b.size - a.size
    : a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }));
  return out;
}
function render() {
  const items = $('items');
  items.className = `items ${state.view}`;
  $('listHead').hidden = state.view !== 'list';
  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
  const folders = sorted(state.folders, true), files = sorted(state.files, false);
  items.replaceChildren(...folders.map((f) => itemEl('d', f)), ...files.map((f) => itemEl('f', f)));
  $('empty').hidden = folders.length + files.length > 0;
  if (state.filter && !(folders.length + files.length)) $('empty').querySelector('strong').textContent = 'Aucun résultat dans ce dossier.';
  else $('empty').querySelector('strong').textContent = 'Ce dossier est vide.';
}
function itemEl(kind, x) {
  const key = `${kind}:${x.id}`;
  const isFile = kind === 'f';
  const app = isFile ? defaultApp(x) : null;
  const more = h('button', { type: 'button', class: 'btn icon ghost more', tabindex: -1, 'aria-label': `Actions pour ${x.name}`,
    onclick: (e) => { e.stopPropagation(); select(key); showItemMenu(kind, x, menuAt(more)); } }, icon('more'));
  const el = h('div', { class: 'item', role: 'option', tabindex: 0, 'aria-selected': String(state.selected === key), draggable: 'true',
    dataset: { key }, title: isFile ? `${x.name}\n${formatSize(x.size)} · modifié ${formatDateTime(x.updatedAt)}${app ? `\nOuvrir avec ${app.name}` : ''}` : x.name },
    h('div', { class: 'main' }, h('div', { class: 'thumb' }, isFile ? docIcon(x.name) : folderIcon()),
      h('div', { class: 'name' }, x.name)),
    h('div', { class: 'meta' }, isFile ? `${formatSize(x.size)} · ${formatDate(x.updatedAt)}` : 'Dossier'),
    h('div', { class: 'col date' }, formatDate(x.updatedAt)),
    h('div', { class: 'col' }, isFile ? formatSize(x.size) : '—'),
    more);
  // Grille : pas de .main en ligne
  el.addEventListener('click', (e) => { select(key); el.focus(); e.stopPropagation(); });
  el.addEventListener('dblclick', () => (isFile ? openFile(x) : load(x.id, { push: true })));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); select(key); showItemMenu(kind, x, { x: e.clientX, y: e.clientY }); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); isFile ? openFile(x) : load(x.id, { push: true }); }
    else if (e.key === 'F2') { e.preventDefault(); rename(kind, x); }
    else if (e.key === 'Delete') { e.preventDefault(); remove(kind, x); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); showItemMenu(kind, x, menuAt(el)); }
    else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); moveFocus(el, e.key); }
  });
  el.addEventListener('focus', () => select(key));
  // Glisser un élément sur un dossier = déplacer
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-craft', JSON.stringify({ kind, id: x.id })); e.dataTransfer.effectAllowed = 'move'; });
  if (!isFile) dropTarget(el, x.id);
  return el;
}
function moveFocus(el, key) {
  const all = [...$('items').children];
  const i = all.indexOf(el);
  let step = 1;
  if (state.view === 'grid' && (key === 'ArrowDown' || key === 'ArrowUp')) {
    const top = el.offsetTop; step = all.filter((x) => x.offsetTop === top).length || 1;
  }
  const j = key === 'ArrowRight' || key === 'ArrowDown' ? i + step : i - step;
  all[Math.max(0, Math.min(all.length - 1, j))]?.focus();
}
function select(key) {
  state.selected = key;
  for (const el of $('items').children) el.setAttribute('aria-selected', String(el.dataset.key === key));
}

// ---------- Menus ----------
function showItemMenu(kind, x, at) {
  if (kind === 'd') {
    return openMenu([
      { label: 'Ouvrir', icon: 'open', onClick: () => load(x.id, { push: true }) },
      { separator: true },
      { label: 'Renommer', icon: 'edit', hint: 'F2', onClick: () => rename(kind, x) },
      { label: 'Déplacer vers…', icon: 'move', onClick: () => moveDialog(kind, x) },
      { separator: true },
      { label: 'Supprimer', icon: 'trash', danger: true, hint: 'Suppr', onClick: () => remove(kind, x) },
    ], at);
  }
  const def = defaultApp(x);
  const compatible = appsFor(x.name);
  const importers = importersFor(x.name);
  const withApp = (a) => ({ label: a.name, icon: appTile(a, 'app-tile mini'), onClick: () => openFile(x, a.slug) });
  const ext = extOf(x.name);
  // Seules les applications qui lisent ce format sont proposées (les autres afficheraient une erreur).
  openMenu([
    def ? { label: `Ouvrir dans ${def.name}`, icon: 'open', hint: 'Entrée', onClick: () => openFile(x, def.slug) }
      : { label: `Aucune application n'ouvre les fichiers ${ext ? `.${ext}` : 'sans extension'}`, icon: 'open', disabled: true },
    compatible.length + importers.length ? { label: 'Ouvrir avec', icon: 'grid', submenu: [
      ...compatible.map(withApp),
      importers.length && compatible.length ? { separator: true } : null,
      importers.length ? { heading: 'Convertir avec' } : null,
      ...importers.map(withApp),
    ] } : null,
    { separator: true },
    { label: 'Télécharger', icon: 'download', onClick: () => downloadFile(x) },
    { label: 'Versions…', icon: 'history', hint: `${x.versions ?? 1}`, onClick: () => versionsDialog(x) },
    { label: 'Renommer', icon: 'edit', hint: 'F2', onClick: () => rename(kind, x) },
    { label: 'Déplacer vers…', icon: 'move', onClick: () => moveDialog(kind, x) },
    { separator: true },
    { label: 'Supprimer', icon: 'trash', danger: true, hint: 'Suppr', onClick: () => remove(kind, x) },
  ], at);
}
function showAreaMenu(at) {
  openMenu([
    { label: 'Nouveau dossier', icon: 'folderPlus', onClick: newFolder },
    { label: 'Importer des fichiers…', icon: 'upload', onClick: () => $('upload').click() },
    { separator: true },
    { label: state.view === 'grid' ? 'Affichage en liste' : 'Affichage en grille', icon: state.view === 'grid' ? 'list' : 'grid', onClick: () => setView(state.view === 'grid' ? 'list' : 'grid') },
  ], at);
}

// ---------- Actions ----------
const fail = (title) => (e) => toast({ type: 'error', title, detail: e.message });
async function newFolder() {
  const name = await promptDialog({ title: 'Nouveau dossier', label: 'Nom du dossier', value: 'Nouveau dossier', confirm: 'Créer', validate: validName });
  if (!name) return;
  try { const f = await api('/api/folders', { method: 'POST', body: { parentId: state.folder?.id ?? null, name } }); await load(); select(`d:${f.id}`); }
  catch (e) { fail('Impossible de créer le dossier')(e); }
}
async function rename(kind, x) {
  const name = await promptDialog({ title: kind === 'd' ? 'Renommer le dossier' : 'Renommer le fichier', label: 'Nouveau nom', value: x.name,
    confirm: 'Renommer', selectBase: kind === 'f', validate: validName });
  if (!name || name === x.name) return;
  if (kind === 'f' && extOf(name) !== extOf(x.name) && !(await confirmDialog({ title: 'Changer l\'extension ?',
    message: `« .${extOf(x.name)} » deviendra « .${extOf(name) || 'aucune'} ». Le fichier risque de ne plus s'ouvrir dans la bonne application.`, confirm: 'Changer' }))) return;
  try { await api(`/api/${kind === 'd' ? 'folders' : 'files'}/${x.id}`, { method: 'PATCH', body: { name } }); await load(); }
  catch (e) { fail('Impossible de renommer')(e); }
}
async function remove(kind, x) {
  const ok = await confirmDialog({ title: kind === 'd' ? 'Supprimer le dossier ?' : 'Supprimer le fichier ?',
    message: kind === 'd' ? `« ${x.name} » et tout son contenu (fichiers, sous-dossiers, versions) seront supprimés définitivement.`
      : `« ${x.name} » et ses ${x.versions ?? 1} version(s) seront supprimés définitivement.`, confirm: 'Supprimer', danger: true });
  if (!ok) return;
  try { await api(`/api/${kind === 'd' ? 'folders' : 'files'}/${x.id}`, { method: 'DELETE' }); state.selected = null; await load(); toast({ title: `« ${x.name} » supprimé.` }); }
  catch (e) { fail('Impossible de supprimer')(e); }
}
async function move(kind, id, targetId) {
  try {
    await api(`/api/${kind === 'd' ? 'folders' : 'files'}/${id}`, { method: 'PATCH', body: kind === 'd' ? { parentId: targetId } : { folderId: targetId } });
    await load();
  } catch (e) { fail('Impossible de déplacer')(e); }
}
function moveDialog(kind, x) {
  let cur = null;
  const list = h('ul', { class: 'picker-list' });
  const where = h('div', { class: 'mut' });
  const go = async (id) => {
    const d = await api(`/api/fs?folder=${encodeURIComponent(id || 'root')}`);
    cur = d.folder?.id ?? null;
    where.textContent = ['Mes fichiers', ...d.path.map((p) => p.name)].join(' › ');
    const up = d.path.length ? d.path[d.path.length - 2]?.id ?? null : undefined;
    list.replaceChildren(
      up !== undefined ? h('li', {}, h('button', { type: 'button', onclick: () => go(up) }, icon('back'), 'Dossier parent')) : null,
      ...d.folders.map((f) => h('li', {}, h('button', { type: 'button', disabled: kind === 'd' && f.id === x.id, onclick: () => go(f.id) }, folderIcon(), f.name))));
    if (!list.children.length) list.append(h('li', { class: 'mut' }, 'Aucun sous-dossier.'));
  };
  dialog({ title: `Déplacer « ${x.name} »`, body: h('div', { class: 'picker' }, where, list),
    actions: [h('button', { class: 'btn', value: 'cancel' }, 'Annuler'), h('button', { class: 'btn primary', value: 'ok' }, 'Déplacer ici')],
    onClose: (v) => { if (v === 'ok') move(kind, x.id, cur); } });
  go(state.folder?.id ?? null);
}
async function versionsDialog(file) {
  const list = h('ul', { class: 'versions' }, h('li', { class: 'mut' }, 'Chargement…'));
  const dlg = dialog({ title: `Versions de « ${file.name} »`, wide: true,
    body: h('div', {}, h('p', { class: 'mut' }, 'Chaque enregistrement crée une version. Les plus anciennes sont effacées au-delà de la limite fixée par l\'administrateur.'), list),
    actions: [h('button', { class: 'btn', value: 'close' }, 'Fermer')] });
  const fill = async () => {
    const vs = await api(`/api/files/${file.id}/versions`);
    list.replaceChildren(...vs.map((v) => h('li', {},
      h('div', { class: 'v-main' }, h('strong', {}, `Version ${v.n} `, v.current ? h('span', { class: 'badge accent' }, 'actuelle') : null, ' ',
          v.auto ? h('span', { class: 'badge', title: 'Sauvegarde automatique, mise à jour jusqu\'au prochain « Enregistrer »' }, 'auto') : null),
        h('span', { class: 'v-meta' }, `${formatDateTime(v.createdAt)} · ${formatSize(v.size)}${v.app ? ` · ${appBySlug(v.app)?.name || v.app}` : ''}`)),
      h('button', { class: 'btn sm', type: 'button', onclick: () => downloadFile(file, v.id) }, icon('download'), 'Télécharger'),
      v.current ? null : h('button', { class: 'btn sm', type: 'button', onclick: async () => {
        try { await api(`/api/files/${file.id}/versions/${v.id}/restore`, { method: 'POST' }); toast({ title: `Version ${v.n} restaurée`, detail: 'Elle devient la version actuelle ; l\'historique est conservé.' }); await fill(); await load(); }
        catch (e) { fail('Restauration impossible')(e); }
      } }, icon('history'), 'Restaurer'))));
  };
  fill().catch((e) => { list.replaceChildren(h('li', { class: 'error-text' }, e.message)); });
  return dlg;
}

// ---------- Import (bouton et glisser-déposer) ----------
function uploadOne(file, folderId, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/files?folder=${encodeURIComponent(folderId || 'root')}`);
    x.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { let d = null; try { d = JSON.parse(x.responseText); } catch {}
      x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error(d?.error || `Erreur ${x.status}`)); };
    x.onerror = () => reject(new Error('Serveur injoignable.'));
    x.send(file);
  });
}
async function upload(fileList, folderId = state.folder?.id ?? null) {
  const files = [...fileList].filter((f) => f.size > 0 || f.type);
  if (!files.length) return;
  const t = toast({ title: `Import de ${files.length} fichier${files.length > 1 ? 's' : ''}…`, detail: '', progress: 0, timeout: 0, closable: false });
  let ok = 0;
  const errors = [];
  for (const [i, f] of files.entries()) {
    t.update({ detail: `${i + 1}/${files.length} · ${f.name}` });
    try { await uploadOne(f, folderId, (p) => t.update({ progress: (i + p) / files.length })); ok++; }
    catch (e) { errors.push(`${f.name} : ${e.message}`); }
  }
  t.close();
  if (ok) toast({ title: `${ok} fichier${ok > 1 ? 's' : ''} importé${ok > 1 ? 's' : ''}.` });
  for (const e of errors) toast({ type: 'error', title: 'Import impossible', detail: e });
  await load();
}
function dropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    const t = e.dataTransfer.types;
    if (!t.includes('Files') && !t.includes('application/x-craft')) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = t.includes('Files') ? 'copy' : 'move';
    el.classList.add('drop-target');
    if (t.includes('Files')) showDropHint(folderId);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop-target'); endDrag();
    if (e.dataTransfer.files.length) return upload(e.dataTransfer.files, folderId);
    const d = e.dataTransfer.getData('application/x-craft');
    if (d) { const { kind, id } = JSON.parse(d); if (!(kind === 'd' && id === folderId)) move(kind, id, folderId); }
  });
}
function showDropHint(folderId) {
  const name = folderId === (state.folder?.id ?? null) ? (state.folder?.name || 'Mes fichiers')
    : state.folders.find((f) => f.id === folderId)?.name || [{ id: null, name: 'Mes fichiers' }, ...state.path].find((p) => p.id === folderId)?.name;
  $('dropHint').textContent = `Déposer dans « ${name} »`;
  $('dropHint').hidden = false;
}
let dragDepth = 0;
function endDrag() { dragDepth = 0; $('area').classList.remove('dragging'); $('dropHint').hidden = true; }

// ---------- Réglages d'affichage ----------
function setView(v) { state.view = v; try { localStorage.setItem('craft-view', v); } catch {} render(); }

// ---------- Démarrage ----------
async function main() {
  state.me = await api('/api/me');
  syncTheme(state.me);
  state.apps = state.me.apps;
  $('account').replaceWith(accountButton(state.me));
  renderApps();
  if (state.me.guest) {
    $('filesSection').hidden = true; $('searchBox').hidden = true; $('guestSection').hidden = false;
    $('appsHint').textContent = 'Ouvrez une application, puis un fichier de votre ordinateur';
    return;
  }
  $('viewGrid').append(icon('grid')); $('viewList').append(icon('list'));
  $('newFolder').append(icon('folderPlus'), 'Nouveau dossier');
  $('uploadBtn').prepend(icon('upload'), 'Importer');
  $('viewGrid').onclick = () => setView('grid');
  $('viewList').onclick = () => setView('list');
  $('sort').value = state.sort;
  $('sort').onchange = () => { state.sort = $('sort').value; try { localStorage.setItem('craft-sort', state.sort); } catch {} render(); };
  $('newFolder').onclick = newFolder;
  $('upload').onchange = (e) => { upload(e.target.files); e.target.value = ''; };
  $('search').oninput = () => { state.filter = $('search').value.trim(); render(); };
  $('area').addEventListener('contextmenu', (e) => { e.preventDefault(); showAreaMenu({ x: e.clientX, y: e.clientY }); });
  $('area').addEventListener('click', () => { state.selected = null; select(null); closeMenus(); });
  // Fichiers venus de l'ordinateur : surbrillance de toute la zone, dépôt dans le dossier courant.
  const area = $('area');
  area.addEventListener('dragenter', (e) => { if (!e.dataTransfer.types.includes('Files')) return; dragDepth++; area.classList.add('dragging'); showDropHint(state.folder?.id ?? null); });
  area.addEventListener('dragleave', () => { if (--dragDepth <= 0) endDrag(); });
  area.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); showDropHint(state.folder?.id ?? null); } });
  area.addEventListener('drop', (e) => { e.preventDefault(); endDrag(); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); });
  window.addEventListener('dragend', endDrag);
  window.addEventListener('popstate', (e) => load(e.state?.folder ?? null));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, dialog, .menu')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); }
    if (e.key === 'Backspace' && state.path.length) { e.preventDefault(); load(state.path[state.path.length - 2]?.id ?? null, { push: true }); }
  });
  await load(new URLSearchParams(location.search).get('folder'));
}
main().catch((e) => { if (e.status !== 401) toast({ type: 'error', title: 'Chargement impossible', detail: e.message }); });
