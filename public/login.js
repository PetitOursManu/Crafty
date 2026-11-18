// Connexion, création du premier compte (admin), inscription (si ouverte), invité (si activé),
// changement de mot de passe obligatoire.
import { api, h, icon } from '/ui.js';
import { t, translateDom } from '/i18n.js';
import { codeInput, kosmyMessage, ssoMessage, startDashy } from '/account.js';

translateDom();

const q = new URLSearchParams(location.search);
const next = (() => { const n = q.get('next') || '/'; return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/'; })();
const view = document.getElementById('view');
let config = { setup: false, signupOpen: false, guestEnabled: false };

function field(label, input, hint) {
  return h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
}
function form({ title, lead, fields, submit, onSubmit, alt = [] }) {
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, submit);
  const f = h('form', { class: 'form', novalidate: true }, fields, errEl, btn);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    btn.disabled = true;
    try { await onSubmit(); } catch (err) { errEl.textContent = err.message; } finally { btn.disabled = false; }
  });
  view.replaceChildren(...[h('div', {}, h('h1', {}, title), lead ? h('p', { class: 'lead' }, lead) : null), f,
    alt.length ? h('div', { class: 'auth-alt' }, alt) : null].filter(Boolean));
  f.querySelector('input')?.focus();
}
const user = () => h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: false });
const pass = (auto) => h('input', { type: 'password', name: 'password', autocomplete: auto, required: true });
const go = () => { location.href = next; };
const need = (...pairs) => { for (const [v, msg] of pairs) if (!v) throw new Error(msg); };

function showLogin() {
  const u = user(), p = pass('current-password');
  form({
    title: t('Connexion'), lead: t('Connectez-vous pour retrouver vos fichiers et vos applications.'),
    fields: [field(t('Identifiant'), u), field(t('Mot de passe'), p)], submit: t('Se connecter'),
    onSubmit: async () => {
      need([u.value, t('Indiquez votre identifiant.')], [p.value, t('Indiquez votre mot de passe.')]);
      const r = await api('/api/auth/login', { method: 'POST', body: { username: u.value.trim(), password: p.value } });
      if (r.twoFactor) showCode(r.ticket, p.value);
      else if (r.mustChange) showChange(p.value); else go();
    },
    alt: [
      config.sso?.kosmyBoard && h('a', { class: 'btn kosmy', href: `/auth/kosmy-board/login?target_link_uri=${encodeURIComponent(next)}` },
        icon('grid'), t('Se connecter avec Kosmy Board')),
      config.sso?.dashy && h('button', { class: 'btn', type: 'button', onclick: dashy }, t('Se connecter avec Dashy')),
      config.signupOpen && h('button', { class: 'btn', type: 'button', onclick: showRegister }, t('Créer un compte')),
      config.guestEnabled && h('button', { class: 'btn ghost', type: 'button', onclick: guest }, t('Continuer en invité (sans enregistrement)')),
    ].filter(Boolean),
  });
}
function showRegister(setup = false) {
  const u = user(), p = pass('new-password'), p2 = pass('new-password');
  form({
    title: setup === true ? t('Créer le compte administrateur') : t('Créer un compte'),
    lead: setup === true ? t('Aucun compte n\'existe encore. Ce premier compte administrera le service.') : null,
    fields: [field(t('Identifiant'), u, t('3 à 32 caractères : lettres, chiffres, . _ -')), field(t('Mot de passe'), p, t('Au moins 8 caractères.')), field(t('Confirmer le mot de passe'), p2)],
    submit: t('Créer le compte'),
    onSubmit: async () => {
      need([u.value, t('Indiquez un identifiant.')], [p.value.length >= 8, t('Mot de passe : au moins 8 caractères.')], [p.value === p2.value, t('Les deux mots de passe ne correspondent pas.')]);
      await api('/api/auth/register', { method: 'POST', body: { username: u.value.trim(), password: p.value } });
      go();
    },
    alt: setup === true ? [] : [h('button', { class: 'btn ghost', type: 'button', onclick: showLogin }, t('J\'ai déjà un compte'))],
  });
}
function showChange(current = '') {
  const c = pass('current-password'), p = pass('new-password'), p2 = pass('new-password');
  c.value = current;
  form({
    title: t('Choisissez votre mot de passe'), lead: t('Votre mot de passe est provisoire : remplacez-le avant de continuer.'),
    fields: [current ? null : field(t('Mot de passe actuel'), c), field(t('Nouveau mot de passe'), p, t('Au moins 8 caractères.')), field(t('Confirmer'), p2)],
    submit: t('Enregistrer et continuer'),
    onSubmit: async () => {
      need([p.value.length >= 8, t('Mot de passe : au moins 8 caractères.')], [p.value === p2.value, t('Les deux mots de passe ne correspondent pas.')]);
      await api('/api/auth/password', { method: 'POST', body: { current: c.value, password: p.value } });
      go();
    },
    alt: [h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; } }, t('Se déconnecter'))],
  });
}
// Deuxième étape : code de l'application d'authentification, ou code de secours.
function showCode(ticket, password) {
  const c = codeInput(true);
  form({
    title: t('Code de vérification'), lead: t('Saisissez le code à 6 chiffres affiché par votre application d\'authentification.'),
    fields: [field(t('Code'), c, t('Téléphone perdu ? Saisissez un de vos codes de secours (xxxxx-xxxxx).'))],
    submit: t('Vérifier'),
    onSubmit: async () => {
      need([c.value.trim(), t('Indiquez le code.')]);
      try {
        const r = await api('/api/auth/2fa', { method: 'POST', body: { ticket, code: c.value.trim() } });
        if (r.recoveryLeft !== undefined) sessionStorage.setItem('craft-recovery-left', String(r.recoveryLeft));
        if (r.mustChange) showChange(password); else go();
      } catch (e) {
        if (e.data?.expired) { showLogin(); view.querySelector('.error-text').textContent = e.message; return; }
        c.select();
        throw e;
      }
    },
    alt: [h('button', { class: 'btn ghost', type: 'button', onclick: showLogin }, t('Retour'))],
  });
}
async function dashy() {
  try { await startDashy({ next }); }
  catch (e) { view.querySelector('.error-text').textContent = e.message; }
}
async function guest() {
  try { await api('/api/auth/guest', { method: 'POST' }); location.href = '/'; }
  catch (e) { view.querySelector('.error-text').textContent = e.message; }
}

config = await api('/api/auth/config').catch(() => config);
if (q.has('change')) showChange();
else if (config.setup) showRegister(true);
else showLogin();
// Retour de Dashy ou de Kosmy Board en échec (?sso=<raison>, ?kosmy=<raison>) : message sous le formulaire.
for (const [key, message] of [['sso', ssoMessage], ['kosmy', kosmyMessage]]) {
  if (!q.get(key) || config.setup) continue;
  view.querySelector('.error-text').textContent = message(q.get(key));
  q.delete(key);
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
}
