// Page hôte : charge /apps/<slug>/?host=parent dans une iframe de même origine, ouvre le fichier demandé et
// enregistre les `save` de l'application dans l'espace de fichiers du compte (nouvelle version à chaque fois).
// Constats de la phase 0 (FINDINGS.md) : pas d'`id` dans `save`, donc pas de `saved` ; l'application se croit
// enregistrée dès l'envoi, la page tient donc son propre état « non sauvegardé » et l'affiche (alerte rouge).
import { api, h, icon, toast, dialog, confirmDialog, validName, appTile, extOf, formatDateTime, accountButton, syncTheme } from '/ui.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const slug = /^[a-z0-9-]+$/.test(q.get('app') || '') ? q.get('app') : null;
const iframe = $('app');
const state = (window.hostState = { slug, ready: null, readyMs: null, dirty: false, saving: false, unsaved: null, file: null,
  folderId: q.get('folder') || null, saves: [], failed: [], control: undefined, guest: false });
const hostLog = (window.hostLog = []);
let me, app, debug = false, unsavedToast = null;

// ---------- Journal (visible seulement en débogage) ----------
function describe(v) {
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength} octets)`;
  if (v instanceof Blob) return `Blob(${v.size} octets)`;
  return JSON.stringify(v);
}
function log(dir, msg, cls = dir) {
  const text = typeof msg === 'string' ? msg : Object.entries(msg).map(([k, v]) => `${k}: ${describe(v)}`).join(', ');
  const t = performance.now() / 1000;
  hostLog.push({ t, dir, text });
  if (!debug) return;
  const li = h('li', { class: cls }, `${t.toFixed(2)}s ${dir === 'in' ? '←' : dir === 'out' ? '→' : '•'} ${text}`);
  $('log').append(li); li.scrollIntoView({ block: 'end' });
}
function send(kind, fields, transfer = []) {
  const msg = { type: `${slug}:${kind}`, ...fields };
  log('out', msg);
  iframe.contentWindow.postMessage(msg, location.origin, transfer);
}

// ---------- En-tête et état ----------
function setStatus() {
  const s = $('status');
  let cls, text;
  if (state.unsaved) { cls = 'error'; text = 'Non sauvegardé'; }
  else if (state.saving) { cls = 'saving'; text = 'Enregistrement…'; }
  else if (state.dirty) { cls = 'dirty'; text = 'Modifications non enregistrées'; }
  else if (state.guest) { cls = ''; text = 'Mode invité : rien n\'est conservé'; }
  else if (state.lastSavedAt) { cls = 'ok'; text = `Enregistré · ${new Date(state.lastSavedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`; }
  else if (state.file) { cls = 'ok'; text = 'Enregistré'; }
  else { cls = ''; text = 'Nouveau document, pas encore enregistré'; }
  s.className = `status ${cls}`;
  $('statusText').textContent = text;
  s.title = text;
}
function setDoc(name, path) {
  $('docName').textContent = name;
  $('docPath').textContent = path ?? '';
  document.title = `${name} · ${app.name}`;
}
async function showFile(file) {
  state.file = file;
  state.folderId = file.folderId;
  const where = ['Mes fichiers', ...(file.path || []).map((p) => p.name)].join(' › ');
  setDoc(file.name, where);
  $('back').href = file.folderId ? `/?folder=${file.folderId}` : '/';
  const u = new URL(location.href);
  u.searchParams.set('file', file.id); u.searchParams.delete('folder');
  history.replaceState(null, '', u);
  setStatus();
}

// ---------- Alerte « fichier non sauvegardé » ----------
function showUnsaved() {
  unsavedToast?.close(); unsavedToast = null;
  if (state.unsaved) {
    unsavedToast = toast({ type: 'error', title: 'Attention : fichier non sauvegardé', closable: true,
      detail: `${state.unsaved.name} : ${state.unsaved.error.replace(/\.$/, '')}. Vos modifications ne sont que dans cet onglet.`,
      actions: [{ label: state.unsaved.retryLabel || 'Réessayer', onClick: () => state.unsaved?.retry() }] });
  }
  setStatus();
}

// ---------- Ouverture ----------
async function openStoredFile(id) {
  $('loadingText').textContent = 'Ouverture du document…';
  try {
    const file = await api(`/api/files/${encodeURIComponent(id)}`);
    const r = await api(`/api/files/${encodeURIComponent(id)}/content`, { raw: true });
    const bytes = await r.arrayBuffer();
    send('open', { name: file.name, bytes }, [bytes]);
    await showFile(file);
    api(`/api/files/${file.id}`, { method: 'PATCH', body: { lastApp: slug } }).catch(() => {});
  } catch (e) {
    toast({ type: 'error', title: 'Impossible d\'ouvrir le document', detail: e.message });
    setDoc('Document introuvable');
  }
}
async function openLocal(f) {
  const bytes = await f.arrayBuffer();
  send('open', { name: f.name, bytes }, [bytes]);
  setDoc(f.name, 'Fichier de l\'ordinateur');
}

// ---------- Enregistrement ----------
async function listFolder(folderId) {
  return api(`/api/fs?folder=${encodeURIComponent(folderId || 'root')}`);
}
// « Enregistrer sous » : le nom est demandé ici (les applications ne le demandent pas dans le navigateur).
function saveAsDialog(suggested) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value: suggested, required: true, maxlength: 255, spellcheck: false });
    const errEl = h('div', { class: 'error-text', role: 'alert' });
    const where = h('div', { class: 'mut' }, 'Dans : …');
    listFolder(state.folderId).then((d) => { where.textContent = `Dans : ${['Mes fichiers', ...d.path.map((p) => p.name)].join(' › ')}`; }).catch(() => {});
    const dlg = dialog({ title: 'Enregistrer sous',
      body: h('div', { class: 'form' }, h('label', { class: 'field' }, 'Nom du fichier', input), where, errEl),
      actions: [h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Annuler'), h('button', { class: 'btn primary', value: 'ok' }, 'Enregistrer')],
      onClose: (v) => resolve(v === 'ok' ? dlg.result : null) });
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'ok') return;
      e.preventDefault();
      const name = input.value.trim();
      const msg = validName(name);
      if (msg) { errEl.textContent = msg; return; }
      if (extOf(name) !== extOf(suggested)) { errEl.textContent = `Gardez l'extension .${extOf(suggested)} : c'est le format produit par l'application.`; return; }
      let replace = false;
      try {
        const d = await listFolder(state.folderId);
        const existing = d.files.find((f) => f.name.toLowerCase() === name.toLowerCase());
        if (existing && existing.id !== state.file?.id) {
          replace = await confirmDialog({ title: 'Remplacer le fichier ?', message: `« ${existing.name} » existe déjà ici. Le remplacer en créera une nouvelle version (l'ancienne reste dans l'historique).`, confirm: 'Remplacer' });
          if (!replace) return;
        }
      } catch {}
      dlg.result = { name, replace };
      dlg.close('ok');
    });
    input.focus();
    const dot = suggested.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot); else input.select();
  });
}

