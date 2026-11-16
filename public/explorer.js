// Accueil : applications + explorateur de fichiers (dossiers, import, glisser-déposer, clic droit, versions).
import {
  api, h, icon, toast, openMenu, menuAt, closeMenus, dialog, confirmDialog, promptDialog, validName,
  appTile, extOf, extColor, formatSize, formatDate, formatDateTime, accountButton, syncTheme,
} from '/ui.js';
import { t, locale, translateDom } from '/i18n.js';
import { mountAgent } from '/agent.js';
import { explorerTools } from '/explorer-agent.js';
import { quickAccess, trashView, wantThumb, thumbUrl, shareDialog } from '/explorer-more.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
// sel : clés sélectionnées (« d:<id> » dossier, « f:<id> » fichier) ; anchor : point de départ de Maj+clic ;
// checkMode : sélection faite par cases à cocher (la barre d'actions s'affiche dès un élément).
const state = { me: null, apps: [], folder: null, path: [], folders: [], files: [], sel: new Set(), anchor: null, checkMode: false,
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
  const label = s.querySelector('text'); if (label) label.textContent = ext;
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
// « * » dans imports : tout fichier (Craft Anything, qui analyse n'importe quel fichier).
const importersFor = (name) => state.apps.filter((a) => ((a.imports || []).includes(extOf(name)) || (a.imports || []).includes('*')) && !a.extensions.includes(extOf(name)));
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
      appTile(a), h('div', {}, h('div', { class: 'name' }, a.name), h('div', { class: 'desc' }, t(a.description)))))));
  if (!state.apps.length) $('apps').replaceChildren(h('li', { class: 'mut' }, t('Aucune application ne vous est attribuée. Contactez l\'administrateur.')));
}

