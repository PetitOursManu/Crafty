// Page hôte : charge /apps/<slug>/?host=parent&control dans une iframe de même origine, ouvre le fichier demandé,
// remplace la boîte « Ouvrir » de l'application par le sélecteur Crafty, et enregistre chaque `save` dans le bon
// fichier du compte (nouvelle version).
// Constats de la phase 0 (FINDINGS.md) : pas d'`id` dans `save`, donc pas de `saved` ; l'application se croit
// enregistrée dès l'envoi, la page tient donc son propre état « non sauvegardé » et l'affiche (alerte rouge).
import { api, h, icon, toast, dialog, confirmDialog, validName, appTile, extOf, accountButton, syncTheme } from '/ui.js';
import { pickFiles } from '/picker.js';
import { restorePrefs } from '/prefs-sync.js';
import { restoreData } from '/appdata-sync.js';
import { mountAgent } from '/agent.js';
import { hostTools } from '/host-agent.js';
import { mountCalculator } from '/calculator.js';
import { installInterceptors, dropFile } from '/intercept.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const slug = /^[a-z0-9-]+$/.test(q.get('app') || '') ? q.get('app') : null;
const iframe = $('app');
// docs : nom du document dans l'application → fichier Crafty où l'enregistrer (un par document ouvert).
const state = (window.hostState = { slug, ready: null, readyMs: null, dirty: false, saving: false, unsaved: null, file: null,
  folderId: q.get('folder') || null, saves: [], failed: [], control: undefined, guest: false, docs: {}, autosaves: 0,
  picks: 0, blocked: null, themeApplied: false });
const hostLog = (window.hostLog = []);
let me, app, debug = false, unsavedToast = null, prefsSync = null, dataSync = null;

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

// ---------- Formats ----------
// extensions : formats que l'application édite et enregistre ; imports : formats qu'elle sait seulement ouvrir
// (listes vérifiées dans l'attribut accept de leur boîte « Ouvrir »).
// « * » dans imports : tout fichier (Craft Anything).
const opens = (a, name) => [...(a.extensions || []), ...(a.imports || [])].some((e) => e === '*' || e === extOf(name));
const edits = (a, name) => (a.extensions || []).includes(extOf(name));