// Décide où vont les octets d'un `save` :
// - Enregistrer sous, ou premier enregistrement d'un nouveau document → nom demandé, nouveau fichier ;
// - même extension que le fichier ouvert → nouvelle version de ce fichier ;
// - autre extension (export PDF/PNG de WordCraft) → fichier à part dans le même dossier (nouvelle version s'il existe).
// Un export ne remplace pas en silence un fichier du même nom : on demande (Remplacer = nouvelle version).
function conflictDialog(name) {
  return new Promise((resolve) => dialog({ title: 'Ce fichier existe déjà',
    body: h('p', {}, `« ${name} » existe déjà dans ce dossier. Le remplacer en crée une nouvelle version (l'ancienne reste dans l'historique).`),
    actions: [h('button', { class: 'btn', value: 'cancel' }, 'Annuler'), h('button', { class: 'btn', value: 'keep' }, 'Garder les deux'),
      h('button', { class: 'btn primary', value: 'replace', autofocus: true }, 'Remplacer')],
    onClose: (v) => resolve(v || 'cancel') }));
}
async function resolveTarget(msg) {
  const exported = async (folderId) => {
    let replace = false;
    try {
      const d = await listFolder(folderId);
      if (d.files.some((f) => f.name.toLowerCase() === msg.name.toLowerCase())) {
        const c = await conflictDialog(msg.name);
        if (c === 'cancel') return { cancel: true };
        replace = c === 'replace';
      }
    } catch {}
    return { kind: 'post', folderId, name: msg.name, replace, adopt: false, exported: true };
  };
  // Export d'un format que l'application n'édite pas (PDF depuis WordCraft…) : jamais adopté comme document courant.
  if (!state.file && !app.extensions.includes(extOf(msg.name))) return exported(state.folderId);
  if (msg.saveAs || !state.file) {
    const r = await saveAsDialog(msg.name);
    if (!r) return null;
    return { kind: 'post', folderId: state.folderId, name: r.name, replace: r.replace, adopt: true };
  }
  if (extOf(msg.name) === extOf(state.file.name)) return { kind: 'put', fileId: state.file.id, name: state.file.name };
  return exported(state.file.folderId);
}
async function store(target, bytes) {
  if (debug && $('simFail').checked) throw new Error('échec simulé (débogage)');
  const headers = { 'X-App': slug };
  if (target.kind === 'put') return api(`/api/files/${target.fileId}/content`, { method: 'PUT', body: bytes, headers });
  headers['X-File-Name'] = encodeURIComponent(target.name);
  return api(`/api/files?folder=${encodeURIComponent(target.folderId || 'root')}${target.replace ? '&replace=1' : ''}`, { method: 'POST', body: bytes, headers });
}
async function saveTo(target, bytes, msg) {
  state.saving = true; setStatus();
  const entry = { name: msg.name, size: bytes.byteLength, id: msg.id, saveAs: msg.saveAs, target: target.kind };
  state.saves.push(entry);
  try {
    const file = await store(target, bytes);
    entry.status = 'ok'; entry.fileId = file.id;
    log('info', `stocké : ${file.name} (${file.versions} version(s))`, 'out');
    state.unsaved = null;
    if (!target.exported) state.lastSavedAt = Date.now();
    if (target.adopt) await showFile(await api(`/api/files/${file.id}`));
    if (target.exported) toast({ title: `Exporté : ${file.name}`, detail: 'Enregistré à côté du document dans vos fichiers.' });
    if (msg.id !== undefined && msg.id !== null) send('saved', { id: msg.id });
  } catch (e) {
    entry.status = 'error'; entry.error = e.message;
    log('info', `échec du stockage : ${e.message}`, 'err');
    state.unsaved = { name: target.name, error: e.message, retry: () => saveTo(target, bytes, msg) };
  } finally {
    state.saving = false;
    showUnsaved();
  }
}
async function onSave(msg) {
  if (!(msg.bytes instanceof ArrayBuffer)) return log('info', 'save sans octets ignoré', 'err');
  if (state.guest) {
    const url = URL.createObjectURL(new Blob([msg.bytes]));
    const a = h('a', { href: url, download: msg.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    toast({ title: `Téléchargé : ${msg.name}`, detail: 'Mode invité : le fichier est dans vos téléchargements.' });
    return;
  }
  const target = await resolveTarget(msg);
  if (target?.cancel) return toast({ title: 'Export annulé', detail: msg.name });
  if (!target) {
    // Enregistrer sous annulé : l'application se croit enregistrée, on le signale.
    state.unsaved = { name: msg.name, error: 'enregistrement annulé', retryLabel: 'Enregistrer…', retry: () => onSave(msg) };
    showUnsaved();
    return;
  }
  await saveTo(target, msg.bytes, msg);
}
async function onHandoff(msg) {
  // Jamais observé en phase 0 ; prévu : ranger le fichier à côté du document et proposer de l'ouvrir.
  const bytes = msg.bytes ?? (msg.file ? await msg.file.arrayBuffer() : null);
  if (!bytes || state.guest) return toast({ type: 'error', title: 'Fichier transmis non pris en charge', detail: msg.name });
  try {
    const f = await store({ kind: 'post', folderId: state.folderId, name: msg.name, replace: false }, bytes);
    const target = me.apps.find((a) => a.extensions.includes(extOf(f.name)));
    toast({ title: `« ${f.name} » enregistré dans vos fichiers`, detail: target ? `Il s'ouvre avec ${target.name}.` : null, timeout: 10000,
      actions: target ? [{ label: `Ouvrir dans ${target.name}`, onClick: () => window.open(`/host.html?app=${target.slug}&file=${f.id}`, '_blank', 'noopener') }] : [] });
    if (target) send('handoff-done', { name: msg.name, app: target.slug });
  } catch (e) { toast({ type: 'error', title: 'Impossible d\'enregistrer le fichier transmis', detail: e.message }); }
}

// ---------- Messages de l'application ----------
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== iframe.contentWindow) return;
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith(`${slug}:`)) return;
  log('in', msg);
  const kind = msg.type.slice(slug.length + 1);
  if (kind === 'ready') {
    state.ready = { ...msg };
    state.readyMs = Math.round(performance.now() - t0);
    $('loading').hidden = true;
    send('host', { version: '1', handoff: !state.guest });
    if (q.get('file') && !state.guest) openStoredFile(q.get('file'));
    if (q.has('control')) waitControl();
    applyAppTheme();
  } else if (kind === 'dirty') {
    state.dirty = !!msg.dirty; setStatus();
  } else if (kind === 'save') {
    onSave(msg);
  } else if (kind === 'failed') {
    state.failed.push({ ...msg });
    $('loading').hidden = true;
    toast({ type: 'error', title: `${app.name} signale une erreur`, detail: String(msg.error ?? '') });
  } else if (kind === 'handoff') {
    onHandoff(msg);
  }
});
// Thème de l'application : elle suit le thème du système, pas celui de la page (color-scheme de l'iframe ignoré,
// vérifié). Quand window.<app> est disponible (WordCraft toujours, PdfCraft avec ?control), on lui applique le
// choix du compte avec sa propre commande.
const THEME_CMD = {
  pdfcraft: (t) => [`view.theme.${t}`],
  wordcraft: (t) => ['view.interfaceTheme', { value: t }],
};
async function applyAppTheme() {
  const cmd = THEME_CMD[slug];
  if (!cmd) return;
  // WordCraft refuse la commande tant qu'aucun document n'est ouvert : on réessaie (jusqu'à 10 min, sans bruit).
  let lastErr;
  for (let i = 0; i < 600; i++) {
    const api = iframe.contentWindow?.[slug];
    if (typeof api?.execute === 'function') {
      try { await api.execute(...cmd(window.craftTheme.get())); log('info', `thème de l'application : ${window.craftTheme.get()}`, 'out'); return; }
      catch (e) { lastErr = e?.message ?? String(e); }
    } else if (i > 100) break; // pas d'API (PdfCraft sans ?control) : l'application suit le système
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (lastErr) log('info', `thème de l'application non appliqué : ${lastErr}`, 'err');
}
async function waitControl() {
  for (let i = 0; i < 200; i++) {
    if (typeof iframe.contentWindow[slug]?.request === 'function') { state.control = true; return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  state.control = false;
}
addEventListener('beforeunload', (e) => { if (state.dirty || state.unsaved) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Démarrage ----------
let t0 = performance.now();
async function main() {
  me = await api('/api/me');
  syncTheme(me);
  state.guest = !!me.guest;
  $('back').append(icon('back'));
  $('account').replaceWith(accountButton(me));
  app = me.apps.find((a) => a.slug === slug);
  if (!app) {
    $('loading').replaceChildren(h('p', {}, 'Cette application n\'est pas disponible pour votre compte.'), h('a', { class: 'btn', href: '/' }, 'Retour'));
    setDoc('Application indisponible'); app = { name: 'Craft' }; return;
  }
  debug = q.has('debug') && me.user?.role === 'admin';
  $('debug').hidden = !debug;
  $('clearLog').onclick = () => { $('log').textContent = ''; };
  $('appTile').replaceWith(appTile(app));
  $('loadingText').textContent = `Chargement de ${app.name}…`;
  if (state.folderId) $('back').href = `/?folder=${encodeURIComponent(state.folderId)}`;
  if (state.guest) {
    $('localOpen').hidden = false;
    $('localFile').accept = app.extensions.map((e) => `.${e}`).join(',');
    $('localFile').onchange = (e) => { const f = e.target.files[0]; if (f) openLocal(f); e.target.value = ''; };
  }
  setDoc(q.get('file') ? 'Ouverture…' : 'Nouveau document');
  setStatus();
  // URL de l'application : ?host=parent, nom de l'auteur pour les commentaires, drapeaux de rendu transmis.
  const src = new URLSearchParams({ host: 'parent' });
  if (me.user) src.set('author', me.user.username);
  for (const f of ['webgl', 'cpu', 'control']) if (q.has(f)) src.append(f, '');
  // Le thème de la page est transmis à l'iframe (prefers-color-scheme suit color-scheme de l'iframe).
  iframe.style.colorScheme = document.documentElement.dataset.theme;
  t0 = performance.now();
  iframe.src = `/apps/${slug}/?${src.toString().replace(/=(&|$)/g, '$1')}`;
  setTimeout(() => { if (!state.ready && !state.failed.length) $('loadingText').textContent = `${app.name} met du temps à démarrer… (premier chargement : environ 15 Mo)`; }, 15000);
}
main().catch((e) => { if (e.status !== 401) toast({ type: 'error', title: 'Chargement impossible', detail: e.message }); });
window.hostApi = { send, openStoredFile, get api() { return iframe.contentWindow[slug]; } };
