// Réglages des applications par compte (voir src/prefs.js).
// Avant le chargement de l'application : les clés de l'application (app.prefKeys) reçoivent les valeurs du compte, ou
// sont effacées si le compte n'en a pas (jamais celles d'un autre compte). Ensuite, les clés modifiées sont renvoyées
// au serveur toutes les 10 s, au passage en arrière-plan et en quittant la page.
// Les applications (eframe) écrivent leurs réglages périodiquement et en quittant la page : les derniers changements
// peuvent arriver après notre dernier envoi. D'où craft-prefs-sync : à qui appartiennent les valeurs de ce navigateur
// (owner) et l'empreinte de la dernière valeur synchronisée par clé (base). Au retour du même compte, une valeur locale
// différente de sa base a été modifiée ici depuis : elle l'emporte et part au serveur ; sinon la valeur du serveur
// (peut-être venue d'un autre appareil) s'applique. Navigateur utilisé avant cette fonction (pas de marqueur) : les
// valeurs locales sont reprises par le premier compte qui ouvre l'application.
import { api } from '/ui.js';

const META = 'craft-prefs-sync';
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const digest = (s) => { if (s === null) return null; let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return `${s.length}:${h}`; };
const meta = () => { try { return JSON.parse(read(META)) || null; } catch { return null; } };

export function clearPrefs(keys) {
  for (const k of keys) write(k, null);
  write(META, null);
}

export async function restorePrefs(me, app) {
  const keys = app.prefKeys || [];
  if (!keys.length) return null;
  if (!me.user) { clearPrefs(keys); return null; } // invité : réglages par défaut, rien n'est gardé
  const m = meta();
  const mine = m?.owner === String(me.user.id);
  const legacy = m === null;
  const base = mine ? { ...(m.base || {}) } : {};
  const { values } = await api(`/api/prefs?keys=${encodeURIComponent(keys.join(','))}`);
  const sent = {};
  for (const k of keys) {
    const local = read(k);
    const changedHere = local !== null && (legacy || (mine && digest(local) !== base[k]));
    if (changedHere) { sent[k] = values[k]; continue; } // la valeur locale sera envoyée
    write(k, values[k]);
    sent[k] = values[k];
    base[k] = digest(values[k]);
  }
  const owner = String(me.user.id);
  const saveMeta = () => write(META, JSON.stringify({ owner, base }));
  saveMeta();
  const sync = createSync(keys, sent, (k, v) => { base[k] = digest(v); saveMeta(); });
  sync.flush();
  return sync;
}

function createSync(keys, sent, onSent) {
  let busy = false;
  const changed = () => Object.fromEntries(keys.map((k) => [k, read(k)]).filter(([k, v]) => v !== sent[k]));
  async function flush({ keepalive = false } = {}) {
    const values = changed();
    if (!Object.keys(values).length || busy) return;
    busy = true;
    try {
      const r = await fetch('/api/prefs', { method: 'PUT', keepalive, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
      if (r.ok) for (const [k, v] of Object.entries(values)) { sent[k] = v; onSent(k, v); }
    } catch {} finally { busy = false; }
  }
  const timer = setInterval(flush, 10_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush({ keepalive: true }); });
  addEventListener('pagehide', () => flush({ keepalive: true }));
  return { flush, stop: () => clearInterval(timer) };
}
