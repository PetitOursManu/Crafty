// Page hôte du prototype : charge /apps/<slug>/?host=parent dans une iframe de même origine,
// journalise chaque message, stocke les sauvegardes via /api/echo et répond `saved`.
const q = new URLSearchParams(location.search);
const slug = /^[a-z0-9-]+$/.test(q.get('app') || '') ? q.get('app') : 'pdfcraft';
const $ = (id) => document.getElementById(id);
const iframe = $('app');
const EDITORS = { pdf: 'pdfcraft', docx: 'wordcraft', odt: 'wordcraft', rtf: 'wordcraft', md: 'wordcraft', txt: 'wordcraft' };

// État lisible par un test automatique (Playwright) : window.hostState / window.hostLog.
const state = (window.hostState = { slug, ready: null, readyMs: null, dirty: null, saves: [], failed: [], handoffs: [], lastId: null });
const hostLog = (window.hostLog = []);
const lastKey = `craft-host:last:${slug}`;
try { state.lastId = localStorage.getItem(lastKey); } catch {}

document.title = `${slug} · craft-host phase 0`;
$('title').textContent = slug;
showLast();

function describe(v) {
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength} octets)`;
  if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.byteLength} octets)`;
  if (v instanceof Blob) return `${v.constructor.name}(${v.size} octets${v.name ? `, ${v.name}` : ''})`;
  return JSON.stringify(v);
}
function log(dir, msg, cls = dir) {
  const t = (performance.now() / 1000).toFixed(2);
  const fields = typeof msg === 'string' ? msg
    : Object.entries(msg).map(([k, v]) => `${k}: ${describe(v)}`).join(', ');
  hostLog.push({ t: Number(t), dir, text: fields, keys: typeof msg === 'object' ? Object.keys(msg) : [] });
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = `${t}s ${dir === 'in' ? '←' : dir === 'out' ? '→' : '•'} ${fields}`;
  $('log').append(li);
  li.scrollIntoView({ block: 'end' });
}
function pill(id, text, cls) { $(id).textContent = text; $(id).className = `pill ${cls || ''}`; }
function showLast() { $('lastSave').textContent = state.lastId ? `dernière : ${state.lastId.slice(0, 8)}…` : ''; }
function send(kind, fields, transfer = []) {
  const msg = { type: `${slug}:${kind}`, ...fields };
  log('out', msg);
  iframe.contentWindow.postMessage(msg, location.origin, transfer);
}

// Construction de l'URL de l'application : ?host=parent + drapeaux transmis tels quels.
const src = new URLSearchParams({ host: 'parent' });
for (const f of ['webgl', 'cpu', 'control']) if (q.has(f)) src.append(f, q.get(f));
if (q.get('author')) src.set('author', q.get('author'));
const appUrl = `/apps/${slug}/?${src.toString().replace(/=(&|$)/g, '$1')}`;
const t0 = performance.now();
log('info', `iframe ${appUrl}`, 'out');
iframe.src = appUrl;

window.addEventListener('message', async (event) => {
  if (event.origin !== location.origin || event.source !== iframe.contentWindow) return;
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return log('in', `message sans type : ${describe(msg)}`, 'err');
  log('in', msg);
  const kind = msg.type.startsWith(`${slug}:`) ? msg.type.slice(slug.length + 1) : null;
  switch (kind) {
    case 'ready':
      state.ready = { ...msg };
      state.readyMs = Math.round(performance.now() - t0);
      pill('status', `ready en ${state.readyMs} ms · v${msg.appVersion ?? msg.version}`, 'ok');
      $('asBlob').disabled = msg.file !== true;
      send('host', q.has('handoff') ? { version: '1', handoff: true } : { version: '1' });
      if (q.get('open')) openFromServer(q.get('open'));
      if (q.has('control')) waitControl();
      break;
    case 'dirty':
      state.dirty = msg.dirty;
      showUnsaved();
      break;
    case 'failed':
      state.failed.push({ ...msg });
      pill('status', `failed : ${msg.error}`, 'err');
      break;
    case 'save': return onSave(msg);
    case 'handoff': return onHandoff(msg);
    default: log('info', `type non documenté : ${msg.type}`, 'err');
  }
});

async function store(name, body) {
  const r = await fetch(`/api/echo${$('fail').checked ? '?fail=1' : ''}`, {
    method: 'POST', body, headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
  });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
}

// L'application se déclare enregistrée dès qu'elle a envoyé `save`, même si le stockage échoue (FINDINGS.md § 3) :
// la page hôte garde donc son propre état « non sauvegardé » et l'affiche dans une alerte rouge.
state.unsaved = null; // { name, bytes, error } du dernier save non stocké
function showUnsaved() {
  const u = state.unsaved;
  $('toast').hidden = !u;
  if (u) $('toastDetail').textContent = `${u.name} : ${u.error}. Vos modifications ne sont que dans cet onglet.`;
  if (u) pill('dirty', 'non sauvegardé', 'err');
  else if (state.dirty !== null) pill('dirty', state.dirty ? 'modifié' : 'enregistré', state.dirty ? 'warn' : 'ok');
}

