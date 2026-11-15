// Outils d'interface communs : appels d'API, éléments, icônes, menus, dialogues, notifications, thème, compte.

export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  let r;
  try { r = await fetch(path, opts); } catch { throw new ApiError(0, 'Serveur injoignable.'); }
  if (r.status === 401 && !path.startsWith('/api/auth/')) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, 'Connexion requise.');
  }
  if (raw) { if (!r.ok) throw new ApiError(r.status, await r.json().then((d) => d.error, () => r.statusText)); return r; }
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, data?.error || `Erreur ${r.status}`, data);
  return data;
}

export function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}

const ICONS = {
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2h8.6A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  upload: '<path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  download: '<path d="M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  folderPlus: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2h8.6A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 11v5m-2.5-2.5h5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v4.5A1.5 1.5 0 0 1 17.5 20h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5H10"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  move: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2h8.6A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M10 13.5h5m-2-2 2 2-2 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  logout: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 8l-4 4 4 4M6 12h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9m-3 3 3 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  convert: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="14.5" cy="7" r="1.2"/>',
  pipette: '<path d="M14.5 5.5l4 4M13 7l-8.5 8.5L4 20l4.5-.5L17 11"/><path d="M15 4.5a2.1 2.1 0 0 1 3 0l1.5 1.5a2.1 2.1 0 0 1 0 3L17 11l-4-4z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 18h.01M12 18h4"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  save: '<path d="M5 4h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  home: '<path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5z"/>',
};
export function icon(name, cls = '') {
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  t.setAttribute('viewBox', '0 0 24 24');
  t.setAttribute('class', `i ${cls}`);
  t.setAttribute('aria-hidden', 'true');
  t.innerHTML = ICONS[name] || ICONS.file;
  return t;
}

// Couleurs par application (pas de logo : les logos ArtCraft ne s'utilisent qu'inchangés, avec l'application).
// Couleurs des applications : fond de leur icône officielle (getartcraft.com/images/apps/<slug>/icon.webp, mesuré le
// 15/11/2026 : teinte dominante des pixels colorés) ; MailCraft et SolidCraft : icône de leur zip.
const APP_COLORS = { pdfcraft: '#b4052a', wordcraft: '#3b5ad9', gridcraft: '#1e9a53', deckcraft: '#f16b1f', cadcraft: '#15a3c5',
  figcraft: '#07d493', vectorcraft: '#df563e', effectcraft: '#d9368c', designcraft: '#78b21b', texturecraft: '#be682e',
  materialcraft: '#18889a', soundcraft: '#15a7c2', 'craft-anything': '#4e79f3', photocraft: '#3077e8', filmcraft: '#895cf1',
  lightcraft: '#efa720', mailcraft: '#4b9bf1', solidcraft: '#2676db' };
