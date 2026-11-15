// Accueil, compléments : vue Corbeille, accès rapide (récents et favoris), miniatures des images.
// x : ce que l'explorateur partage (état, rechargement, ouverture, icônes).
import { api, h, icon, toast, confirmDialog, formatSize, formatDate, formatDateTime, appTile } from '/ui.js';
import { t } from '/i18n.js';

// ---------- Miniatures ----------
// Images : faites ici depuis le fichier (version courante), envoyées au serveur. Documents : par les applications (host.js).
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']);
export async function makeThumb(source, max = 320) {
  // source : Blob. Les SVG passent par <img> (aucun script n'y est exécuté).
  let bmp;
  if (source.type === 'image/svg+xml') {
    const url = URL.createObjectURL(source);
    try { const img = new Image(); img.src = url; await img.decode(); bmp = img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  } else bmp = await createImageBitmap(source);
  const w = bmp.width || bmp.naturalWidth, hgt = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, max / Math.max(w, hgt));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hgt * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
}
export async function uploadThumb(file, blob) {
  if (!blob || blob.size > 300 * 1024) return false;
  const r = await fetch(`/api/files/${file.id}/thumb`, { method: 'PUT', credentials: 'same-origin', body: blob,
    headers: { 'Content-Type': blob.type || 'image/webp', 'X-Version': file.versionId } });
  return r.ok;
}
const queue = [];
let running = 0;
function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift();
    running++;
    job().finally(() => { running--; pump(); });
  }
}
// Pour un élément affiché sans miniature : générée quand il devient visible (images de 30 Mio au plus).
const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    observer.unobserve(e.target);
    e.target.__thumbJob?.();
  }
}, { rootMargin: '200px' }) : null;
export function wantThumb(el, file, onReady) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (file.thumb || !IMAGE_EXT.has(ext) || file.size > 30 * 1024 ** 2 || !file.versionId || !observer) return;
  el.__thumbJob = () => { queue.push(async () => {
    try {
      const r = await fetch(`/api/files/${file.id}/content`, { credentials: 'same-origin' });
      if (!r.ok) return;
      const blob = await r.blob();
      const typed = ext === 'svg' ? new Blob([blob], { type: 'image/svg+xml' }) : blob;
      const tb = await makeThumb(typed);
      if (await uploadThumb(file, tb)) onReady(file.versionId);
    } catch {} // image illisible : l'icône reste
  }); pump(); };
  observer.observe(el);
}
export const thumbUrl = (file) => `/api/files/${file.id}/thumb?v=${encodeURIComponent(file.thumb)}`;

// ---------- Accès rapide : récents et favoris ----------
export function quickAccess(x) {
  const root = document.getElementById('quick');
  let tab = (() => { try { return localStorage.getItem('craft-quick-tab') || 'recents'; } catch { return 'recents'; } })();
  let data = { recents: [], favorites: [] };
  const card = (it) => {
    const isFolder = it.type === 'folder';
    const app = isFolder ? null : x.appBySlug(it.openedWith) || x.defaultApp(it);
    const thumb = h('div', { class: 'q-thumb' });
    if (!isFolder && it.thumb) thumb.append(h('img', { src: thumbUrl(it), alt: '', loading: 'lazy' }));
    else thumb.append(isFolder ? x.folderIcon() : x.docIcon(it.name));
    const sub = isFolder ? t('Dossier') : tab === 'recents' ? `${app ? `${app.name} · ` : ''}${formatDate(it.openedAt)}` : `${formatSize(it.size)} · ${formatDate(it.updatedAt)}`;
    return h('button', { type: 'button', class: 'q-card', title: it.name, onclick: () => (isFolder ? x.openFolder(it.id) : x.openFile(it, it.openedWith && app ? it.openedWith : undefined)) },
      thumb, h('div', { class: 'q-meta' }, h('div', { class: 'q-name' }, app && !isFolder ? appTile(app, 'app-tile mini') : null, h('span', {}, it.name)), h('div', { class: 'q-sub' }, sub)));
  };
  function render() {
    const list = data[tab] || [];
    root.hidden = !data.recents.length && !data.favorites.length;
    if (root.hidden) return;
    const tabBtn = (id, label, n) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; try { localStorage.setItem('craft-quick-tab', id); } catch {} render(); } },
      label, n ? h('span', { class: 'count' }, String(n)) : null);
    root.replaceChildren(
      h('div', { class: 'q-head', role: 'tablist', 'aria-label': t('Accès rapide') }, tabBtn('recents', t('Récents'), data.recents.length), tabBtn('favorites', t('Favoris'), data.favorites.length)),
      list.length ? h('div', { class: 'q-row' }, ...list.map(card))
        : h('p', { class: 'mut q-empty' }, tab === 'recents' ? t('Les fichiers ouverts dans une application apparaîtront ici.') : t('Ajoutez des fichiers ou des dossiers aux favoris (clic droit › Ajouter aux favoris).')));
  }
  return { refresh: async () => { try { data = await api('/api/quick'); } catch {} render(); } };
}

