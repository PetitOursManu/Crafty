// Administration → Système : connexion avec Kosmy Board (OpenID Connect). Réglages à coller depuis le Board (émetteur,
// identifiant client, secret en écriture seule), création automatique de compte (désactivée par défaut), et les adresses
// de retour et de lancement à donner au Board.
import { api, h, toast, confirmDialog } from '/ui.js';
import { t } from '/i18n.js';

function copyable(value) {
  const btn = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(value); btn.textContent = t('Copié'); setTimeout(() => { btn.textContent = t('Copier'); }, 1500); }
    catch { toast({ type: 'error', title: t('Copie impossible') }); }
  } }, t('Copier'));
  return h('span', { class: 'copy-line' }, h('code', {}, value), btn);
}

export async function kosmyBoardCard() {
  const card = h('div', { class: 'card' });
  const render = (k) => {
    const issuer = h('input', { type: 'text', inputmode: 'url', name: 'issuer', value: k.issuer, placeholder: 'https://board.mondomaine.fr/oidc', spellcheck: false, autocomplete: 'off' });
    const clientId = h('input', { type: 'text', name: 'clientId', value: k.clientId, spellcheck: false, autocomplete: 'off' });
    const secret = h('input', { type: 'password', name: 'clientSecret', autocomplete: 'new-password',
      placeholder: k.hasSecret ? t('Enregistré : laisser vide pour le garder') : '' });
    const create = h('input', { type: 'checkbox', role: 'switch', checked: k.createAccounts });
    const errEl = h('div', { class: 'error-text', role: 'alert' });
    const save = async (body, done) => {
      try { render(await api('/api/admin/kosmy-board', { method: 'PUT', body })); toast({ title: done }); }
      catch (e) { errEl.textContent = e.message; }
    };
    const form = h('form', { class: 'form', novalidate: true },
      h('label', { class: 'field' }, t('Émetteur (issuer)'), issuer),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, t('Identifiant client'), clientId),
        h('label', { class: 'field' }, t('Secret client'), secret, h('span', { class: 'hint' }, t('Montré une seule fois par le Board. Jamais réaffiché ici.')))),
      h('label', { class: 'switch-row' }, h('div', {}, h('strong', {}, t('Création automatique de compte')),
        h('div', { class: 'mut' }, t('Un compte Kosmy Board inconnu obtient un compte Crafty (simple utilisateur) à sa première connexion. Sinon, seuls les comptes reliés peuvent se connecter.'))),
      h('span', { class: 'switch' }, create, h('span'))),
      errEl,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, t('Enregistrer')),
        k.hasSecret && h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (await confirmDialog({ title: t('Désactiver la connexion avec Kosmy Board ?'), danger: true, confirm: t('Désactiver'),
            message: t('Le secret client est effacé. Les comptes restent reliés : il suffira de coller un nouveau secret pour réactiver.') })) {
            await save({ clearSecret: true }, t('Connexion avec Kosmy Board désactivée.'));
          }
        } }, t('Désactiver'))));
    form.onsubmit = (e) => {
      e.preventDefault();
      errEl.textContent = '';
      save({ issuer: issuer.value, clientId: clientId.value, clientSecret: secret.value, createAccounts: create.checked }, t('Réglages enregistrés.'));
    };
    card.replaceChildren(...[
      h('h3', {}, t('Connexion avec Kosmy Board')),
      h('p', {}, k.enabled ? h('span', { class: 'badge accent' }, t('activée')) : h('span', { class: 'badge' }, t('non réglée')), ' ',
        t('Dans le Board : Modifier → Connexion unique sur l\'espace Crafty, puis collez ici l\'émetteur, l\'identifiant et le secret. Les comptes se relient par l\'identifiant du Board, jamais par l\'e-mail.')),
      h('dl', { class: 'kv' },
        h('dt', {}, t('Adresse de retour')), h('dd', {}, copyable(k.redirectUri)),
        h('dt', {}, t('Adresse de lancement')), h('dd', {}, copyable(k.loginUri))),
      k.publicOrigin ? null : h('p', { class: 'hint mut' }, t('Adresses déduites de cette page. Derrière un proxy, réglez PUBLIC_ORIGIN pour les fixer.')),
      k.secretsEncrypted ? null : h('p', { class: 'hint' }, h('span', { class: 'badge warn' }, t('en clair')), ' ', t('CRAFTY_SECRET n\'est pas défini : le secret client est gardé en clair dans la base.')),
      form].filter(Boolean));
  };
  render(await api('/api/admin/kosmy-board'));
  return card;
}