export function appColor(slug) {
  if (APP_COLORS[slug]) return APP_COLORS[slug];
  let x = 0; for (const c of slug) x = (x * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${x} 55% 45%)`;
}
export function appTile(app, cls = 'app-tile') {
  const t = h('span', { class: cls, 'aria-hidden': 'true' }, app.name.slice(0, 1));
  t.style.background = appColor(app.slug);
  return t;
}
// Couleur d'un type de fichier, pour l'icône.
const C = APP_COLORS;
const EXT_COLORS = { pdf: C.pdfcraft, docx: C.wordcraft, doc: C.wordcraft, odt: C.wordcraft, rtf: C.wordcraft, txt: '#6b6e78', md: '#6b6e78',
  xlsx: C.gridcraft, xlsm: C.gridcraft, ods: C.gridcraft, csv: C.gridcraft, tsv: C.gridcraft, pptx: C.deckcraft, deckcraft: C.deckcraft,
  dxf: C.cadcraft, dwg: C.cadcraft, figcraft: C.figcraft, fig: C.figcraft, designcraft: C.designcraft, idml: C.designcraft,
  scraftz: C.soundcraft, scraft: C.soundcraft, vectorcraft: C.vectorcraft, ai: C.vectorcraft, svg: C.vectorcraft, eps: C.vectorcraft,
  ecproj: C.effectcraft, tcraft: C.texturecraft, mcraft: C.materialcraft, sbs: C.materialcraft, sc: C.solidcraft, step: C.solidcraft,
  stp: C.solidcraft, stl: C.solidcraft, '3mf': C.solidcraft, obj: C.solidcraft, glb: C.solidcraft, gltf: C.solidcraft,
  mailcraft: C.mailcraft, eml: C.mailcraft, mbox: C.mailcraft, ics: C.mailcraft, vcf: C.mailcraft,
  png: C.photocraft, jpg: C.photocraft, jpeg: C.photocraft, webp: C.photocraft, zip: '#8a6d3b' };
export const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
export const extColor = (ext) => EXT_COLORS[ext] || '#7a7f8c';

export function formatSize(n) {
  if (n < 1024) return `${n} o`;
  const u = ['Kio', 'Mio', 'Gio', 'Tio']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0).replace('.', ',')} ${u[i]}`;
}
export function formatDate(ms) {
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `aujourd'hui ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `hier ${time}`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
export const formatDateTime = (ms) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

// --- Notifications ---
function toastHost() {
  let el = document.getElementById('toasts');
  if (!el) { el = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(el); }
  return el;
}
export function toast({ type = 'info', title, detail, actions = [], timeout = type === 'error' ? 0 : 4000, closable = true, progress } = {}) {
  const det = h('span', { class: 't-detail' }, detail ?? '');
  const bar = progress !== undefined ? h('progress', { max: 1, value: progress }) : null;
  const titleEl = h('strong', {}, title);
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('div', { class: 't-body' }, titleEl, detail != null ? det : null, bar),
    actions.map((a) => h('button', { class: 'btn sm', type: 'button', onclick: () => a.onClick(api_) }, a.label)),
    closable ? h('button', { class: 't-close', type: 'button', 'aria-label': 'Fermer', onclick: () => api_.close() }, '×') : null);
  const api_ = {
    el,
    close() { el.remove(); },
    update({ title: t, detail: d, progress: p } = {}) {
      if (t !== undefined) titleEl.textContent = t;
      if (d !== undefined) { det.textContent = d; if (!det.parentNode) titleEl.after(det); }
      if (p !== undefined && bar) bar.value = p;
    },
  };
  toastHost().append(el);
  if (timeout) setTimeout(() => api_.close(), timeout);
  return api_;
}

// --- Menus contextuels (souris, clavier, sous-menus) ---
let openMenus = [];
export function closeMenus(depth = 0) { for (const m of openMenus.splice(depth)) m.remove(); }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenus(); }, true);
window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => closeMenus());

export function openMenu(items, at, depth = 0) {
  closeMenus(depth);
  const restore = depth === 0 ? document.activeElement : null;
  const menu = h('div', { class: 'menu', role: 'menu' });
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { menu.append(h('hr')); continue; }
    if (it.heading) { menu.append(h('div', { class: 'label' }, it.heading)); continue; }
    const b = h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', 'aria-disabled': it.disabled ? 'true' : null,
      'aria-haspopup': it.submenu ? 'menu' : null, title: it.title || null },
      it.icon ? (it.icon instanceof Node ? it.icon : icon(it.icon)) : h('span', { class: 'i' }), h('span', {}, it.label),
      it.submenu ? icon('chevron', 'sub-arrow') : it.hint ? h('span', { class: 'kbd' }, it.hint) : null);
    const openSub = () => {
      const r = b.getBoundingClientRect();
      openMenu(it.submenu, { x: r.right - 4, y: r.top - 6, alt: r.left + 4 }, depth + 1);
    };
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      if (it.submenu) return openSub();
      closeMenus();
      restore?.focus?.();
      it.onClick?.();
    });
    if (it.submenu) b.addEventListener('pointerenter', openSub);
    else b.addEventListener('pointerenter', () => closeMenus(depth + 1));
    buttons.push(b);
    menu.append(b);
  }
  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowRight' && buttons[i]?.getAttribute('aria-haspopup')) { e.preventDefault(); buttons[i].click(); openMenus[depth + 1]?.querySelector('[role=menuitem]')?.focus(); }
    else if (e.key === 'ArrowLeft' && depth > 0) { e.preventDefault(); closeMenus(depth); openMenus[depth - 1]?.querySelector('[role=menuitem]')?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenus(); restore?.focus?.(); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  });
  document.body.append(menu);
  openMenus.push(menu);
  // Positionnement dans la fenêtre
  const r = menu.getBoundingClientRect();
  let x = at.x, y = at.y;
  if (x + r.width > innerWidth - 8) x = at.alt !== undefined ? at.alt - r.width : innerWidth - r.width - 8;
  if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${y}px`;
  if (at.focus !== false) requestAnimationFrame(() => buttons.find((b) => b.getAttribute('aria-disabled') !== 'true')?.focus());
  return menu;
}
export function menuAt(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4, alt: r.right }; }