// ---------- Vue Corbeille ----------
// Origine d'un élément (« Mes fichiers / … » ou « dossier supprimé », en français côté serveur) : traduite à l'affichage.
function fromLabel(from) {
  if (from === 'dossier supprimé') return t('dossier supprimé');
  return String(from || '').startsWith('Mes fichiers') ? t('Mes fichiers') + from.slice('Mes fichiers'.length) : from;
}
export function trashView(x) {
  async function restore(items) {
    const r = await api('/api/trash/restore', { method: 'POST', body: { items } });
    const moved = r.restored.filter((it) => it.folderId === null);
    toast({ title: r.restored.length > 1 ? t('{n} éléments restaurés.', { n: r.restored.length }) : t('{n} élément restauré.', { n: r.restored.length }),
      detail: r.restored.some((it, i) => it.name !== items[i]?.name && it.name) ? t('Un nom déjà pris a été changé.') : moved.length && r.restored.length === 1 ? t('Son dossier n\'existe plus : remis dans « Mes fichiers ».') : null });
    await render();
    x.refreshCount();
  }
  async function destroy(items, all = false) {
    const ok = await confirmDialog({ title: all ? t('Vider la corbeille ?') : items.length > 1 ? t('Supprimer définitivement {n} éléments ?', { n: items.length }) : t('Supprimer définitivement « {name} » ?', { name: items[0].name }),
      message: all ? t('Tout son contenu sera effacé définitivement, versions comprises.') : t('Effacement définitif, versions comprises : impossible de revenir en arrière.'), confirm: t('Supprimer définitivement'), danger: true });
    if (!ok) return;
    const r = await api('/api/trash/delete', { method: 'POST', body: all ? { all: true } : { items: items.map((it) => ({ type: it.type, id: it.id })) } });
    toast({ title: r.deleted > 1 ? t('{n} éléments supprimés définitivement.', { n: r.deleted }) : t('{n} élément supprimé définitivement.', { n: r.deleted }) });
    await render();
    x.refreshCount();
  }
  async function render() {
    const items = document.getElementById('items');
    let d;
    try { d = await api('/api/trash'); } catch (e) { toast({ type: 'error', title: t('Corbeille indisponible'), detail: e.message }); return; }
    items.className = 'items trash';
    document.getElementById('empty').hidden = d.items.length > 0;
    document.getElementById('empty').querySelector('strong').textContent = t('La corbeille est vide.');
    document.getElementById('empty').querySelector('.mut').textContent = d.days ? t('Les éléments supprimés y restent {n} jours.', { n: d.days }) : t('Corbeille désactivée : les suppressions sont définitives.');
    const bar = h('div', { class: 'trash-bar' },
      h('span', { class: 'mut' }, d.days ? t('Effacement automatique après {n} jours.', { n: d.days }) : ''),
      h('div', { class: 'spacer' }),
      d.items.length ? h('button', { type: 'button', class: 'btn sm', onclick: () => restore(d.items.map((it) => ({ type: it.type, id: it.id, name: it.name }))) }, icon('history'), t('Tout restaurer')) : null,
      d.items.length ? h('button', { type: 'button', class: 'btn sm danger', onclick: () => destroy(d.items, true) }, icon('trash'), t('Vider la corbeille')) : null);
    const rows = d.items.map((it) => h('div', { class: 'trash-row' },
      h('div', { class: 'thumb' }, it.type === 'folder' ? x.folderIcon() : x.docIcon(it.name)),
      h('div', { class: 't-main' }, h('div', { class: 'name' }, it.name),
        h('div', { class: 'mut t-sub' }, `${it.type === 'folder' ? (it.files > 1 ? t('Dossier · {n} fichiers', { n: it.files }) : t('Dossier · {n} fichier', { n: it.files })) : t('Fichier')} · ${formatSize(it.size)} · ${t('venait de « {from} »', { from: fromLabel(it.from) })}`)),
      h('div', { class: 'mut t-date', title: it.purgeAt ? t('Effacé définitivement le {date}', { date: formatDateTime(it.purgeAt) }) : '' }, t('Supprimé {date}', { date: formatDate(it.deletedAt) })),
      h('button', { type: 'button', class: 'btn sm', onclick: () => restore([{ type: it.type, id: it.id, name: it.name }]) }, icon('history'), t('Restaurer')),
      h('button', { type: 'button', class: 'btn sm icon ghost danger', title: t('Supprimer définitivement'), 'aria-label': t('Supprimer définitivement {name}', { name: it.name }), onclick: () => destroy([it]) }, icon('trash'))));
    items.replaceChildren(bar, ...rows);
    if (!d.items.length) bar.remove();
  }
  return { render };
}

