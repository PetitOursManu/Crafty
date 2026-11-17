// Compte : double authentification (mise en place, codes de secours, désactivation), connexion unique avec Dashy,
// liaison avec Kosmy Board (relier, délier avec le mot de passe, messages de retour).
import { api, h, dialog, toast } from '/ui.js';
import { t } from '/i18n.js';

// ---------- Dashy ----------
const SSO_MESSAGES = {
  linked: () => t('Compte Dashy lié : vous pouvez maintenant vous connecter avec Dashy.'),
  state: () => t('La connexion Dashy a expiré ou vient d\'un autre onglet : recommencez.'),
  expired: () => t('Le jeton de Dashy a expiré : recommencez.'),
  replay: () => t('Ce lien de connexion a déjà servi : recommencez.'),
  'no-account': () => t('Aucun compte Crafty n\'est lié à cette identité Dashy : demandez à l\'administrateur.'),
  disabled: () => t('Ce compte est désactivé.'),
  ratelimit: () => t('Trop de tentatives, réessayez dans une minute.'),
  'linked-elsewhere': () => t('Cette identité Dashy est déjà liée à un autre compte.'),
  'already-linked': () => t('Votre compte est déjà lié à une identité Dashy.'),
  session: () => t('Session expirée : reconnectez-vous puis recommencez.'),
};
// Jeton refusé (signature, émetteur, audience…) : problème de configuration côté serveur.
export const ssoMessage = (code) => (SSO_MESSAGES[code] || (() => t('Jeton de Dashy refusé : la configuration SSO est à vérifier.')))();

export async function startDashy({ link = false, next = '/' } = {}) {
  const { url } = await api('/api/auth/sso/dashy/start', { method: 'POST', body: { link, next } });
  location.assign(url);
}
// Retour de Dashy sur l'accueil (?sso=…) : message, puis paramètre retiré de l'adresse.
export function ssoNotice() {
  const qs = new URLSearchParams(location.search);
  const code = qs.get('sso');
  if (!code) return;
  if (code === 'linked') toast({ title: ssoMessage(code) });
  else toast({ type: 'error', title: t('Liaison avec Dashy impossible'), detail: ssoMessage(code) });
  qs.delete('sso');
  history.replaceState(null, '', `${location.pathname}${qs.size ? `?${qs}` : ''}${location.hash}`);
}

// ---------- Double authentification ----------
const field = (label, input, hint) => h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
const pwInput = () => h('input', { type: 'password', autocomplete: 'current-password', required: true });
export const codeInput = (recovery = false) => h('input', { type: 'text', inputmode: recovery ? 'text' : 'numeric', autocomplete: 'one-time-code',
  required: true, maxlength: 12, spellcheck: false, autocapitalize: 'none', class: 'code-input' });

// ---------- Kosmy Board (OpenID Connect) ----------
const KOSMY_MESSAGES = {
  linked: () => t('Compte relié à Kosmy Board : vous pouvez maintenant vous connecter avec Kosmy Board.'),
  'not-configured': () => t('La connexion avec Kosmy Board n\'est pas réglée : voir Administration → Système.'),
  issuer: () => t('Ce Kosmy Board n\'est pas celui réglé dans Crafty.'),
  unreachable: () => t('Kosmy Board ne répond pas : réessayez plus tard.'),
  state: () => t('La connexion avec Kosmy Board a expiré ou vient d\'un autre onglet : recommencez.'),
  denied: () => t('Kosmy Board a refusé l\'accès : cet espace Crafty n\'est pas dans votre Board.'),
  client: () => t('Kosmy Board a refusé l\'identifiant ou le secret client : la configuration est à vérifier.'),
  token: () => t('Réponse de Kosmy Board refusée (jeton invalide) : la configuration est à vérifier.'),
  'no-account': () => t('Ce compte Kosmy Board n\'est relié à aucun compte Crafty. Connectez-vous avec votre mot de passe, puis « Relier à Kosmy Board » dans le menu du compte.'),
  disabled: () => t('Ce compte est désactivé.'),
  ratelimit: () => t('Trop de tentatives, réessayez dans une minute.'),
  'linked-elsewhere': () => t('Ce compte Kosmy Board est déjà relié à un autre compte Crafty.'),
  'already-linked': () => t('Votre compte est déjà relié à un compte Kosmy Board.'),
  session: () => t('Session expirée : reconnectez-vous puis recommencez.'),
};
export const kosmyMessage = (code) => (KOSMY_MESSAGES[code] || (() => t('La connexion avec Kosmy Board a échoué : recommencez.')))();

export async function startKosmyLink() {
  const { url } = await api('/api/auth/kosmy-board/link', { method: 'POST' });
  location.assign(url);
}
// Retour de Kosmy Board sur l'accueil (?kosmy=…) après « Relier » : message, puis paramètre retiré de l'adresse.
export function kosmyNotice() {
  const qs = new URLSearchParams(location.search);
  const code = qs.get('kosmy');
  if (!code) return;
  if (code === 'linked') toast({ title: kosmyMessage(code) });
  else toast({ type: 'error', title: t('Liaison avec Kosmy Board impossible'), detail: kosmyMessage(code) });
  qs.delete('kosmy');
  history.replaceState(null, '', `${location.pathname}${qs.size ? `?${qs}` : ''}${location.hash}`);
}
// Défaire le lien : le mot de passe Crafty est demandé.
export function kosmyUnlinkDialog() {
  const pw = pwInput();
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  const dlg = dialog({ title: t('Délier de Kosmy Board'),
    body: h('div', { class: 'form' }, h('p', {}, t('La connexion par Kosmy Board ne mènera plus à ce compte. Vous pourrez le relier à nouveau plus tard.')),
      field(t('Mot de passe actuel'), pw), errEl),
    actions: [h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, t('Annuler')), h('button', { class: 'btn danger', value: 'ok' }, t('Délier'))] });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await api('/api/auth/kosmy-board/unlink', { method: 'POST', body: { password: pw.value } });
      dlg.close('done');
      toast({ title: t('Compte délié de Kosmy Board.') });
      setTimeout(() => location.reload(), 800);
    } catch (err) { errEl.textContent = err.message; pw.select(); }
  });
  pw.focus();
}