// ---------- En-tête et état ----------
function setStatus() {
  const s = $('status');
  let cls, text;
  if (state.blocked) { cls = ''; text = 'Format non pris en charge'; }
  else if (state.unsaved) { cls = 'error'; text = 'Non sauvegardé'; }
  else if (state.saving) { cls = 'saving'; text = 'Enregistrement…'; }
  else if (state.dirty) { cls = 'dirty'; text = 'Modifications non enregistrées'; }
  else if (state.maybeDirty) { cls = 'dirty'; text = 'Pensez à enregistrer (Ctrl+S)'; }
  else if (state.guest) { cls = ''; text = 'Mode invité : rien n\'est conservé'; }
  else if (state.lastSavedAt) { cls = 'ok'; text = `${state.lastSaveAuto ? 'Enregistré automatiquement' : 'Enregistré'} · ${new Date(state.lastSavedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`; }
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
const pathText = (file) => ['Mes fichiers', ...(file.path || []).map((p) => p.name)].join(' › ');
// Le document affiché dans l'en-tête devient `file` (dernier ouvert ou enregistré).
async function showFile(file) {
  if (!file.path) file = await api(`/api/files/${file.id}`);
  state.file = file;
  state.folderId = file.folderId;
  setDoc(file.name, pathText(file));
  $('back').href = file.folderId ? `/?folder=${file.folderId}` : '/';
  const u = new URL(location.href);
  u.searchParams.set('file', file.id); u.searchParams.delete('folder');
  history.replaceState(null, '', u);
  setStatus();
}
function track(appName, file) {
  state.docs[appName] = file;
  if (edits(app, file.name)) api(`/api/files/${file.id}`, { method: 'PATCH', body: { lastApp: slug } }).catch(() => {});
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

// ---------- Format non pris en charge : l'application n'est pas chargée ----------
function showBlocked(file) {
  state.blocked = { name: file.name, ext: extOf(file.name) };
  setDoc(file.name, pathText(file));
  $('back').href = file.folderId ? `/?folder=${file.folderId}` : '/';
  const others = me.apps.filter((a) => a.slug !== slug && opens(a, file.name));
  const ext = extOf(file.name);
  $('loading').replaceChildren(h('div', { class: 'blocked', role: 'alert' },
    h('h2', {}, `${app.name} n'ouvre pas les fichiers ${ext ? `.${ext}` : 'sans extension'}`),
    h('p', { class: 'mut' }, `« ${file.name} » ne peut pas être ouvert dans ${app.name}.`,
      others.length ? ' Il s\'ouvre avec :' : ' Aucune de vos applications ne lit ce format ; vous pouvez le télécharger.'),
    h('div', { class: 'blocked-actions' },
      ...others.map((a) => h('a', { class: 'btn primary', href: `/host.html?app=${a.slug}&file=${file.id}` }, appTile(a, 'app-tile mini'), `Ouvrir dans ${a.name}`)),
      others.length ? null : h('a', { class: 'btn primary', href: `/api/files/${file.id}/content`, download: file.name }, icon('download'), 'Télécharger'),
      h('a', { class: 'btn', href: $('back').href }, icon('back'), 'Retour à mes fichiers'))));
  $('loading').hidden = false;
  setStatus();
}

// ---------- Ouverture ----------
async function openStoredFile(file) {
  try {
    const r = await api(`/api/files/${encodeURIComponent(file.id)}/content`, { raw: true });
    const bytes = await r.arrayBuffer();
    send('open', { name: file.name, bytes }, [bytes]);
    track(file.name, file);
    await showFile(file);
    applyAppTheme();
  } catch (e) {
    toast({ type: 'error', title: 'Impossible d\'ouvrir le document', detail: e.message });
    setDoc('Document introuvable');
  }
}
async function openLocal(f) {
  if (!opens(app, f.name)) return toast({ type: 'error', title: 'Format non pris en charge', detail: `${app.name} n'ouvre pas les fichiers .${extOf(f.name) || '?'}` });
  const bytes = await f.arrayBuffer();
  send('open', { name: f.name, bytes }, [bytes]);
  setDoc(f.name, 'Fichier de l\'ordinateur');
  applyAppTheme();
}

// ---------- « Ouvrir » de l'application → sélecteur Crafty ----------
// Les deux applications ouvrent leur boîte de fichiers par click() sur un <input type="file"> (vérifié), avec la liste
// des formats dans accept. Sur la fenêtre de l'iframe (même origine, fichiers de l'application intacts), on remplace
// ce click() : le sélecteur Crafty s'ouvre, puis les fichiers choisis sont remis à l'élément comme si l'utilisateur
// les avait pris sur son disque (DataTransfer + événement change). Annuler envoie l'événement cancel.
function installPicker() {
  const w = iframe.contentWindow;
  if (state.guest || !w?.HTMLInputElement) return;
  installInterceptors(w, {
    pickInput: pickForInput,
    pickHandles,
    // Téléchargement capté (application sans pont, ou export de PdfCraft) : traité comme un save de l'application.
    saveFile: async (name, blob) => { log('info', `téléchargement capté : ${name} (${blob.size} octets)`, 'out');
      // Pendant un enregistrement par l'API, l'application télécharge aussi le fichier (EffectCraft, vérifié) : déjà pris.
      if (apiSaving) return log('info', 'téléchargement ignoré : enregistrement par l\'API en cours', 'out');
      // Copie dans le royaume de la page : un ArrayBuffer de l'iframe échoue aux tests instanceof d'ici.
      onSave({ name, bytes: new Uint8Array(await blob.arrayBuffer()).slice().buffer, saveAs: false, captured: true }); },
    saveLost: (name) => toast({ type: 'error', title: 'Enregistrement non capté', detail: `${name} : le fichier n'a pas pu être récupéré.` }),
  });
}
// showOpenFilePicker (FilmCraft…) : mêmes fichiers Crafty, rendus sous forme de « poignées ».
async function pickHandles(opts = {}) {
  const w = iframe.contentWindow;
  if (autoPick) { // réouverture par Ctrl+O simulé (SolidCraft : Ctrl+O passe par showOpenFilePicker, vérifié)
    const f = autoPick; autoPick = null;
    const buf = await (await api(`/api/files/${f.id}/content`, { raw: true })).arrayBuffer();
    return [new w.File([buf], f.name, { lastModified: f.updatedAt })];
  }
  const exts = [...new Set((opts.types || []).flatMap((t) => Object.values(t.accept || {}).flat())
    .map((e) => String(e).replace(/^./, '').toLowerCase()).filter((e) => /^[a-z0-9]+$/.test(e)))];
  state.picks++;
  const files = await pickFiles({ title: 'Ouvrir', exts, multiple: !!opts.multiple, folderId: state.folderId, appName: app.name });
  if (!files?.length) return null;
  const out = [];
  for (const f of files) {
    const buf = await (await api(`/api/files/${f.id}/content`, { raw: true })).arrayBuffer();
    out.push(new w.File([buf], f.name, { lastModified: f.updatedAt }));
    track(f.name, f);
  }
  if (files.length === 1 && edits(app, files[0].name)) await showFile(files[0]);
  return out;
}
// Boîte « Ouvrir » (son accept contient le format principal de l'application ; boîte multiple seulement si le registre
// le dit : control.openMultiple, CadCraft) : le champ est annulé et chaque document part par le message `open` du pont,
// comme depuis l'explorateur ; l'application le traite alors comme le fichier de la page (vérifié : DeckCraft considère
// un fichier pris dans son champ comme un nouveau fichier, et Ctrl+S redemandait un nom). Autres boîtes (insérer une
// image, des pages…) : les fichiers sont remis au champ.
let autoPick = null; // fichier à remettre sans afficher le sélecteur (ouverture déclenchée par la page)
async function pickForInput(input) {
  const w = iframe.contentWindow;
  if (autoPick) {
    const f = autoPick; autoPick = null;
    log('info', `réouverture : fichier remis au champ de l'application (${f.name})`, 'out');
    const buf = await (await api(`/api/files/${f.id}/content`, { raw: true })).arrayBuffer();
    // Pas de remise immédiate : une application peut brancher son écouteur `change` juste après click()
    // (SolidCraft ignorait un fichier remis sans délai).
    await new Promise((r) => setTimeout(r, 300));
    const dt = new w.DataTransfer();
    dt.items.add(new w.File([buf], f.name, { lastModified: f.updatedAt }));
    input.files = dt.files;
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    return;
  }
  const exts = (input.accept || '').split(',').map((s) => s.trim().replace(/^./, '').toLowerCase()).filter((s) => /^[a-z0-9]+$/.test(s));
  // Sans pont (mode interception), pas de message open : le fichier est toujours remis au champ.
  const isOpen = !intercept() && exts.includes(app.extensions?.[0]) && (!input.multiple || !!app.control?.openMultiple);
  state.picks++;
  log('info', `boîte « Ouvrir » de l'application : accept=${input.accept} multiple=${input.multiple} (${isOpen ? 'ouverture' : 'insertion'})`, 'out');
  const files = await pickFiles({ title: isOpen ? 'Ouvrir' : 'Choisir des fichiers', exts: [...new Set(exts)], multiple: input.multiple,
    folderId: state.folderId, appName: app.name });
  if (!files?.length || isOpen) input.dispatchEvent(new w.Event('cancel', { bubbles: true }));
  if (!files?.length) return;
  try {
    if (isOpen) {
      for (const f of files) await openStoredFile(f);
      return;
    }
    const dt = new w.DataTransfer();
    for (const f of files) {
      const buf = await (await api(`/api/files/${f.id}/content`, { raw: true })).arrayBuffer();
      dt.items.add(new w.File([buf], f.name, { lastModified: f.updatedAt }));
      track(f.name, f);
    }
    input.files = dt.files;
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    if (intercept() && files.length === 1 && edits(app, files[0].name)) { state.maybeDirty = false; await showFile(files[0]); }
  } catch (e) {
    toast({ type: 'error', title: 'Impossible de transmettre le fichier', detail: e.message });
    if (!isOpen) input.dispatchEvent(new w.Event('cancel', { bubbles: true }));
  }
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
// Un export ne remplace pas en silence un fichier du même nom : on demande (Remplacer = nouvelle version).
function conflictDialog(name) {
  return new Promise((resolve) => dialog({ title: 'Ce fichier existe déjà',
    body: h('p', {}, `« ${name} » existe déjà dans ce dossier. Le remplacer en crée une nouvelle version (l'ancienne reste dans l'historique).`),
    actions: [h('button', { class: 'btn', value: 'cancel' }, 'Annuler'), h('button', { class: 'btn', value: 'keep' }, 'Garder les deux'),
      h('button', { class: 'btn primary', value: 'replace', autofocus: true }, 'Remplacer')],
    onClose: (v) => resolve(v || 'cancel') }));
}
// Où vont les octets d'un `save` :
// - format que l'application n'édite pas (PDF ou PNG depuis WordCraft) → export, à côté du document ;
// - Enregistrer sous → nom demandé, nouveau fichier qui devient le document ;
// - document connu (ouvert depuis Crafty, ou déjà enregistré) → nouvelle version de son fichier ;
// - document inconnu (nouveau, ou ouvert depuis l'ordinateur) → nom demandé. Pendant une sauvegarde automatique, on
//   ne surgit pas avec une boîte de dialogue : on le signale (« Enregistrer… »).
async function resolveTarget(msg, { auto = false } = {}) {
  if (!edits(app, msg.name)) {
    const folderId = state.folderId;
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
  }
  const known = state.docs[msg.name];
  if (known && !msg.saveAs) return { kind: 'put', fileId: known.id, name: known.name, doc: known, auto };
  if (auto) return { defer: true };
  const r = await saveAsDialog(msg.name);
  return r ? { kind: 'post', folderId: state.folderId, name: r.name, replace: r.replace, adopt: true } : null;
}
async function store(target, bytes) {
  if (debug && $('simFail').checked) throw new Error('échec simulé (débogage)');
  const headers = { 'X-App': slug };
  if (target.auto) headers['X-Autosave'] = '1';
  if (target.kind === 'put') return api(`/api/files/${target.fileId}/content`, { method: 'PUT', body: bytes, headers });
  headers['X-File-Name'] = encodeURIComponent(target.name);
  return api(`/api/files?folder=${encodeURIComponent(target.folderId || 'root')}${target.replace ? '&replace=1' : ''}`, { method: 'POST', body: bytes, headers });
}
async function saveTo(target, bytes, msg) {
  state.saving = true; setStatus();
  const entry = { name: msg.name, size: bytes.byteLength, id: msg.id, saveAs: msg.saveAs, target: target.kind, auto: !!target.auto };
  state.saves.push(entry);
  try {
    const file = await store(target, bytes);
    entry.status = 'ok'; entry.fileId = file.id;
    log('info', `stocké : ${file.name} (${file.versions} version(s))`, 'out');
    dataSync?.flush();
    state.unsaved = null;
    if (!target.exported) { state.lastSavedAt = Date.now(); state.lastSaveAuto = !!target.auto; state.maybeDirty = false; }
    if (target.auto) state.autosaves++;
    if (target.adopt) track(msg.name, file);
    if (!target.exported && file.id !== state.file?.id) await showFile(file);
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
  // Un save qui arrive juste après notre commande d'enregistrement est la sauvegarde automatique.
  const auto = !!autoPending && Date.now() - autoPending < 15_000 && !msg.saveAs;
  autoPending = 0;
  const target = await resolveTarget(msg, { auto });
  if (target?.cancel) return toast({ title: 'Export annulé', detail: msg.name });
  if (!target || target.defer) {
    // Nom refusé, ou document jamais enregistré pendant une sauvegarde automatique : l'application se croit
    // enregistrée, on le signale et on propose d'enregistrer.
    state.unsaved = { name: msg.name, error: target?.defer ? 'ce document n\'est pas encore dans vos fichiers' : 'enregistrement annulé',
      retryLabel: 'Enregistrer…', retry: () => onSave({ ...msg, bytes: msg.bytes.slice(0) }) };
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
    const target = me.apps.find((a) => edits(a, f.name));
    toast({ title: `« ${f.name} » enregistré dans vos fichiers`, detail: target ? `Il s'ouvre avec ${target.name}.` : null, timeout: 10000,
      actions: target ? [{ label: `Ouvrir dans ${target.name}`, onClick: () => window.open(`/host.html?app=${target.slug}&file=${f.id}`, '_blank', 'noopener') }] : [] });
    if (target) send('handoff-done', { name: msg.name, app: target.slug });
  } catch (e) { toast({ type: 'error', title: 'Impossible d\'enregistrer le fichier transmis', detail: e.message }); }
}

// ---------- Messages de l'application ----------
let pendingOpen = null;
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== iframe.contentWindow) return;
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith(`${slug}:`)) return;
  log('in', msg);
  const kind = msg.type.slice(slug.length + 1);
  if (kind === 'ready') {
    state.ready = { ...msg };
    send('host', { version: '1', handoff: !state.guest });
    onAppReady();
  } else if (kind === 'dirty') {
    state.dirty = !!msg.dirty; setStatus();
    if (state.dirty) { scheduleAutosave(); if (!state.themeApplied) applyAppTheme(); } else clearTimeout(autosaveTimer);
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

// Démarrage commun : pont (message ready) ou interception (chargement de l'iframe, canvas présent).
function onAppReady() {
  state.readyMs = Math.round(performance.now() - t0);
  $('loading').hidden = true;
  installPicker();
  if (pendingOpen) (intercept() ? openByDrop(pendingOpen) : openStoredFile(pendingOpen));
  watchInput();
  waitControl();
  applyAppTheme();
}
// Mode interception : l'application n'a pas de pont. Prête quand son wasm est initialisé : window.wasmBindings (pages
// générées par trunk, vérifié sur six) ou son API window.<app> (EffectCraft), puis un court délai pour la première
// image. Au-delà de 90 s (SolidCraft : wasm de 167 Mo, plus de 25 s au premier chargement), prête dès que son canvas est là ; abandon après 3 min.
const intercept = () => app?.mode === 'intercept';
async function waitInterceptReady() {
  for (let i = 0; i < 1800; i++) { // 3 min : premier chargement sur un réseau lent
    const w = iframe.contentWindow, d = iframe.contentDocument;
    const started = w && (w.wasmBindings || typeof w[slug]?.request === 'function');
    if (started || (i > 900 && d?.querySelector('canvas'))) {
      await new Promise((r) => setTimeout(r, 2000));
      state.ready = { mode: 'intercept', signal: started ? 'wasm' : 'canvas' };
      return onAppReady();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  state.failed.push({ error: 'application non démarrée en 3 min' });
  $('loadingText').textContent = `${app.name} ne démarre pas.`;
}
// Ouvrir un fichier stocké sans message open : glisser-déposer simulé sur l'application.
async function openByDrop(file) {
  try {
    const w = iframe.contentWindow;
    const buf = await (await api(`/api/files/${encodeURIComponent(file.id)}/content`, { raw: true })).arrayBuffer();
    if (typeof app.control?.open === 'object') {
      // Réouverture par l'API de l'application (VectorCraft : document.open {name, dataBase64}, vérifié).
      const a = w[slug];
      if (typeof a?.execute !== 'function') throw new Error("l'API de l'application n'est pas disponible");
      // EffectCraft : son système de fichiers en mémoire reçoit le fichier par addFile(url, nom), puis file.open {path}.
      const c = app.control.open, vars = { '{name}': file.name };
      if (JSON.stringify(c.params || {}).includes('{base64}')) vars['{base64}'] = toB64(buf);
      if (c.fetch) vars['{path}'] = await a[c.fetch](`/api/files/${encodeURIComponent(file.id)}/content`, file.name);
      await apiCall(a, c, vars);
      apiPath = vars['{path}'] || null;
    } else if (app.control?.open === 'keys') {
      // Ctrl+O simulé : l'application ouvre sa boîte, pickForInput y remet ce fichier. L'application ne prend les
      // touches qu'une fois son interface prête et son canvas focalisé (vérifié) : on réessaie toutes les 2 s, 30 s au plus.
      // Sans geste de l'utilisateur, la bibliothèque rfd n'appelle pas click() : elle affiche sa fenêtre HTML de repli
      // (#rfd-overlay : champ fichier, Ok, Cancel ; vérifié avec TextureCraft). On y remet le fichier et on valide.
      autoPick = file;
      const viaOverlay = async () => {
        const ov = w.document.getElementById('rfd-overlay');
        const input = ov?.querySelector('input[type=file]');
        if (!input) return false;
        autoPick = null;
        const dt = new w.DataTransfer();
        dt.items.add(new w.File([buf], file.name, { lastModified: file.updatedAt }));
        input.files = dt.files;
        input.dispatchEvent(new w.Event('change', { bubbles: true }));
        log('info', `réouverture : fenêtre de repli de l'application remplie (${file.name})`, 'out');
        [...ov.querySelectorAll('button')].find((b) => /^ok$/i.test(b.textContent.trim()))?.click();
        return true;
      };
      // Une application occupée (TextureCraft calcule ses textures au démarrage) met les touches en attente et les traite
      // toutes d'un coup (vérifié : six fenêtres empilées) : chaque essai attend que ses images s'enchaînent de nouveau.
      const fluid = () => new Promise((r) => {
        let n = 0; const t0 = performance.now();
        const f = () => (++n >= 10 ? r(performance.now() - t0 < 1500) : w.requestAnimationFrame(f)); // ≥ 7 images/s
        w.requestAnimationFrame(f);
      });
      const until = Date.now() + 120_000;
      for (let i = 0; i < 6 && autoPick === file && Date.now() < until; i++) {
        while (Date.now() < until && !(await fluid())) await new Promise((r) => setTimeout(r, 250));
        if (await viaOverlay()) break;
        log('info', `réouverture : Ctrl+O simulé (essai ${i + 1})`, 'out');
        const target = w.document.querySelector('canvas') || w.document.body;
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '0');
        target.focus?.();
        for (const type of ['keydown', 'keyup']) {
          target.dispatchEvent(new w.KeyboardEvent(type, { key: 'o', code: 'KeyO', keyCode: 79, which: 79, ctrlKey: true, bubbles: true, cancelable: true }));
        }
        for (let t = 0; t < 50 && autoPick === file; t++) { // 5 s
          if (await viaOverlay()) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (autoPick === file) { autoPick = null; toast({ type: 'error', title: "Impossible d'ouvrir le document", detail: `${app.name} n'a pas ouvert sa boîte Ouvrir.` }); return; }
    } else dropFile(w, new w.File([buf], file.name, { lastModified: file.updatedAt }));
    track(file.name, file);
    state.maybeDirty = false;
    state.reopened = file.id;
    await showFile(file);
  } catch (e) { toast({ type: 'error', title: "Impossible d'ouvrir le document", detail: e.message }); }
}
// ---------- Assistant IA : pilotage et enregistrement ----------
const agentApi = () => { const a = iframe.contentWindow?.[slug]; return !!state.ready && typeof a?.commands === 'function' && typeof a?.execute === 'function'; };
// Enregistrer pour l'assistant : commande de l'application (pont), API (control.saveData), sinon Ctrl+S simulé.
// Attend l'issue jusqu'à 20 s ; un nouveau document attend son nom dans la boîte « Enregistrer sous ».
async function agentSave() {
  if (state.guest) throw new Error("mode invité : rien n'est conservé");
  if (!state.ready) throw new Error("l'application n'est pas encore prête");
  const n = state.saves.length, a = iframe.contentWindow?.[slug];
  if (intercept() && app.control?.saveData) saveByApi();
  else if (!intercept() && typeof a?.execute === 'function') await saveCall(a);
  else {
    const w = iframe.contentWindow, target = w.document.querySelector('canvas') || w.document.body;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '0');
    target.focus?.();
    for (const type of ['keydown', 'keyup']) target.dispatchEvent(new w.KeyboardEvent(type, { key: 's', code: 'KeyS', keyCode: 83, which: 83, ctrlKey: true, bubbles: true, cancelable: true }));
  }
  for (let i = 0; i < 100 && !(state.saves.length > n && state.saves.at(-1).status); i++) await new Promise((r) => setTimeout(r, 200));
  if (state.saves.length === n) return { pending: true, note: document.querySelector('dialog[open]') ? "l'utilisateur doit choisir un nom dans la boîte « Enregistrer sous »" : 'enregistrement demandé, pas encore reçu' };
  const last = state.saves.at(-1);
  return { status: last.status, name: state.file?.name || last.name, error: last.error };
}
// Ctrl+S tenu par Crafty (control.saveData, VectorCraft) : l'application sérialise le document par son API, sans sa boîte
// « Enregistrer sous » (son document rouvert n'a pas de chemin dans un navigateur : chaque Ctrl+S la rouvrait, vérifié),
// et l'enregistrement va au fichier Crafty ouvert. Ctrl+Maj+S reste à l'application (capté comme téléchargement).
let apiSaving = false; // vrai pendant saveByApi (téléchargements de l'application ignorés)
let apiPath = null; // chemin du document dans le système de fichiers en mémoire de l'application (EffectCraft)
async function saveByApi() {
  const c = app.control.saveData, a = iframe.contentWindow?.[slug];
  if (typeof a?.execute !== 'function') return;
  try {
    let name = docName();
    if (!name && c.title) name = (await apiCall(a, c.title, {}).catch(() => null))?.[c.title.field || 'title']; // nouveau document : son titre
    name = String(name || 'document').replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.[a-z0-9]+$/i.test(name)) name = `${name}.${app.extensions?.[0]}`;
    const path = apiPath || `/${name}`;
    apiSaving = true;
    const r = await apiCall(a, c, { '{name}': name, '{path}': path }).finally(() => setTimeout(() => { apiSaving = false; }, 1500));
    let bytes;
    if (c.read) { // l'application écrit dans son système de fichiers : on relit le fichier (copie dans ce contexte-ci)
      apiPath = r?.path || path;
      bytes = new Uint8Array(await a[c.read](apiPath)).buffer;
    } else {
      const b64 = r?.[c.field || 'dataBase64'];
      if (typeof b64 !== 'string') throw new Error(r?.pending ? `l'application attend : ${r.pending}` : 'pas de contenu rendu');
      bytes = fromB64(b64);
    }
    log('info', `enregistrement par l'API : ${name} (${bytes.byteLength} octets)`, 'out');
    await onSave({ name, bytes, saveAs: false, captured: true });
  } catch (e) { toast({ type: 'error', title: "Impossible d'enregistrer", detail: e?.message ?? String(e) }); }
}
// Sans pont, l'état « modifié » est inconnu : une frappe ou un clic dans l'application depuis le dernier enregistrement
// est compté comme une modification possible (avertissement avant de quitter).
function watchInput() {
  if (!intercept() || state.guest || !app.extensions?.length) return; // sans format édité (Craft Anything) : rien à enregistrer
  const d = iframe.contentDocument;
  if (app.control?.saveData) {
    iframe.contentWindow.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !/^[sS]$/.test(e.key)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === 'keydown' && !e.repeat) saveByApi();
    }, true);
    for (const t of ['keyup', 'keypress']) iframe.contentWindow.addEventListener(t, (e) => {
      if ((e.ctrlKey || e.metaKey) && /^[sS]$/.test(e.key)) e.stopImmediatePropagation();
    }, true);
  }
  const mark = (e) => {
    if (e.type === 'keydown' && (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta' || ((e.ctrlKey || e.metaKey) && /^[sS]$/.test(e.key)))) return;
    if (!state.maybeDirty) { state.maybeDirty = true; setStatus(); }
  };
  d.addEventListener('keydown', mark, true);
  d.addEventListener('pointerdown', mark, true);
}

// ---------- Thème de l'application ----------
// Elle suit le thème du système, pas celui de la page (color-scheme de l'iframe ignoré, vérifié). On lui applique le
// choix du compte avec sa propre commande via window.<app> (?control, décision du 14/11/2026). WordCraft refuse
// tant qu'aucun document n'est ouvert : quelques essais courts, puis on réessaie à l'ouverture d'un document ou à la
// prochaine modification (pas de boucle de fond). Commandes par application dans apps.json (control.theme) ; une
// application sans « system » (DeckCraft) reçoit clair ou sombre selon le système.
function themeCommand() {
  const t = app.control?.theme;
  if (!t) return null;
  const choice = window.craftTheme.get();
  const resolved = choice === 'system' && !t.system ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice;
  return t[resolved] || null;
}
let themeRun = 0;
async function applyAppTheme() {
  const cmd = themeCommand();
  if (!cmd || !state.ready) return;
  const run = ++themeRun;
  for (let i = 0; i < 5 && run === themeRun; i++) {
    const a = iframe.contentWindow?.[slug];
    if (typeof a?.execute === 'function') {
      try {
        await a.execute(...cmd);
        state.themeApplied = true;
        log('info', `thème de l'application : ${window.craftTheme.get()}`, 'out');
        return;
      } catch (e) { log('info', `thème de l'application refusé : ${e?.message ?? e}`, 'err'); }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
addEventListener('craft-theme-change', () => { state.themeApplied = false; applyAppTheme(); });

// ---------- Sauvegarde automatique ----------
// Sur dirty:true, après le délai réglé par l'admin (me.autosave, en secondes), la commande d'enregistrement de
// l'application (apps.json control.save : file.save, qsave pour CadCraft) : l'application
// envoie un save sans boîte de dialogue (vérifié en phase 0). Seulement si un document de l'onglet est déjà stocké.
// Un onglet masqué ne répond pas : on relance au retour au premier plan.
// control.save (apps.json) : un id de commande (execute), { command, params } ou { request, params } ; dans params,
// « {name} » devient le nom du document actif dans l'application. Vérifié : FigCraft refuse file.save sur un document
// ouvert par la page (ui.key Ctrl+S à la place) ; CadCraft refuse qsave sans path (qsave {path: nom}).
// Paramètres de commande du registre : « {name} » (nom du document), « {base64} » (contenu du fichier).
function ctlParams(params, vars) {
  const walk = (v) => typeof v === 'string' ? (v in vars ? vars[v] : v.replaceAll('{name}', vars['{name}'] ?? ''))
    : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(params || {});
}
const toB64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
const docName = () => Object.keys(state.docs).find((k) => state.docs[k].id === state.file?.id) || state.file?.name || '';
const apiCall = (a, c, vars) => (c.request ? a.request(c.request, ctlParams(c.params, vars)) : a.execute(c.command, ctlParams(c.params, vars)));

function saveCall(a) {
  const save = app.control?.save || 'file.save';
  if (typeof save === 'string') return a.execute(save);
  const name = Object.keys(state.docs).find((k) => state.docs[k].id === state.file?.id) || state.file?.name || '';
  const params = JSON.parse(JSON.stringify(save.params || {}).replaceAll('{name}', name.replace(/["\\]/g, '')));
  return save.request ? a.request(save.request, params) : a.execute(save.command, params);
}
let autosaveTimer = null, autoPending = 0, autoFailures = 0;
function scheduleAutosave(delay = (me?.autosave ?? 0) * 1000) {
  clearTimeout(autosaveTimer);
  if (!delay || state.guest || !Object.keys(state.docs).length) return;
  autosaveTimer = setTimeout(runAutosave, delay * 4 ** Math.min(autoFailures, 3)); // ralenti après un échec
}
async function runAutosave() {
  if (!state.dirty || state.saving || document.querySelector('dialog[open]')) return state.dirty && scheduleAutosave();
  if (document.visibilityState === 'hidden') return; // relancé par visibilitychange
  const a = iframe.contentWindow?.[slug];
  if (typeof a?.execute !== 'function') return;
  autoPending = Date.now();
  log('info', 'sauvegarde automatique', 'out');
  try {
    await saveCall(a);
    autoFailures = 0;
  } catch (e) {
    autoPending = 0;
    autoFailures++;
    log('info', `sauvegarde automatique : ${e?.message ?? e}`, 'err');
    if (autoFailures <= 3) scheduleAutosave();
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.dirty) scheduleAutosave(3000); });

async function waitControl() {
  for (let i = 0; i < 200; i++) {
    if (typeof iframe.contentWindow[slug]?.request === 'function') { state.control = true; return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  state.control = false;
}
addEventListener('beforeunload', (e) => { if (state.dirty || state.unsaved || state.maybeDirty) { e.preventDefault(); e.returnValue = ''; } });

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
    $('localFile').accept = (app.imports || []).includes('*') ? '' : [...app.extensions, ...(app.imports || [])].map((e) => `.${e}`).join(',');
    $('localFile').onchange = (e) => { const f = e.target.files[0]; if (f) openLocal(f); e.target.value = ''; };
  }
  // Document demandé : vérifié avant de charger l'application (un format qu'elle ne lit pas n'est jamais envoyé).
  if (q.get('file') && !state.guest) {
    setDoc('Ouverture…');
    try { pendingOpen = await api(`/api/files/${encodeURIComponent(q.get('file'))}`); }
    catch (e) {
      $('loading').replaceChildren(h('div', { class: 'blocked', role: 'alert' }, h('h2', {}, 'Document introuvable'),
        h('p', { class: 'mut' }, e.message), h('div', { class: 'blocked-actions' }, h('a', { class: 'btn', href: '/' }, icon('back'), 'Retour à mes fichiers'))));
      setDoc('Document introuvable'); return;
    }
    if (!opens(app, pendingOpen.name)) return showBlocked(pendingOpen);
    setDoc(pendingOpen.name, pathText(pendingOpen));
    $('back').href = pendingOpen.folderId ? `/?folder=${pendingOpen.folderId}` : '/';
  } else setDoc('Nouveau document');
  setStatus();
  // Réglages de l'application du compte remis dans le navigateur avant son chargement (prefs-sync.js).
  try { prefsSync = await restorePrefs(me, app); } catch (e) { log('info', `réglages non restaurés : ${e.message}`, 'err'); }
  window.craftPrefsFlush = () => prefsSync?.flush();
  // Données de l'application gardées dans le navigateur (app.data) : celles de ce compte (appdata-sync.js).
  window.craftDataFlush = () => dataSync?.flush();
  try { dataSync = await restoreData(me, app, (m) => log('info', m, 'out')); }
  catch (e) { log('info', `données non restaurées : ${e.message}`, 'err'); toast({ type: 'error', title: "Données de l'application non restaurées", detail: e.message }); }
  // URL de l'application : ?host=parent, nom de l'auteur pour les commentaires, ?control, drapeaux de rendu.
  // Mode interception : pas de ?host=parent (l'application n'a pas de pont).
  const src = new URLSearchParams(intercept() ? {} : { host: 'parent' });
  if (me.user) src.set('author', me.user.username);
  src.append('control', ''); // window.<app> : thème et sauvegarde automatique
  for (const f of ['webgl', 'cpu']) if (q.has(f)) src.append(f, '');
  t0 = performance.now();
  iframe.src = `/apps/${slug}/?${src.toString().replace(/=(&|$)/g, '$1')}`;
  if (intercept()) waitInterceptReady();
  if ((app.tools || []).includes('calculator')) mountCalculator($('calcBtn'));
  if (!state.guest) mountAgent({ button: $('agentBtn'), context: () => ({ page: 'app', app: slug, appName: app.name, document: state.file?.name || null, hasApi: agentApi() }), tools: hostTools({
    slug, appName: app.name, api: () => iframe.contentWindow?.[slug], hasApi: agentApi, docName: () => state.file?.name || '', file: () => state.file,
    status: () => $('statusText').textContent, save: agentSave,
    touched: () => { if (intercept() && !state.maybeDirty) { state.maybeDirty = true; setStatus(); } },
    renamed: async () => { const f = await api(`/api/files/${state.file.id}`); for (const k of Object.keys(state.docs)) if (state.docs[k].id === f.id) state.docs[k] = f; state.docs[f.name] = f; await showFile(f); },
  }) }).catch(() => {});
  setTimeout(() => { if (!state.ready && !state.failed.length && !state.blocked) $('loadingText').textContent = `${app.name} met du temps à démarrer… (premier chargement : environ 15 Mo)`; }, 15000);
}
main().catch((e) => { if (e.status !== 401) toast({ type: 'error', title: 'Chargement impossible', detail: e.message }); });
window.hostApi = { send, openStoredFile, get api() { return iframe.contentWindow[slug]; } };