// ---------- Chargement d'un dossier ----------
let quick = null, trash = null, quickTimer = null;
async function load(folderId = state.folder?.id ?? null, { push = false } = {}) {
  const data = await api(`/api/fs?folder=${encodeURIComponent(folderId || 'root')}`);
  Object.assign(state, { folder: data.folder, path: data.path, folders: data.folders, files: data.files, trash: data.trash, inTrash: false });
  $('filesSection').classList.remove('in-trash');
  renderTrashBtn();
  for (const k of state.sel) if (!findItem(k)) state.sel.delete(k);
  if (state.anchor && !findItem(state.anchor)) state.anchor = null;
  renderUsage(data.usage);
  renderCrumbs();
  render();
  const url = data.folder ? `/?folder=${data.folder.id}` : '/';
  if (push) history.pushState({ folder: data.folder?.id ?? null }, '', url);
  else history.replaceState({ folder: data.folder?.id ?? null }, '', url);
  document.title = `${data.folder ? data.folder.name : t('Mes fichiers')} · Crafty`;
}
const findItem = (key) => {
  const [kind, id] = key.split(':');
  return kind === 'd' ? state.folders.find((f) => f.id === id) : state.files.find((f) => f.id === id);
};
function renderUsage(u) {
  if (!u) return;
  const ratio = u.quota ? Math.min(1, u.used / u.quota) : 0;
  const bar = h('div', { class: `meter${ratio > .95 ? ' full' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': u.quota, 'aria-valuenow': u.used,
    'aria-label': t('Espace utilisé') }, h('span'));
  bar.firstChild.style.width = `${(ratio * 100).toFixed(1)}%`;
  $('usage').replaceChildren(h('span', {}, t('{used} sur {quota}', { used: formatSize(u.used), quota: formatSize(u.quota) })), bar);
  $('usage').hidden = false;
}
function renderTrashBtn() {
  const tr = state.trash || { days: 0, count: 0 };
  $('trashBtn').hidden = !tr.days && !tr.count;
  $('trashBtn').replaceChildren(icon('trash'), h('span', {}, t('Corbeille')), tr.count ? h('span', { class: 'count' }, String(tr.count)) : '');
  $('trashBtn').setAttribute('aria-pressed', String(!!state.inTrash));
}
// Corbeille : à la place du dossier (URL /?trash=1).
async function showTrash({ push = false } = {}) {
  state.inTrash = true; state.sel = new Set(); paintSelection();
  $('filesSection').classList.add('in-trash');
  const nav = $('crumbs');
  nav.replaceChildren(h('button', { type: 'button', onclick: () => load(null, { push: true }) }, t('Mes fichiers')), icon('chevron', 'sep'),
    h('button', { type: 'button', 'aria-current': 'location' }, t('Corbeille')));
  $('listHead').hidden = true;
  renderTrashBtn();
  if (push) history.pushState({ trash: true }, '', '/?trash=1'); else history.replaceState({ trash: true }, '', '/?trash=1');
  document.title = `${t('Corbeille')} · Crafty`;
  await trash.render();
}
function renderCrumbs() {
  const parts = [{ id: null, name: t('Mes fichiers') }, ...state.path];
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
    : a.name.localeCompare(b.name, locale, { numeric: true, sensitivity: 'base' }));
  return out;
}
function render() {
  $('lassoHint').hidden = true;
  if (state.inTrash) return trash.render();
  const items = $('items');
  items.className = `items ${state.view}`;
  $('listHead').hidden = state.view !== 'list';
  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
  const folders = sorted(state.folders, true), files = sorted(state.files, false);
  items.replaceChildren(...folders.map((f) => itemEl('d', f)), ...files.map((f) => itemEl('f', f)));
  paintSelection();
  $('empty').hidden = folders.length + files.length > 0;
  let lassoKnown = false;
  try { lassoKnown = !!localStorage.getItem('craft-lasso-known'); } catch {}
  $('lassoHint').hidden = lassoKnown || folders.length + files.length < 2;
  if (state.filter && !(folders.length + files.length)) $('empty').querySelector('strong').textContent = t('Aucun résultat dans ce dossier.');
  else $('empty').querySelector('strong').textContent = t('Ce dossier est vide.');
  $('empty').querySelector('.mut').textContent = t('Glissez des fichiers ici, ou utilisez « Importer ».'); // la corbeille le remplace
}
function itemEl(kind, x) {
  const key = `${kind}:${x.id}`;
  const isFile = kind === 'f';
  const app = isFile ? defaultApp(x) : null;
  const more = h('button', { type: 'button', class: 'btn icon ghost more', tabindex: -1, 'aria-label': t('Actions pour {name}', { name: x.name }),
    onclick: (e) => { e.stopPropagation(); contextFor(key, kind, x, menuAt(more)); } }, icon('more'));
  // Case à cocher : ajoute ou retire l'élément sans toucher au reste de la sélection.
  const check = h('span', { class: 'check', role: 'checkbox', 'aria-checked': String(state.sel.has(key)), 'aria-label': t('Sélectionner {name}', { name: x.name }),
    title: t('Sélectionner'), onclick: (e) => { e.stopPropagation(); state.checkMode = true; toggle(key); el.focus({ preventScroll: true }); } }, icon('check'));
  check.addEventListener('dblclick', (e) => e.stopPropagation());
  const el = h('div', { class: 'item', role: 'option', tabindex: 0, 'aria-selected': String(state.sel.has(key)), draggable: 'true',
    dataset: { key }, title: isFile ? `${x.name}\n${t('{size} · modifié {date}', { size: formatSize(x.size), date: formatDateTime(x.updatedAt) })}${app ? `\n${t('Ouvrir avec {app}', { app: app.name })}` : ''}` : x.name },
    check,
    h('div', { class: 'main' }, h('div', { class: `thumb${isFile && x.thumb ? ' has-img' : ''}` }, isFile && x.thumb ? h('img', { src: thumbUrl(x), alt: '', loading: 'lazy', draggable: 'false' }) : isFile ? docIcon(x.name) : folderIcon(),
        x.favorite ? h('span', { class: 'fav', title: t('Favori'), 'aria-label': t('Favori') }, '★') : null),
      h('div', { class: 'name' }, x.name)),
    h('div', { class: 'meta' }, isFile ? `${formatSize(x.size)} · ${formatDate(x.updatedAt)}` : t('Dossier')),
    h('div', { class: 'col date' }, formatDate(x.updatedAt)),
    h('div', { class: 'col' }, isFile ? formatSize(x.size) : '—'),
    more);
  // Grille : pas de .main en ligne
  // Clic : cet élément seul ; Ctrl+clic : ajouter ou retirer ; Maj+clic : plage depuis le dernier élément cliqué.
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) toggle(key);
    else if (e.shiftKey && state.anchor) selectRange(state.anchor, key, e.ctrlKey || e.metaKey);
    else selectOnly(key);
    el.focus({ preventScroll: true });
  });
  el.addEventListener('dblclick', (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; isFile ? openFile(x) : load(x.id, { push: true }); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); contextFor(key, kind, x, { x: e.clientX, y: e.clientY }); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); isFile ? openFile(x) : load(x.id, { push: true }); }
    else if (e.key === 'F2') { e.preventDefault(); rename(kind, x); }
    else if (e.key === 'Delete') { e.preventDefault(); state.sel.size > 1 && state.sel.has(key) ? removeMany(selectedItems()) : remove(kind, x); }
    else if (e.key === ' ') { e.preventDefault(); state.checkMode = true; toggle(key); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); contextFor(key, kind, x, menuAt(el)); }
    else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); moveFocus(el, e.key, e.shiftKey); }
  });
  // Glisser un élément sur un dossier = déplacer (toute la sélection si l'élément en fait partie).
  el.addEventListener('dragstart', (e) => {
    if (!state.sel.has(key)) selectOnly(key);
    const list = selectedItems().map(({ kind: k, x: it }) => ({ kind: k, id: it.id }));
    e.dataTransfer.setData('application/x-craft', JSON.stringify(list));
    e.dataTransfer.effectAllowed = 'move';
    if (list.length > 1) {
      const ghost = h('div', { class: 'drag-count' }, t('{n} éléments', { n: list.length }));
      document.body.append(ghost); e.dataTransfer.setDragImage(ghost, 10, 10); setTimeout(() => ghost.remove());
    }
  });
  if (!isFile) dropTarget(el, x.id);
  // Miniature d'une image, faite quand l'élément devient visible.
  if (isFile && !x.thumb) wantThumb(el, x, (v) => { x.thumb = v; clearTimeout(quickTimer); quickTimer = setTimeout(() => quick?.refresh(), 800); const th = el.querySelector('.thumb'); th.classList.add('has-img'); th.firstChild.replaceWith(h('img', { src: thumbUrl(x), alt: '', loading: 'lazy', draggable: 'false' })); });
  return el;
}
async function toggleFavorite(kind, x) {
  try {
    await api('/api/favorites', { method: 'PUT', body: { type: kind === 'd' ? 'folder' : 'file', id: x.id, on: !x.favorite } });
    x.favorite = !x.favorite; render(); quick?.refresh();
  } catch (e) { fail(t('Favori non enregistré'))(e); }
}
function moveFocus(el, key, extend = false) {
  const all = [...$('items').children];
  const i = all.indexOf(el);
  let step = 1;
  if (state.view === 'grid' && (key === 'ArrowDown' || key === 'ArrowUp')) {
    const top = el.offsetTop; step = all.filter((x) => x.offsetTop === top).length || 1;
  }
  const j = key === 'ArrowRight' || key === 'ArrowDown' ? i + step : i - step;
  const next = all[Math.max(0, Math.min(all.length - 1, j))];
  if (!next) return;
  next.focus();
  if (extend && state.anchor) selectRange(state.anchor, next.dataset.key); else selectOnly(next.dataset.key);
}

// ---------- Sélection ----------
const orderedKeys = () => [...$('items').children].map((el) => el.dataset.key);
function selectedItems() {
  return orderedKeys().filter((k) => state.sel.has(k)).map((k) => ({ key: k, kind: k[0], x: findItem(k) })).filter((s) => s.x);
}
function selectOnly(key) { state.sel = new Set(key ? [key] : []); state.anchor = key; state.checkMode = false; paintSelection(); }
function toggle(key) { state.sel.has(key) ? state.sel.delete(key) : state.sel.add(key); state.anchor = key; paintSelection(); }
function selectRange(from, to, add = false) {
  const keys = orderedKeys(), a = keys.indexOf(from), b = keys.indexOf(to);
  if (a < 0 || b < 0) return selectOnly(to);
  if (!add) state.sel = new Set();
  for (const k of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) state.sel.add(k);
  paintSelection();
}
function selectAll() { state.sel = new Set(orderedKeys()); paintSelection(); }
function clearSelection() { state.sel = new Set(); state.anchor = null; state.checkMode = false; paintSelection(); }
// Met à jour l'affichage (éléments, cases, case « tout », barre d'actions) sans tout redessiner.
function paintSelection() {
  const n = state.sel.size;
  if (!n) state.checkMode = false;
  for (const el of $('items').children) {
    const on = state.sel.has(el.dataset.key);
    el.setAttribute('aria-selected', String(on));
    el.querySelector('.check')?.setAttribute('aria-checked', String(on));
  }
  $('items').classList.toggle('selecting', n > 0);
  const total = $('items').children.length;
  const all = $('selectAll');
  if (all) all.setAttribute('aria-checked', !n ? 'false' : n === total ? 'true' : 'mixed');
  const bar = $('selBar');
  const show = n > 1 || (n === 1 && state.checkMode);
  bar.hidden = !show;
  if (!show) return;
  const items = selectedItems(), files = items.filter((s) => s.kind === 'f');
  $('selCount').textContent = n > 1 ? t('{n} éléments sélectionnés', { n }) : t('{n} élément sélectionné', { n });
  $('selDownload').disabled = !files.length;
  $('selDownload').title = files.length ? `${files.length > 1 ? t('Télécharger {n} fichiers', { n: files.length }) : t('Télécharger {n} fichier', { n: files.length })}${files.length < n ? ` ${t('(les dossiers sont ignorés)')}` : ''}` : t('Aucun fichier dans la sélection');
}
// Menu contextuel : celui de l'élément, ou celui de la sélection si l'élément en fait partie avec d'autres.
function contextFor(key, kind, x, at) {
  if (state.sel.has(key) && state.sel.size > 1) return showSelectionMenu(at);
  selectOnly(key);
  showItemMenu(kind, x, at);
}
function showSelectionMenu(at) {
  const items = selectedItems(), files = items.filter((s) => s.kind === 'f');
  openMenu([
    { heading: t('{n} éléments', { n: items.length }) },
    { label: t('Télécharger'), icon: 'download', hint: files.length < items.length ? (files.length > 1 ? t('{n} fichiers', { n: files.length }) : t('{n} fichier', { n: files.length })) : null,
      disabled: !files.length, onClick: () => downloadMany(files) },
    { label: t('Déplacer vers…'), icon: 'move', onClick: () => moveDialog(items) },
    { separator: true },
    { label: t('Supprimer'), icon: 'trash', danger: true, hint: t('Suppr'), onClick: () => removeMany(items) },
  ], at);
}

// Sélection au lasso (comme sur le bureau) : glisser depuis n'importe quel endroit vide de la page (marges, sous les
// fichiers, entre les cartes), pas seulement depuis la zone des fichiers. Ctrl ou Maj : ajoute à la sélection.
const NOT_EMPTY = '.item, button, input, select, textarea, a, label, [role=tab], .list-head, .app-card, .q-card, dialog, .sel-bar, .menu, #toasts, aside.agent, .guest, .topbar, .quick';
const isEmptySpot = (t) => !t.closest(NOT_EMPTY);
function installLasso(area) {
  let drag = null, justDragged = false;
  const pageRect = (a, b) => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) });
  const update = () => {
    const r = pageRect(drag.start, drag.cur);
    Object.assign(drag.box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
    state.sel = new Set(drag.base);
    for (const el of $('items').children) {
      const b = el.getBoundingClientRect();
      const hit = b.left + scrollX < r.right && b.right + scrollX > r.left && b.top + scrollY < r.bottom && b.bottom + scrollY > r.top;
      if (hit) state.sel.add(el.dataset.key);
    }
    paintSelection();
  };
  // Défilement automatique près des bords de la fenêtre pendant le lasso.
  const autoscroll = () => {
    if (!drag) return;
    const y = drag.clientY, edge = 40;
    const dy = y < edge ? -12 : y > innerHeight - edge ? 12 : 0;
    if (dy && drag.active) { scrollBy(0, dy); drag.cur = { x: drag.clientX + scrollX, y: drag.clientY + scrollY }; update(); }
    drag.raf = requestAnimationFrame(autoscroll);
  };
  area.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || !isEmptySpot(e.target) || !$('items').children.length) return;
    const start = { x: e.clientX + scrollX, y: e.clientY + scrollY };
    drag = { start, cur: start, clientX: e.clientX, clientY: e.clientY, active: false, box: null,
      base: e.ctrlKey || e.metaKey || e.shiftKey ? new Set(state.sel) : new Set() };
    area.setPointerCapture(e.pointerId);
    drag.raf = requestAnimationFrame(autoscroll);
  });
  area.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.clientX = e.clientX; drag.clientY = e.clientY;
    drag.cur = { x: e.clientX + scrollX, y: e.clientY + scrollY };
    if (!drag.active) {
      if (Math.hypot(drag.cur.x - drag.start.x, drag.cur.y - drag.start.y) < 5) return;
      drag.active = true;
      drag.box = h('div', { class: 'lasso' });
      document.body.append(drag.box);
      document.body.classList.add('lassoing');
      closeMenus();
      try { localStorage.setItem('craft-lasso-known', '1'); } catch {}
      $('lassoHint').hidden = true;
    }
    e.preventDefault();
    update();
  });
  const end = () => {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    if (drag.active) {
      drag.box.remove(); document.body.classList.remove('lassoing'); justDragged = true; setTimeout(() => { justDragged = false; });
      if (state.sel.size) state.anchor = selectedItems().at(-1)?.key ?? null;
    }
    drag = null;
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
  return () => justDragged; // vrai juste après un lasso : le clic qui suit ne doit pas tout désélectionner
}

// ---------- Menus ----------
function showItemMenu(kind, x, at) {
  if (kind === 'd') {
    return openMenu([
      { label: t('Ouvrir'), icon: 'open', onClick: () => load(x.id, { push: true }) },
      { label: x.favorite ? t('Retirer des favoris') : t('Ajouter aux favoris'), icon: 'star', onClick: () => toggleFavorite(kind, x) },
      { separator: true },
      { label: t('Renommer'), icon: 'edit', hint: 'F2', onClick: () => rename(kind, x) },
      { label: t('Déplacer vers…'), icon: 'move', onClick: () => moveDialog([{ kind, x }]) },
      { separator: true },
      { label: t('Supprimer'), icon: 'trash', danger: true, hint: t('Suppr'), onClick: () => remove(kind, x) },
    ], at);
  }
  const def = defaultApp(x);
  const compatible = appsFor(x.name);
  const importers = importersFor(x.name);
  const withApp = (a) => ({ label: a.name, icon: appTile(a, 'app-tile mini'), onClick: () => openFile(x, a.slug) });
  const ext = extOf(x.name);
  // Seules les applications qui lisent ce format sont proposées (les autres afficheraient une erreur).
  openMenu([
    def ? { label: t('Ouvrir dans {app}', { app: def.name }), icon: 'open', hint: t('Entrée'), onClick: () => openFile(x, def.slug) }
      : { label: ext ? t('Aucune application n\'ouvre les fichiers .{ext}', { ext }) : t('Aucune application n\'ouvre les fichiers sans extension'), icon: 'open', disabled: true },
    compatible.length + importers.length ? { label: t('Ouvrir avec'), icon: 'grid', submenu: [
      ...compatible.map(withApp),
      importers.length && compatible.length ? { separator: true } : null,
      importers.length ? { heading: t('Convertir avec') } : null,
      ...importers.map(withApp),
    ] } : null,
    { separator: true },
    { label: t('Télécharger'), icon: 'download', onClick: () => downloadFile(x) },
    { label: t('Partager…'), icon: 'share', onClick: () => shareDialog(x) },
    { label: x.favorite ? t('Retirer des favoris') : t('Ajouter aux favoris'), icon: 'star', onClick: () => toggleFavorite(kind, x) },
    { label: t('Versions…'), icon: 'history', hint: `${x.versions ?? 1}`, onClick: () => versionsDialog(x) },
    { label: t('Renommer'), icon: 'edit', hint: 'F2', onClick: () => rename(kind, x) },
    { label: t('Déplacer vers…'), icon: 'move', onClick: () => moveDialog([{ kind, x }]) },
    { separator: true },
    { label: t('Supprimer'), icon: 'trash', danger: true, hint: t('Suppr'), onClick: () => remove(kind, x) },
  ], at);
}
function showAreaMenu(at) {
  openMenu([
    { label: t('Nouveau dossier'), icon: 'folderPlus', onClick: newFolder },
    { label: t('Importer des fichiers…'), icon: 'upload', onClick: () => $('upload').click() },
    { separator: true },
    { label: state.view === 'grid' ? t('Affichage en liste') : t('Affichage en grille'), icon: state.view === 'grid' ? 'list' : 'grid', onClick: () => setView(state.view === 'grid' ? 'list' : 'grid') },
  ], at);
}

// ---------- Actions ----------
const fail = (title) => (e) => toast({ type: 'error', title, detail: e.message });
async function newFolder() {
  const name = await promptDialog({ title: t('Nouveau dossier'), label: t('Nom du dossier'), value: t('Nouveau dossier'), confirm: t('Créer'), validate: validName });
  if (!name) return;
  try { const f = await api('/api/folders', { method: 'POST', body: { parentId: state.folder?.id ?? null, name } }); await load(); selectOnly(`d:${f.id}`); }
  catch (e) { fail(t('Impossible de créer le dossier'))(e); }
}
async function rename(kind, x) {
  const name = await promptDialog({ title: kind === 'd' ? t('Renommer le dossier') : t('Renommer le fichier'), label: t('Nouveau nom'), value: x.name,
    confirm: t('Renommer'), selectBase: kind === 'f', validate: validName });
  if (!name || name === x.name) return;
  if (kind === 'f' && extOf(name) !== extOf(x.name) && !(await confirmDialog({ title: t('Changer l\'extension ?'),
    message: t('« .{old} » deviendra « .{next} ». Le fichier risque de ne plus s\'ouvrir dans la bonne application.', { old: extOf(x.name), next: extOf(name) || t('aucune') }), confirm: t('Changer') }))) return;
  try { await api(`/api/${kind === 'd' ? 'folders' : 'files'}/${x.id}`, { method: 'PATCH', body: { name } }); await load(); }
  catch (e) { fail(t('Impossible de renommer'))(e); }
}
const remove = (kind, x) => deleteItems([{ kind, x }]);
// Supprimer : vers la corbeille (sans confirmation, avec « Annuler ») ; corbeille désactivée par l'admin : définitif, confirmé.
async function deleteItems(items) {
  const toTrash = (state.trash?.days ?? 0) > 0;
  if (!toTrash) {
    const folders = items.filter((s) => s.kind === 'd').length, one = items[0];
    const ok = await confirmDialog({ title: items.length > 1 ? t('Supprimer {n} éléments ?', { n: items.length }) : one.kind === 'd' ? t('Supprimer le dossier ?') : t('Supprimer le fichier ?'),
      message: items.length > 1 ? (!folders ? t('{n} éléments seront supprimés définitivement, versions comprises.', { n: items.length })
        : folders > 1 ? t('{n} éléments, dont {f} dossiers avec tout leur contenu, seront supprimés définitivement, versions comprises.', { n: items.length, f: folders })
          : t('{n} éléments, dont {f} dossier avec tout leur contenu, seront supprimés définitivement, versions comprises.', { n: items.length, f: folders }))
        : one.kind === 'd' ? t('« {name} » et tout son contenu (fichiers, sous-dossiers, versions) seront supprimés définitivement.', { name: one.x.name })
          : t('« {name} » et ses {n} version(s) seront supprimés définitivement.', { name: one.x.name, n: one.x.versions ?? 1 }), confirm: t('Supprimer'), danger: true });
    if (!ok) return;
  }
  const errors = [], done = [];
  for (const { kind, x } of items) {
    try { await api(`/api/${kind === 'd' ? 'folders' : 'files'}/${x.id}`, { method: 'DELETE' }); done.push({ type: kind === 'd' ? 'folder' : 'file', id: x.id, name: x.name }); state.sel.delete(`${kind}:${x.id}`); }
    catch (e) { if (e.status !== 404) errors.push(t('{name} : {error}', { name: x.name, error: e.message })); } // 404 : déjà parti avec un dossier supprimé
  }
  await load();
  quick?.refresh();
  if (done.length) {
    const one = done.length === 1, vars = { name: done[0].name, n: done.length };
    toast(toTrash ? { title: one ? t('« {name} » placé dans la corbeille.', vars) : t('{n} éléments placés dans la corbeille.', vars), timeout: 8000,
      actions: [{ label: t('Annuler'), onClick: async () => { try { await api('/api/trash/restore', { method: 'POST', body: { items: done } }); await load(); quick?.refresh(); } catch (e) { fail(t('Impossible de restaurer'))(e); } } }] }
      : { title: one ? t('« {name} » supprimé.', vars) : t('{n} éléments supprimés.', vars) });
  }
  for (const e of errors) toast({ type: 'error', title: t('Impossible de supprimer'), detail: e });
}
// Déplace une liste [{ kind, id, name? }] ; un dossier n'est jamais déplacé dans lui-même ; erreurs regroupées.
async function moveItems(list, targetId) {
  const todo = list.filter((it) => !(it.kind === 'd' && it.id === targetId));
  const errors = [];
  for (const it of todo) {
    try { await api(`/api/${it.kind === 'd' ? 'folders' : 'files'}/${it.id}`, { method: 'PATCH', body: it.kind === 'd' ? { parentId: targetId } : { folderId: targetId } }); }
    catch (e) { errors.push(t('{name} : {error}', { name: it.name || findItem(`${it.kind}:${it.id}`)?.name || it.id, error: e.message })); }
  }
  await load();
  if (todo.length > 1 && todo.length > errors.length) { const n = todo.length - errors.length; toast({ title: n > 1 ? t('{n} éléments déplacés.', { n }) : t('{n} élément déplacé.', { n }) }); }
  for (const e of errors) toast({ type: 'error', title: t('Impossible de déplacer'), detail: e });
}
const removeMany = (items) => deleteItems(items);
async function downloadMany(files) {
  for (const [i, { x }] of files.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 400)); // le navigateur peut demander d'autoriser plusieurs téléchargements
    downloadFile(x);
  }
}
function moveDialog(items) {
  let cur = null;
  const kind = items.length === 1 ? items[0].kind : null, x = items[0].x;
  const movingFolders = new Set(items.filter((s) => s.kind === 'd').map((s) => s.x.id));
  const list = h('ul', { class: 'picker-list' });
  const where = h('div', { class: 'mut' });
  const go = async (id) => {
    const d = await api(`/api/fs?folder=${encodeURIComponent(id || 'root')}`);
    cur = d.folder?.id ?? null;
    where.textContent = [t('Mes fichiers'), ...d.path.map((p) => p.name)].join(' › ');
    const up = d.path.length ? d.path[d.path.length - 2]?.id ?? null : undefined;
    list.replaceChildren(
      up !== undefined ? h('li', {}, h('button', { type: 'button', onclick: () => go(up) }, icon('back'), t('Dossier parent'))) : null,
      ...d.folders.map((f) => h('li', {}, h('button', { type: 'button', disabled: movingFolders.has(f.id), onclick: () => go(f.id) }, folderIcon(), f.name))));
    if (!list.children.length) list.append(h('li', { class: 'mut' }, t('Aucun sous-dossier.')));
  };
  dialog({ title: kind ? t('Déplacer « {name} »', { name: x.name }) : t('Déplacer {n} éléments', { n: items.length }), body: h('div', { class: 'picker' }, where, list),
    actions: [h('button', { class: 'btn', value: 'cancel' }, t('Annuler')), h('button', { class: 'btn primary', value: 'ok' }, t('Déplacer ici'))],
    onClose: (v) => { if (v === 'ok') moveItems(items.map((s) => ({ kind: s.kind, id: s.x.id, name: s.x.name })), cur); } });
  go(state.folder?.id ?? null);
}
async function versionsDialog(file) {
  const list = h('ul', { class: 'versions' }, h('li', { class: 'mut' }, t('Chargement…')));
  const dlg = dialog({ title: t('Versions de « {name} »', { name: file.name }), wide: true,
    body: h('div', {}, h('p', { class: 'mut' }, t('Chaque enregistrement crée une version. Les plus anciennes sont effacées au-delà de la limite fixée par l\'administrateur.')), list),
    actions: [h('button', { class: 'btn', value: 'close' }, t('Fermer'))] });
  const fill = async () => {
    const vs = await api(`/api/files/${file.id}/versions`);
    list.replaceChildren(...vs.map((v) => h('li', {},
      h('div', { class: 'v-main' }, h('strong', {}, `${t('Version {n}', { n: v.n })} `, v.current ? h('span', { class: 'badge accent' }, t('actuelle')) : null, ' ',
          v.auto ? h('span', { class: 'badge', title: t('Sauvegarde automatique, mise à jour jusqu\'au prochain « Enregistrer »') }, t('auto')) : null),
        h('span', { class: 'v-meta' }, `${formatDateTime(v.createdAt)} · ${formatSize(v.size)}${v.app ? ` · ${appBySlug(v.app)?.name || v.app}` : ''}`)),
      h('button', { class: 'btn sm', type: 'button', onclick: () => downloadFile(file, v.id) }, icon('download'), t('Télécharger')),
      v.current ? null : h('button', { class: 'btn sm', type: 'button', onclick: async () => {
        try { await api(`/api/files/${file.id}/versions/${v.id}/restore`, { method: 'POST' }); toast({ title: t('Version {n} restaurée', { n: v.n }), detail: t('Elle devient la version actuelle ; l\'historique est conservé.') }); await fill(); await load(); }
        catch (e) { fail(t('Restauration impossible'))(e); }
      } }, icon('history'), t('Restaurer')))));
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
      x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error(d?.error || t('Erreur {status}', { status: x.status }))); };
    x.onerror = () => reject(new Error(t('Serveur injoignable.')));
    x.send(file);
  });
}
async function upload(fileList, folderId = state.folder?.id ?? null) {
  const files = [...fileList].filter((f) => f.size > 0 || f.type);
  if (!files.length) return;
  const tst = toast({ title: files.length > 1 ? t('Import de {n} fichiers…', { n: files.length }) : t('Import de {n} fichier…', { n: files.length }), detail: '', progress: 0, timeout: 0, closable: false });
  let ok = 0;
  const errors = [];
  for (const [i, f] of files.entries()) {
    tst.update({ detail: `${i + 1}/${files.length} · ${f.name}` });
    try { await uploadOne(f, folderId, (p) => tst.update({ progress: (i + p) / files.length })); ok++; }
    catch (e) { errors.push(t('{name} : {error}', { name: f.name, error: e.message })); }
  }
  tst.close();
  if (ok) toast({ title: ok > 1 ? t('{n} fichiers importés.', { n: ok }) : t('{n} fichier importé.', { n: ok }) });
  for (const e of errors) toast({ type: 'error', title: t('Import impossible'), detail: e });
  await load();
}
function dropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    const types = e.dataTransfer.types;
    if (!types.includes('Files') && !types.includes('application/x-craft')) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
    el.classList.add('drop-target');
    if (types.includes('Files')) showDropHint(folderId);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop-target'); endDrag();
    if (e.dataTransfer.files.length) return upload(e.dataTransfer.files, folderId);
    const d = e.dataTransfer.getData('application/x-craft');
    if (d) { const parsed = JSON.parse(d); moveItems(Array.isArray(parsed) ? parsed : [parsed], folderId); }
  });
}
function showDropHint(folderId) {
  const name = folderId === (state.folder?.id ?? null) ? (state.folder?.name || t('Mes fichiers'))
    : state.folders.find((f) => f.id === folderId)?.name || [{ id: null, name: t('Mes fichiers') }, ...state.path].find((p) => p.id === folderId)?.name;
  $('dropHint').textContent = t('Déposer dans « {name} »', { name });
  $('dropHint').hidden = false;
}
let dragDepth = 0;
function endDrag() { dragDepth = 0; $('area').classList.remove('dragging'); $('dropHint').hidden = true; }

// ---------- Réglages d'affichage ----------
function setView(v) { state.view = v; try { localStorage.setItem('craft-view', v); } catch {} render(); }

// ---------- Démarrage ----------
async function main() {
  translateDom();
  state.me = await api('/api/me');
  syncTheme(state.me);
  state.apps = state.me.apps;
  $('account').replaceWith(accountButton(state.me));
  renderApps();
  if (state.me.guest) {
    $('filesSection').hidden = true; $('searchBox').hidden = true; $('guestSection').hidden = false;
    $('appsHint').textContent = t('Ouvrez une application, puis un fichier de votre ordinateur');
    return;
  }
  $('viewGrid').append(icon('grid')); $('viewList').append(icon('list'));
  $('newFolder').append(icon('folderPlus'), t('Nouveau dossier'));
  $('uploadBtn').prepend(icon('upload'), t('Importer'));
  $('viewGrid').onclick = () => setView('grid');
  $('viewList').onclick = () => setView('list');
  $('sort').value = state.sort;
  $('sort').onchange = () => { state.sort = $('sort').value; try { localStorage.setItem('craft-sort', state.sort); } catch {} render(); };
  $('newFolder').onclick = newFolder;
  $('upload').onchange = (e) => { upload(e.target.files); e.target.value = ''; };
  $('search').oninput = () => { state.filter = $('search').value.trim(); render(); };
  $('area').addEventListener('contextmenu', (e) => { e.preventDefault(); showAreaMenu({ x: e.clientX, y: e.clientY }); });
  const afterLasso = installLasso(document.body); // toute la page, marges latérales comprises
  document.body.addEventListener('click', (e) => { if (afterLasso() || e.ctrlKey || e.metaKey || e.shiftKey || !isEmptySpot(e.target)) return; clearSelection(); closeMenus(); });
  // Barre d'actions de la sélection, et case « tout sélectionner » de la vue en liste.
  $('selDownload').prepend(icon('download')); $('selMove').prepend(icon('move')); $('selDelete').prepend(icon('trash'));
  $('selClear').append(icon('close'));
  $('selDownload').onclick = () => downloadMany(selectedItems().filter((s) => s.kind === 'f'));
  $('selMove').onclick = () => moveDialog(selectedItems());
  $('selDelete').onclick = () => removeMany(selectedItems());
  $('selAll').onclick = selectAll;
  $('selClear').onclick = clearSelection;
  $('selectAll').append(icon('check'));
  $('selectAll').onclick = () => { state.checkMode = true; state.sel.size === $('items').children.length ? clearSelection() : selectAll(); };
  // Fichiers venus de l'ordinateur : surbrillance de toute la zone, dépôt dans le dossier courant.
  const area = $('area');
  area.addEventListener('dragenter', (e) => { if (!e.dataTransfer.types.includes('Files')) return; dragDepth++; area.classList.add('dragging'); showDropHint(state.folder?.id ?? null); });
  area.addEventListener('dragleave', () => { if (--dragDepth <= 0) endDrag(); });
  area.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); showDropHint(state.folder?.id ?? null); } });
  area.addEventListener('drop', (e) => { e.preventDefault(); endDrag(); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); });
  window.addEventListener('dragend', endDrag);
  window.addEventListener('popstate', (e) => (e.state?.trash ? showTrash() : load(e.state?.folder ?? null)));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, dialog, .menu')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && $('items').children.length) { e.preventDefault(); selectAll(); }
    if (e.key === 'Escape' && state.sel.size) clearSelection();
    if (e.key === 'Backspace' && state.path.length) { e.preventDefault(); load(state.path[state.path.length - 2]?.id ?? null, { push: true }); }
  });
  // Accès rapide (récents, favoris) et corbeille.
  quick = quickAccess({ appBySlug, defaultApp, docIcon, folderIcon, openFile, openFolder: (id) => load(id, { push: true }) });
  trash = trashView({ docIcon, folderIcon, refreshCount: async () => { const d = await api('/api/fs?folder=root'); state.trash = d.trash; renderTrashBtn(); quick.refresh(); } });
  $('trashBtn').onclick = () => (state.inTrash ? load(null, { push: true }) : showTrash({ push: true }));
  quick.refresh();
  const qs = new URLSearchParams(location.search);
  await load(qs.get('folder'));
  if (qs.has('trash')) await showTrash();
  // Assistant IA (si l'admin l'a ouvert à ce compte) : outils de l'explorateur.
  mountAgent({
    button: $('agentBtn'),
    context: () => ({ page: 'home', folder: ['Mes fichiers', ...state.path.map((p) => p.name)].join(' / ') }),
    tools: explorerTools({
      reload: async () => { await load(); quick?.refresh(); },
      show: async (id) => { await load(id, { push: true }); return state.folder?.name || 'Mes fichiers'; },
      filter: (text) => { $('search').value = state.filter = text; render(); return $('items').children.length; },
      select: (keys) => { state.sel = new Set(keys.filter((k) => findItem(k))); state.checkMode = true; paintSelection(); return state.sel.size; },
      unselect: (k) => state.sel.delete(k),
      open: (f, slug) => openFile(f, slug),
      apps: () => state.apps,
    }),
  }).catch(() => {});
}
main().catch((e) => { if (e.status !== 401) toast({ type: 'error', title: t('Chargement impossible'), detail: e.message }); });
