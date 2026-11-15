// Données des applications par compte (voir src/appdata.js). Certaines applications gardent leurs données dans le
// stockage du navigateur, commun à tous les comptes de ce navigateur (même origine) : boîte MailCraft (localStorage),
// session EffectCraft (OPFS), bases IndexedDB… Ce qu'une application déclare dans apps.json (data : { local: [clés],
// idb: [bases], opfs: [chemins, « dossier/ », « début* »], clear: { mêmes clés : effacé sans être copié } }) suit le compte :
// - avant le chargement de l'application : les données d'un autre compte sont effacées, celles du compte remises ;
// - pendant : un instantané est envoyé toutes les 30 s, au passage en arrière-plan et après chaque enregistrement Crafty,
//   seulement s'il a changé (empreinte SHA-256) ;
// - à la déconnexion : dernier envoi, puis effacement (flushAndWipe).
// Instantané : « CRAFTDATA1\n », longueur de l'en-tête (4 octets), en-tête JSON, puis les octets (fichiers OPFS, Blob et
// ArrayBuffer des bases). Déterministe (ordre trié, pas d'horodatage) : même contenu, même empreinte.
// Les valeurs IndexedDB que le navigateur ne laisse pas copier (poignées de fichiers…) sont ignorées.
import { api } from '/ui.js';
import { t } from '/i18n.js';

const META = 'craft-data-sync';
const MAGIC = 'CRAFTDATA1\n';
const readMeta = () => { try { return JSON.parse(localStorage.getItem(META)) || null; } catch { return null; } };
const writeMeta = (m) => { try { m ? localStorage.setItem(META, JSON.stringify(m)) : localStorage.removeItem(META); } catch {} };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (blob) => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

// ---------- Valeurs IndexedDB <-> JSON (octets à part) ----------
class Unsupported extends Error {}
async function enc(v, parts) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };
  if (v === undefined) return { $u: 1 };
  if (typeof v === 'bigint') return { $big: String(v) };
  if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await enc(x, parts)); return out; }
  if (v instanceof Date) return { $d: v.getTime() };
  if (v instanceof ArrayBuffer) return { $ab: parts.push(new Blob([v])) - 1 };
  if (ArrayBuffer.isView(v)) return { $ta: v.constructor.name, p: parts.push(new Blob([new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice()])) - 1 };
  if (v instanceof Blob) return { $blob: parts.push(v) - 1, type: v.type, ...(v instanceof File ? { name: v.name, lm: v.lastModified } : {}) };
  if (v instanceof Map) { const out = []; for (const [k, x] of v) out.push([await enc(k, parts), await enc(x, parts)]); return { $map: out }; }
  if (v instanceof Set) { const out = []; for (const x of v) out.push(await enc(x, parts)); return { $set: out }; }
  if (v instanceof RegExp) return { $re: [v.source, v.flags] };
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Unsupported(proto?.constructor?.name || 'objet');
  const out = {};
  for (const k of Object.keys(v)) out[k] = await enc(v[k], parts);
  return Object.keys(out).some((k) => k.startsWith('$')) ? { $o: out } : out;
}
function dec(v, parts) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => dec(x, parts));
  if ('$n' in v) return Number(v.$n);
  if ('$u' in v) return undefined;
  if ('$big' in v) return BigInt(v.$big);
  if ('$d' in v) return new Date(v.$d);
  if ('$ab' in v) return parts[v.$ab].buf;
  if ('$ta' in v) { const C = globalThis[v.$ta]; return v.$ta === 'DataView' ? new DataView(parts[v.p].buf) : new C(parts[v.p].buf); }
  if ('$blob' in v) { const b = parts[v.$blob].blob; return v.name !== undefined ? new File([b], v.name, { type: v.type, lastModified: v.lm }) : new Blob([b], { type: v.type }); }
  if ('$map' in v) return new Map(v.$map.map(([k, x]) => [dec(k, parts), dec(x, parts)]));
  if ('$set' in v) return new Set(v.$set.map((x) => dec(x, parts)));
  if ('$re' in v) return new RegExp(...v.$re);
  const src = '$o' in v ? v.$o : v, out = {};
  for (const k of Object.keys(src)) out[k] = dec(src[k], parts);
  return out;
}