async function storeSave(name, bytes, entry = {}) {
  let r;
  try { r = await store(name, bytes); } catch (e) { r = { ok: false, status: 0, error: String(e) }; }
  entry.status = r.status; entry.echoId = r.json?.id; entry.sha256 = r.json?.sha256;
  log('info', `POST /api/echo → ${r.status} ${r.json ? JSON.stringify(r.json) : r.error || ''}`, r.ok ? 'out' : 'err');
  if (r.ok) {
    state.unsaved = null;
    state.lastId = r.json.id;
    try { localStorage.setItem(lastKey, r.json.id); } catch {}
    showLast();
  } else {
    state.unsaved = { name, bytes, error: r.status ? `le serveur a répondu ${r.status}` : 'serveur injoignable' };
  }
  showUnsaved();
  return r.ok;
}

async function onSave(msg) {
  const entry = { name: msg.name, size: msg.bytes?.byteLength, id: msg.id, saveAs: msg.saveAs, keys: Object.keys(msg) };
  state.saves.push(entry);
  const ok = await storeSave(msg.name, msg.bytes, entry);
  if (ok && msg.id !== undefined && msg.id !== null) send('saved', { id: msg.id });
  else if (ok) log('info', 'save sans id : pas de saved', 'out');
  else log('info', 'stockage en échec : pas de saved', 'err');
}

$('toastRetry').onclick = async () => {
  if (!state.unsaved) return;
  $('toastRetry').disabled = true;
  await storeSave(state.unsaved.name, state.unsaved.bytes);
  $('toastRetry').disabled = false;
};
$('toastClose').onclick = () => { $('toast').hidden = true; }; // l'état reste : avertissement avant de quitter

async function onHandoff(msg) {
  state.handoffs.push({ name: msg.name, keys: Object.keys(msg) });
  const body = msg.bytes ?? msg.file;
  const r = await store(msg.name, body);
  const ext = (msg.name.split('.').pop() || '').toLowerCase();
  const target = EDITORS[ext];
  log('info', `handoff stocké (${r.status}) ; éditeur pour .${ext} : ${target ?? 'aucun'}`, r.ok ? 'out' : 'err');
  if (r.ok && target && q.has('handoff')) {
    send('handoff-done', { name: msg.name, app: target });
    window.open(`/host.html?app=${target}&open=${r.json.id}`, '_blank', 'noopener');
  }
}

async function openBlob(name, blob) {
  if ($('asBlob').checked && state.ready?.file === true) return send('open', { name, file: blob, size: blob.size });
  const bytes = await blob.arrayBuffer();
  send('open', { name, bytes }, [bytes]);
}
async function openFromServer(id) {
  const r = await fetch(`/api/echo/${encodeURIComponent(id)}`);
  if (!r.ok) return log('info', `GET /api/echo/${id} → ${r.status}`, 'err');
  const name = decodeURIComponent((r.headers.get('content-disposition') || '').split("''")[1] || 'document');
  log('info', `GET /api/echo/${id} → ${r.status}`, 'out');
  await openBlob(name, await r.blob());
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await openBlob(f.name, f);
  e.target.value = '';
});
$('reopen').onclick = () => state.lastId ? openFromServer(state.lastId) : log('info', 'aucune sauvegarde', 'err');
$('download').onclick = () => { if (state.lastId) location.href = `/api/echo/${state.lastId}`; };
$('clear').onclick = () => { $('log').textContent = ''; };
addEventListener('beforeunload', (e) => { if (state.dirty || state.unsaved) { e.preventDefault(); e.returnValue = ''; } });

// ?control : window.<slug> dans l'iframe (craft-web-api).
async function waitControl() {
  $('control').hidden = false;
  for (let i = 0; i < 200; i++) {
    const api = iframe.contentWindow[slug];
    if (api && typeof api.request === 'function') { state.control = true; return log('info', `window.${slug} prêt`, 'out'); }
    await new Promise((r) => setTimeout(r, 50));
  }
  state.control = false;
  log('info', `window.${slug} absent après 10 s`, 'err');
}
const api = () => iframe.contentWindow[slug];
async function call(label, fn) {
  try { const r = await fn(); log('info', `${label} → ${JSON.stringify(r)}`, 'out'); return r; }
  catch (e) { log('info', `${label} → erreur ${e?.message ?? e}`, 'err'); }
}
$('cmdList').onclick = () => call('commands()', () => api().commands());
$('cmdRun').onclick = () => call(`execute(${$('cmdId').value})`, () => api().execute($('cmdId').value));
$('docInspect').onclick = () => call('docInspect()', () => api().docInspect());
window.hostApi = { send, openBlob, openFromServer, call, api };
