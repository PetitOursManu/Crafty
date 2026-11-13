// Connexion, création du premier compte (admin), inscription (si ouverte), invité (si activé),
// changement de mot de passe obligatoire.
import { api, h } from '/ui.js';

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
    title: 'Connexion', lead: 'Connectez-vous pour retrouver vos fichiers et vos applications.',
    fields: [field('Identifiant', u), field('Mot de passe', p)], submit: 'Se connecter',
    onSubmit: async () => {
      need([u.value, 'Indiquez votre identifiant.'], [p.value, 'Indiquez votre mot de passe.']);
      const r = await api('/api/auth/login', { method: 'POST', body: { username: u.value.trim(), password: p.value } });
      if (r.mustChange) showChange(p.value); else go();
    },
    alt: [
      config.signupOpen && h('button', { class: 'btn', type: 'button', onclick: showRegister }, 'Créer un compte'),
      config.guestEnabled && h('button', { class: 'btn ghost', type: 'button', onclick: guest }, 'Continuer en invité (sans enregistrement)'),
    ].filter(Boolean),
  });
}
function showRegister(setup = false) {
  const u = user(), p = pass('new-password'), p2 = pass('new-password');
  form({
    title: setup === true ? 'Créer le compte administrateur' : 'Créer un compte',
    lead: setup === true ? 'Aucun compte n\'existe encore. Ce premier compte administrera le service.' : null,
    fields: [field('Identifiant', u, '3 à 32 caractères : lettres, chiffres, . _ -'), field('Mot de passe', p, 'Au moins 8 caractères.'), field('Confirmer le mot de passe', p2)],
    submit: 'Créer le compte',
    onSubmit: async () => {
      need([u.value, 'Indiquez un identifiant.'], [p.value.length >= 8, 'Mot de passe : au moins 8 caractères.'], [p.value === p2.value, 'Les deux mots de passe ne correspondent pas.']);
      await api('/api/auth/register', { method: 'POST', body: { username: u.value.trim(), password: p.value } });
      go();
    },
    alt: setup === true ? [] : [h('button', { class: 'btn ghost', type: 'button', onclick: showLogin }, 'J\'ai déjà un compte')],
  });
}
function showChange(current = '') {
  const c = pass('current-password'), p = pass('new-password'), p2 = pass('new-password');
  c.value = current;
  form({
    title: 'Choisissez votre mot de passe', lead: 'Votre mot de passe est provisoire : remplacez-le avant de continuer.',
    fields: [current ? null : field('Mot de passe actuel', c), field('Nouveau mot de passe', p, 'Au moins 8 caractères.'), field('Confirmer', p2)],
    submit: 'Enregistrer et continuer',
    onSubmit: async () => {
      need([p.value.length >= 8, 'Mot de passe : au moins 8 caractères.'], [p.value === p2.value, 'Les deux mots de passe ne correspondent pas.']);
      await api('/api/auth/password', { method: 'POST', body: { current: c.value, password: p.value } });
      go();
    },
    alt: [h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; } }, 'Se déconnecter')],
  });
}
async function guest() {
  try { await api('/api/auth/guest', { method: 'POST' }); location.href = '/'; }
  catch (e) { view.querySelector('.error-text').textContent = e.message; }
}

config = await api('/api/auth/config').catch(() => config);
if (q.has('change')) showChange();
else if (config.setup) showRegister(true);
else showLogin();
