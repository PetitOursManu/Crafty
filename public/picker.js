// Sélecteur de fichiers Crafty : remplace la boîte « Ouvrir » du système quand une application en demande une.
// Dossiers du compte, fichiers filtrés par formats acceptés, recherche, sélection multiple si demandée,
// et « Importer depuis l'ordinateur » (envoi dans le dossier affiché, puis remise directe à l'application).
import { api, h, icon, dialog, toast, extOf, extColor, formatSize, formatDate } from '/ui.js';
import { t } from '/i18n.js';

function fileBadge(name) {
  const ext = extOf(name).slice(0, 4).toUpperCase() || '—';
  const b = h('span', { class: 'pk-ext' }, ext);
  b.style.background = extColor(extOf(name));
  return b;
}
async function uploadTo(folderId, file) {
  const r = await fetch(`/api/files?folder=${encodeURIComponent(folderId || 'root')}`, {
    method: 'POST', body: file, credentials: 'same-origin', headers: { 'X-File-Name': encodeURIComponent(file.name) } });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || t('Erreur {status}', { status: r.status }));
  return d;
}

// exts : extensions acceptées (minuscules, sans point) ; renvoie une liste de fichiers (métadonnées) ou null.
export function pickFiles({ title = 'Ouvrir', exts = [], multiple = false, folderId = null, appName = '' } = {}) {
  return new Promise((resolve) => {
    let folder = folderId, data = null, filter = '';
    const selected = new Map();
    const ok = (name) => !exts.length || exts.includes(extOf(name));
    const crumbs = h('nav', { class: 'pk-crumbs', 'aria-label': t('Emplacement') });
    const search = h('input', { type: 'search', placeholder: t('Rechercher dans ce dossier'), 'aria-label': t('Rechercher dans ce dossier') });
    const list = h('ul', { class: 'pk-list', role: 'listbox', 'aria-multiselectable': multiple ? 'true' : 'false', 'aria-label': t('Fichiers') });
    const count = h('span', { class: 'mut pk-count' });
    const openBtn = h('button', { class: 'btn primary', value: 'ok', disabled: true }, t('Ouvrir'));
    const osInput = h('input', { type: 'file', multiple, hidden: true, accept: exts.map((e) => `.${e}`).join(',') });
    const importBtn = h('button', { class: 'btn', type: 'button' }, icon('upload'), t('Importer depuis l\'ordinateur…'));
    const hint = h('p', { class: 'mut pk-hint' }, exts.length
      ? t('Formats ouverts par {app} : {exts}', { app: appName || t('l\'application'), exts: exts.map((e) => `.${e}`).join(' ') }) : '');

    const finish = (files) => { dlg.result = files; dlg.close(files ? 'ok' : 'cancel'); };
    // Titre : traduit ici (l'appelant peut passer le texte français ou déjà traduit).
    const dlg = dialog({ title: t(title), wide: true,
      body: h('div', { class: 'pk' }, h('div', { class: 'pk-top' }, crumbs, search), list, hint, osInput),
      actions: [importBtn, h('span', { class: 'pk-spacer' }), count, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, t('Annuler')), openBtn],
      onClose: () => resolve(dlg.result || null) });
    dlg.classList.add('picker-dlg');
    dlg.querySelector('form').addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'ok') return;
      e.preventDefault();
      if (selected.size) finish([...selected.values()]);
    });

    function sync() {
      openBtn.disabled = selected.size === 0;
      count.textContent = multiple && selected.size ? t('{n} sélectionné(s)', { n: selected.size }) : '';
      for (const li of list.children) if (li.dataset.id) li.setAttribute('aria-selected', String(selected.has(li.dataset.id)));
    }
    function toggle(f) {
      if (!multiple) selected.clear();
      if (multiple && selected.has(f.id)) selected.delete(f.id); else selected.set(f.id, f);
      sync();
    }
    function render() {
      const f = filter.toLowerCase();
      const parts = [{ id: null, name: t('Mes fichiers') }, ...data.path];
      crumbs.replaceChildren(...parts.flatMap((p, i) => [i ? icon('chevron', 'sep') : null,
        h('button', { type: 'button', 'aria-current': i === parts.length - 1 ? 'location' : null, onclick: () => go(p.id) }, p.name)]).filter(Boolean));
      const folders = data.folders.filter((x) => !f || x.name.toLowerCase().includes(f));
      const files = data.files.filter((x) => ok(x.name) && (!f || x.name.toLowerCase().includes(f)));
      const hidden = data.files.filter((x) => !ok(x.name)).length;
      list.replaceChildren(
        ...folders.map((d) => h('li', { class: 'pk-row folder', tabindex: 0, role: 'option', 'aria-selected': 'false',
          onclick: () => go(d.id), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(d.id); } } },
          icon('folder', 'pk-folder'), h('span', { class: 'pk-name' }, d.name), h('span', { class: 'pk-meta' }, t('Dossier')))),
        ...files.map((x) => h('li', { class: 'pk-row', tabindex: 0, role: 'option', dataset: { id: x.id }, 'aria-selected': 'false',
          onclick: () => toggle(x), ondblclick: () => { selected.clear(); selected.set(x.id, x); finish([x]); },
          onkeydown: (e) => { if (e.key === ' ') { e.preventDefault(); toggle(x); } else if (e.key === 'Enter') { e.preventDefault(); if (!selected.has(x.id)) toggle(x); finish([...selected.values()]); } } },
          fileBadge(x.name), h('span', { class: 'pk-name' }, x.name), h('span', { class: 'pk-meta' }, `${formatSize(x.size)} · ${formatDate(x.updatedAt)}`))),
      );
      if (!folders.length && !files.length) list.append(h('li', { class: 'pk-empty mut' }, f ? t('Aucun résultat.') : t('Aucun fichier compatible dans ce dossier.')));
      if (hidden && !f) list.append(h('li', { class: 'pk-empty mut' }, t('{n} autre(s) fichier(s) d\'un format que {app} n\'ouvre pas.', { n: hidden, app: appName || t('cette application') })));
      sync();
    }
    async function go(id) {
      try {
        data = await api(`/api/fs?folder=${encodeURIComponent(id || 'root')}`);
        folder = data.folder?.id ?? null;
        filter = ''; search.value = '';
        render();
      } catch (e) { list.replaceChildren(h('li', { class: 'pk-empty error-text' }, e.message)); }
    }
    search.addEventListener('input', () => { filter = search.value.trim(); render(); });
    importBtn.addEventListener('click', () => osInput.click());
    osInput.addEventListener('change', async () => {
      const files = [...osInput.files];
      osInput.value = '';
      if (!files.length) return;
      importBtn.disabled = true;
      const done = [];
      for (const f of files) {
        if (!ok(f.name)) { toast({ type: 'error', title: t('Format non pris en charge'), detail: t('{name} : {app} n\'ouvre pas les fichiers .{ext}', { name: f.name, app: appName || t('l\'application'), ext: extOf(f.name) || '?' }) }); continue; }
        try { done.push(await uploadTo(folder, f)); } catch (e) { toast({ type: 'error', title: t('Import impossible'), detail: t('{name} : {error}', { name: f.name, error: e.message }) }); }
      }
      importBtn.disabled = false;
      if (done.length) {
        toast({ title: t('{n} fichier(s) importé(s) dans vos fichiers.', { n: done.length }) });
        finish(multiple ? done : [done[0]]);
      } else await go(folder);
    });
    go(folderId);
    search.focus();
  });
}