// ---------- OPFS ----------
const opfsRoot = () => navigator.storage?.getDirectory?.();
// Motifs : « dossier/ » (tout le dossier), « début* » (fichiers dont le chemin commence ainsi), sinon chemin exact.
const inScope = (path, prefixes) => prefixes.some((p) => (p.endsWith('/') ? path.startsWith(p) : p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p));
async function opfsFiles(prefixes) {
  const root = await opfsRoot().catch(() => null);
  if (!root || !prefixes?.length) return [];
  const out = [];
  async function walk(dir, path) {
    for await (const [name, h] of dir.entries()) {
      const p = path + name;
      if (h.kind === 'directory') { if (prefixes.some((x) => x.startsWith(p + '/') || (p + '/').startsWith(x))) await walk(h, p + '/'); }
      else if (inScope(p, prefixes)) out.push({ path: p, file: await h.getFile() });
    }
  }
  await walk(root, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
async function opfsDir(path, create) {
  let dir = await opfsRoot();
  for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}
async function opfsWipe(prefixes) {
  const root = await opfsRoot().catch(() => null);
  if (!root) return;
  for (const p of prefixes || []) {
    const parts = p.split('/').filter(Boolean), name = parts.pop();
    try {
      const dir = await opfsDir(parts.join('/'), false);
      if (!p.endsWith('*')) { await dir.removeEntry(name, { recursive: true }); continue; }
      const start = name.slice(0, -1), names = [];
      for await (const [n] of dir.entries()) if (n.startsWith(start)) names.push(n);
      for (const n of names) await dir.removeEntry(n, { recursive: true });
    } catch {} // absent : rien à effacer
  }
}

// ---------- Instantané ----------
export async function snapshot(data) {
  const parts = [], header = { v: 1, local: {}, idb: [], opfs: [], skipped: 0 };
  for (const k of [...(data.local || [])].sort()) { const v = localStorage.getItem(k); if (v !== null) header.local[k] = v; }
  const existing = new Set((await indexedDB.databases?.() || []).map((d) => d.name));
  for (const name of [...(data.idb || [])].sort()) {
    if (!existing.has(name)) continue;
    const db = await req(indexedDB.open(name));
    try {
      const base = { name, version: db.version, stores: [] };
      for (const s of [...db.objectStoreNames].sort()) {
        const tx = db.transaction(s), st = tx.objectStore(s);
        const store = { name: s, keyPath: st.keyPath, autoIncrement: st.autoIncrement, indexes: [], records: [] };
        for (const i of [...st.indexNames].sort()) { const ix = st.index(i); store.indexes.push({ name: i, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }); }
        const [keys, values] = await Promise.all([req(st.getAllKeys()), req(st.getAll())]);
        for (let i = 0; i < keys.length; i++) {
          try { store.records.push([await enc(keys[i], parts), await enc(values[i], parts)]); }
          catch (e) { if (e instanceof Unsupported) header.skipped++; else throw e; }
        }
        base.stores.push(store);
      }
      header.idb.push(base);
    } finally { db.close(); }
  }
  for (const { path, file } of await opfsFiles(data.opfs)) header.opfs.push({ path, p: parts.push(file) - 1 });
  header.sizes = parts.map((b) => b.size);
  const empty = !Object.keys(header.local).length && !header.idb.length && !header.opfs.length;
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, json.length);
  const blob = new Blob([MAGIC, len, json, ...parts]);
  return { blob, empty, skipped: header.skipped, sha: await sha256(blob) };
}

// clear : effacé avec le reste mais jamais copié (verrou de session EffectCraft, propre à un navigateur).
export async function wipe(data) {
  const all = (k) => [...(data[k] || []), ...(data.clear?.[k] || [])];
  for (const k of all('local')) { try { localStorage.removeItem(k); } catch {} }
  for (const name of all('idb')) await new Promise((r) => { const d = indexedDB.deleteDatabase(name); d.onsuccess = d.onerror = d.onblocked = () => r(); });
  await opfsWipe(all('opfs'));
}

export async function apply(data, blob) {
  const buf = await blob.arrayBuffer();
  if (new TextDecoder().decode(buf.slice(0, MAGIC.length)) !== MAGIC) throw new Error(t('instantané illisible'));
  const len = new DataView(buf, MAGIC.length, 4).getUint32(0);
  let off = MAGIC.length + 4;
  const header = JSON.parse(new TextDecoder().decode(buf.slice(off, off + len)));
  off += len;
  const parts = header.sizes.map((n) => { const b = buf.slice(off, off + n); off += n; return { buf: b, blob: new Blob([b]) }; });
  await wipe(data);
  for (const [k, v] of Object.entries(header.local)) if ((data.local || []).includes(k)) localStorage.setItem(k, v);
  for (const d of header.idb) {
    if (!(data.idb || []).includes(d.name)) continue;
    const open = indexedDB.open(d.name, d.version);
    open.onupgradeneeded = () => {
      for (const s of d.stores) {
        const st = open.result.createObjectStore(s.name, { keyPath: s.keyPath ?? undefined, autoIncrement: s.autoIncrement });
        for (const i of s.indexes) st.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      }
    };
    const db = await req(open);
    try {
      for (const s of d.stores) {
        if (!s.records.length) continue;
        const tx = db.transaction(s.name, 'readwrite'), st = tx.objectStore(s.name);
        for (const [k, v] of s.records) s.keyPath == null ? st.put(dec(v, parts), dec(k, parts)) : st.put(dec(v, parts));
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      }
    } finally { db.close(); }
  }
  for (const f of header.opfs) {
    if (!inScope(f.path, data.opfs || [])) continue;
    const parts2 = f.path.split('/'), name = parts2.pop();
    const fh = await (await opfsDir(parts2.join('/'), true)).getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(parts[f.p].blob); await w.close();
  }
}

// ---------- Restauration et envois ----------
async function upload(slug, blob) {
  const r = await fetch(`/api/appdata/${encodeURIComponent(slug)}`, { method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || t('erreur {status}', { status: r.status }));
  return r.json();
}

// Avant le chargement de l'application. Renvoie { flush, stop } ou null.
export async function restoreData(me, app, log = () => {}) {
  const data = app.data;
  if (!data) return null;
  if (!me.user) { await wipe(data); return null; } // invité : départ vierge, rien n'est gardé
  const uid = String(me.user.id), slug = app.slug;
  const m = readMeta();
  const legacy = m === null, mine = m?.owner === uid;
  if (!legacy && !mine) {
    // Données d'un autre compte : effacées pour toutes les applications de ce compte-ci (elles seront remises une à une).
    // Celles de cette application aussi, avant toute lecture du serveur (qui peut échouer).
    for (const a of me.apps || []) if (a.data) await wipe(a.data);
    if (!(me.apps || []).some((a) => a.slug === slug)) await wipe(data);
    writeMeta({ owner: uid, base: {} });
  }
  const meta = readMeta() || { owner: uid, base: {} };
  meta.owner = uid; meta.base ||= {};
  const local = await snapshot(data);
  const r = await fetch(`/api/appdata/${encodeURIComponent(slug)}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok && r.status !== 204) throw new Error(t('données non lues ({status})', { status: r.status }));
  const remote = r.status === 204 ? null : { blob: await r.blob(), sha: (r.headers.get('etag') || '').replace(/"/g, '') };
  let pending = false;
  if (mine && !local.empty && local.sha !== meta.base[slug]) {
    pending = true; // modifiées ici depuis le dernier envoi (onglet fermé trop tôt) : elles l'emportent et partent
    log(`données locales plus récentes que le dernier envoi : conservées`);
  } else if (legacy && !local.empty && !remote) {
    pending = true; // navigateur utilisé avant cette fonction : le premier compte reprend ce qui s'y trouve
    log(`données déjà présentes dans ce navigateur : reprises par ce compte`);
  } else if (remote) {
    await apply(data, remote.blob);
    meta.base[slug] = remote.sha;
    log(`données du compte remises (${remote.blob.size} octets)`);
  } else {
    if (!local.empty) await wipe(data);
    delete meta.base[slug];
  }
  writeMeta(meta);
  return createSync(slug, data, meta, log, pending);
}

function createSync(slug, data, meta, log, pending) {
  let busy = false;
  async function flush() {
    if (busy) return;
    busy = true;
    try {
      const s = await snapshot(data);
      if (s.empty || s.sha === meta.base[slug]) return;
      await upload(slug, s.blob);
      meta.base[slug] = s.sha; writeMeta(meta);
      log(`données envoyées (${s.blob.size} octets${s.skipped ? `, ${s.skipped} valeur(s) non copiable(s)` : ''})`);
    } catch (e) { log(`données non envoyées : ${e.message}`); } finally { busy = false; }
  }
  const timer = setInterval(flush, 30_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  if (pending) flush();
  return { flush, stop: () => clearInterval(timer) };
}

// Déconnexion : dernier envoi de ce qui a changé, puis effacement de toutes les données déclarées.
// Si un envoi échoue, ces données-là restent (rien n'est perdu) avec le marqueur de leur propriétaire : le prochain
// compte qui ouvre l'application les efface d'abord ; le même compte les renvoie à sa prochaine visite.
export async function flushAndWipe(me) {
  const m = readMeta();
  const uid = me?.user ? String(me.user.id) : null;
  let kept = 0;
  for (const a of me?.apps || []) {
    if (!a.data) continue;
    try {
      if (uid && m?.owner === uid) {
        const s = await snapshot(a.data);
        if (!s.empty && s.sha !== m.base?.[a.slug]) await upload(a.slug, s.blob);
      }
    } catch { kept++; continue; }
    await wipe(a.data).catch(() => {});
  }
  if (!kept) writeMeta(null);
  return kept;
}