// --- Dialogues ---
export function dialog({ title, body, actions, wide = false, onClose }) {
  const dlg = h('dialog', { class: wide ? 'wide' : '' });
  const foot = h('div', { class: 'dlg-foot' });
  dlg.append(h('form', { class: 'dlg', method: 'dialog' },
    h('div', { class: 'dlg-head' }, h('h2', {}, title)), h('div', { class: 'dlg-body' }, body), foot));
  for (const a of actions || []) foot.append(a);
  // Entrée dans un champ : le bouton de validation. Sans cela, l'envoi implicite du formulaire prend le premier bouton
  // du pied, « Annuler » (« Nouveau dossier » + Entrée annulait au lieu de créer).
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=button])')) return;
    const ok = foot.querySelector('button[value=ok]') || foot.querySelector('button.primary');
    if (!ok) return;
    e.preventDefault();
    ok.click();
  });
  dlg.addEventListener('close', () => { onClose?.(dlg.returnValue); dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
export function confirmDialog({ title, message, confirm = 'Confirmer', danger = false }) {
  return new Promise((resolve) => {
    dialog({ title, body: h('p', {}, message), onClose: (v) => resolve(v === 'ok'),
      actions: [h('button', { class: 'btn', value: 'cancel' }, 'Annuler'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, value: 'ok', autofocus: true }, confirm)] });
  });
}
export function promptDialog({ title, label, value = '', confirm = 'Valider', selectBase = false, hint, validate }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, required: true, maxlength: 255, autocomplete: 'off', spellcheck: false });
    const errEl = h('div', { class: 'error-text', role: 'alert' });
    const dlg = dialog({ title,
      body: h('div', { class: 'form' }, h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null), errEl),
      onClose: (v) => resolve(v === 'ok' ? input.value.trim() : null),
      actions: [h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Annuler'), h('button', { class: 'btn primary', value: 'ok' }, confirm)] });
    dlg.querySelector('form').addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'ok') return;
      const msg = validate?.(input.value.trim());
      if (msg) { e.preventDefault(); errEl.textContent = msg; input.focus(); }
    });
    input.focus();
    const dot = value.lastIndexOf('.');
    if (selectBase && dot > 0) input.setSelectionRange(0, dot); else input.select();
  });
}
export const validName = (n) => (!n ? 'Le nom ne peut pas être vide.' : /[\\/]/.test(n) ? 'Le nom ne peut pas contenir / ou \\.' : n.length > 255 ? 'Nom trop long.' : null);

// --- Thème et compte ---
export const THEMES = [{ id: 'light', label: 'Clair', icon: 'sun' }, { id: 'dark', label: 'Sombre', icon: 'moon' }, { id: 'system', label: 'Système', icon: 'monitor' }];
export function setTheme(choice, sync = true) {
  window.craftTheme.set(choice);
  if (sync) api('/api/me', { method: 'PATCH', body: { theme: choice } }).catch(() => {});
}
export function changePasswordDialog() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const dlg = dialog({ title: 'Changer le mot de passe',
    body: h('div', { class: 'form' }, h('label', { class: 'field' }, 'Mot de passe actuel', cur),
      h('label', { class: 'field' }, 'Nouveau mot de passe', p1, h('span', { class: 'hint' }, 'Au moins 8 caractères. Vos autres sessions seront fermées.')),
      h('label', { class: 'field' }, 'Confirmer', p2), errEl),
    actions: [h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Annuler'), h('button', { class: 'btn primary', value: 'ok' }, 'Enregistrer')] });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    if (p1.value !== p2.value) { errEl.textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: cur.value, password: p1.value } });
      dlg.close('done');
      toast({ title: 'Mot de passe changé.' });
    } catch (err) { errEl.textContent = err.message; }
  });
}
export async function logout(me) {
  // Réglages en attente envoyés, puis ceux du compte retirés de ce navigateur (voir prefs-sync.js).
  await window.craftPrefsFlush?.();
  // Données des applications (appdata-sync.js) : dernier envoi, puis effacées de ce navigateur.
  try { await (await import('/appdata-sync.js')).flushAndWipe(me); } catch {}
  try { for (const k of [...new Set((me?.apps || []).flatMap((a) => a.prefKeys || [])), 'craft-prefs-sync']) localStorage.removeItem(k); } catch {}
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login.html';
}
// Menu du compte (avatar en haut à droite).
export function accountButton(me) {
  const name = me.guest ? 'Invité' : me.user.username;
  const btn = h('button', { class: 'avatar', type: 'button', 'aria-haspopup': 'menu', title: name, 'aria-label': `Compte : ${name}` },
    me.guest ? icon('user') : name.slice(0, 1).toUpperCase());
  btn.addEventListener('click', () => {
    const choice = window.craftTheme.get();
    openMenu([
      { heading: me.guest ? 'Session invitée' : `${name}${me.user.role === 'admin' ? ' · administrateur' : ''}` },
      { label: 'Thème', icon: THEMES.find((t) => t.id === choice)?.icon || 'sun',
        submenu: THEMES.map((t) => ({ label: t.label, icon: t.id === choice ? 'check' : t.icon, onClick: () => setTheme(t.id, !me.guest) })) },
      !me.guest && { label: 'Changer le mot de passe', icon: 'key', onClick: changePasswordDialog },
      !me.guest && me.user.role === 'admin' && { label: 'Administration', icon: 'shield', onClick: () => { location.href = '/admin.html'; } },
      { separator: true },
      me.guest ? { label: 'Se connecter', icon: 'user', onClick: () => logout(me) } : { label: 'Se déconnecter', icon: 'logout', onClick: () => logout(me) },
    ], menuAt(btn));
  });
  return btn;
}
// Aligne le thème local sur celui du compte (le compte fait foi).
export function syncTheme(me) {
  if (me.user?.theme && me.user.theme !== window.craftTheme.get()) window.craftTheme.set(me.user.theme);
}