// ---------- Partage par lien ----------
const EXPIRIES = [['1h', '1 heure'], ['1d', '1 jour'], ['7d', '7 jours'], ['30d', '30 jours'], ['never', 'Sans limite']];
export async function shareDialog(file) {
  const { dialog } = await import('/ui.js');
  let d;
  try { d = await api(`/api/files/${file.id}/shares`); } catch (e) { toast({ type: 'error', title: t('Partage indisponible'), detail: e.message }); return; }
  if (!d.enabled) { toast({ type: 'error', title: t('Partage désactivé'), detail: t('L\'administrateur a désactivé les liens de partage.') }); return; }
  const list = h('ul', { class: 'share-list' });
  const fresh = h('div', { class: 'share-fresh', hidden: true });
  const expires = h('select', { 'aria-label': t('Durée du lien') }, ...EXPIRIES.map(([v, l]) => h('option', { value: v, selected: v === '7d' }, t(l))));
  const fill = (shares) => {
    list.replaceChildren(...(shares.length ? shares.map((sh) => h('li', {},
      h('div', { class: 'share-l' }, h('strong', {}, t('Lien du {date}', { date: formatDateTime(sh.createdAt) })),
        h('span', { class: 'mut' }, [sh.expiresAt ? t('expire le {date}', { date: formatDateTime(sh.expiresAt) }) : t('sans limite'),
          sh.downloads > 1 ? t('{n} téléchargements', { n: sh.downloads }) : t('{n} téléchargement', { n: sh.downloads }),
          sh.lastAccessAt ? t('dernière visite {date}', { date: formatDate(sh.lastAccessAt) }) : null].filter(Boolean).join(' · '))),
      h('button', { type: 'button', class: 'btn sm danger', onclick: async () => {
        try { await api(`/api/shares/${sh.id}`, { method: 'DELETE' }); fill((await api(`/api/files/${file.id}/shares`)).shares); toast({ title: t('Lien révoqué.') }); }
        catch (e) { toast({ type: 'error', title: t('Révocation impossible'), detail: e.message }); }
      } }, t('Révoquer'))))
      : [h('li', { class: 'mut' }, t('Aucun lien actif.'))]));
  };
  fill(d.shares);
  const create = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    try {
      const r = await api(`/api/files/${file.id}/shares`, { method: 'POST', body: { expires: expires.value } });
      const url = `${location.origin}${r.url}`;
      const input = h('input', { type: 'text', value: url, readonly: true, 'aria-label': t('Lien de partage'), onfocus: (e) => e.target.select() });
      const copy = h('button', { type: 'button', class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(url); copy.textContent = t('Copié'); } catch { input.select(); } } }, icon('link'), t('Copier'));
      fresh.replaceChildren(h('div', { class: 'row' }, input, copy), h('p', { class: 'hint' }, t('Copiez-le maintenant : il n\'est affiché qu\'une fois. Toute personne qui l\'a peut voir et télécharger ce fichier.')));
      fresh.hidden = false;
      input.focus();
      fill((await api(`/api/files/${file.id}/shares`)).shares);
    } catch (e) { toast({ type: 'error', title: t('Lien non créé'), detail: e.message }); }
  } }, icon('link'), t('Créer un lien'));
  dialog({ title: t('Partager « {name} »', { name: file.name }), wide: true,
    body: h('div', { class: 'share-dlg' },
      h('p', { class: 'mut' }, t('Un lien permet de voir et de télécharger la version actuelle de ce fichier, sans compte. Il cesse de fonctionner à son expiration, si vous le révoquez ou si le fichier part à la corbeille.')),
      h('div', { class: 'row' }, h('label', { class: 'field' }, t('Durée'), expires), create), fresh,
      h('h3', {}, t('Liens actifs')), list),
    actions: [h('button', { class: 'btn', value: 'close' }, t('Fermer'))] });
}