// Fenêtre en plusieurs étapes : le corps et les boutons changent, la fenêtre reste.
function stepper(title) {
  const dlg = dialog({ title, body: h('div'), actions: [] });
  const body = dlg.querySelector('.dlg-body'), foot = dlg.querySelector('.dlg-foot'), form = dlg.querySelector('form');
  let handler = null;
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok' || !handler) return;
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try { await handler(); } finally { btn.disabled = false; }
  });
  return {
    dlg,
    show(nodes, { ok, cancel = t('Annuler'), onOk } = {}) {
      handler = onOk || null;
      body.replaceChildren(...nodes.filter(Boolean));
      foot.replaceChildren(...[cancel && h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, cancel),
        ok && h('button', { class: 'btn primary', value: 'ok' }, ok)].filter(Boolean));
      body.querySelector('input')?.focus();
    },
  };
}

function recoveryView(codes) {
  const text = `${t('Codes de secours Crafty (chacun ne sert qu\'une fois) :')}\n\n${codes.join('\n')}\n`;
  const copy = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = t('Copié'); } catch {}
  } }, t('Copier'));
  const save = h('a', { class: 'btn', download: 'crafty-codes-de-secours.txt' }, t('Télécharger (.txt)'));
  save.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  return [
    h('p', {}, t('Gardez ces codes en lieu sûr (gestionnaire de mots de passe, papier). Chacun remplace une fois le code de l\'application si vous perdez votre téléphone. Ils ne seront plus affichés.')),
    h('ol', { class: 'recovery-codes' }, codes.map((c) => h('li', {}, h('code', {}, c)))),
    h('div', { class: 'row-actions' }, copy, save),
  ];
}

export async function twoFactorDialog() {
  const st = await api('/api/me/2fa');
  const s = stepper(t('Double authentification'));
  const err = () => h('div', { class: 'error-text', role: 'alert' });

  if (!st.enabled) {
    const pw = pwInput(), e1 = err();
    s.show([
      h('p', {}, t('En plus du mot de passe, la connexion demandera un code à 6 chiffres donné par une application d\'authentification (Aegis, Google Authenticator, 1Password, Bitwarden…).')),
      field(t('Mot de passe actuel'), pw), e1,
    ], { ok: t('Continuer'), onOk: async () => {
      try {
        const r = await api('/api/me/2fa/setup', { method: 'POST', body: { password: pw.value } });
        const code = codeInput(), e2 = err();
        const qr = h('img', { class: 'qr', alt: t('QR code à scanner avec l\'application d\'authentification'), width: 200, height: 200 });
        qr.src = `/api/me/2fa/qr.svg?${Date.now()}`;
        s.show([
          h('p', {}, t('1. Scannez ce QR code avec l\'application d\'authentification.')),
          h('div', { class: 'qr-box' }, qr),
          h('details', {}, h('summary', {}, t('Saisie manuelle de la clé')), h('code', { class: 'secret' }, r.secret.match(/.{1,4}/g).join(' '))),
          field(t('2. Code à 6 chiffres affiché par l\'application'), code), e2,
        ], { ok: t('Activer'), onOk: async () => {
          try {
            const done = await api('/api/me/2fa/enable', { method: 'POST', body: { code: code.value } });
            s.show(recoveryView(done.recoveryCodes), { ok: t('J\'ai noté mes codes'), cancel: null, onOk: async () => { s.dlg.close('done'); } });
            toast({ title: t('Double authentification activée.') });
          } catch (x) { e2.textContent = x.message; code.select(); }
        } });
      } catch (x) { e1.textContent = x.message; }
    } });
    return;
  }

  // Active : régénérer les codes de secours ou désactiver (mot de passe + code).
  const confirmStep = (title, path, after) => {
    const pw = pwInput(), code = codeInput(true), e = err();
    s.show([h('p', {}, title), field(t('Mot de passe actuel'), pw), field(t('Code de l\'application (ou code de secours)'), code), e],
      { ok: t('Confirmer'), onOk: async () => {
        try { await after(await api(path, { method: 'POST', body: { password: pw.value, code: code.value } })); }
        catch (x) { e.textContent = x.message; }
      } });
  };
  s.show([
    h('p', {}, h('span', { class: 'badge accent' }, t('Active')), ' ', t('La connexion demande un code de l\'application d\'authentification.')),
    h('p', { class: 'mut' }, st.recoveryLeft === 1 ? t('1 code de secours restant.') : t('{n} codes de secours restants.', { n: st.recoveryLeft })),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => confirmStep(t('Les anciens codes de secours ne fonctionneront plus.'), '/api/me/2fa/recovery',
        (r) => s.show(recoveryView(r.recoveryCodes), { ok: t('J\'ai noté mes codes'), cancel: null, onOk: async () => { s.dlg.close('done'); } })) }, t('Nouveaux codes de secours…')),
      h('button', { class: 'btn danger', type: 'button', onclick: () => confirmStep(t('La connexion ne demandera plus que le mot de passe.'), '/api/me/2fa/disable',
        () => { s.dlg.close('done'); toast({ title: t('Double authentification désactivée.') }); }) }, t('Désactiver…'))),
  ], { cancel: t('Fermer') });
}
