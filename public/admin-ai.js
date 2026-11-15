// Administration de l'assistant IA (voir src/ai.js) : activation, comptes autorisés, limites, fournisseur par défaut,
// et pour chaque fournisseur : adresse, clé (jamais réaffichée), modèle, effort, essai. Consommation des 30 derniers jours.
import { api, h, icon, toast } from '/ui.js';

const EFFORT_LABELS = { auto: 'Auto (défaut du modèle)', off: 'Désactivée', low: 'Faible', medium: 'Moyenne', high: 'Élevée' };

function switchRow(title, hint, checked) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked });
  return { input, el: h('label', { class: 'switch-row' }, h('div', {}, h('strong', {}, title), h('div', { class: 'mut' }, hint)),
    h('span', { class: 'switch' }, input, h('span'))) };
}

export async function renderAi(root, users) {
  let c;
  try { c = await api('/api/admin/ai'); } catch (e) { root.replaceChildren(h('p', { class: 'error-text' }, e.message)); return; }
  const enabled = switchRow('Assistant activé', 'Bouton « Assistant » sur l\'accueil et dans la barre du haut de chaque application.', c.enabled);
  const everyone = h('input', { type: 'radio', name: 'ai-who', checked: c.everyone });
  const chosen = h('input', { type: 'radio', name: 'ai-who', checked: !c.everyone });
  const userBoxes = users.filter((u) => u.role !== 'admin').map((u) => {
    const cb = h('input', { type: 'checkbox', value: String(u.id), checked: c.users.includes(u.id) });
    return { cb, el: h('label', { class: 'chip-check' }, cb, u.username, u.disabled ? h('span', { class: 'mut' }, ' (désactivé)') : null) };
  });
  const userList = h('div', { class: 'chips' }, ...userBoxes.map((b) => b.el), userBoxes.length ? null : h('span', { class: 'mut' }, 'Aucun autre compte.'));
  const syncWho = () => { userList.hidden = everyone.checked; };
  everyone.onchange = chosen.onchange = syncWho; syncWho();
  const maxPerHour = h('input', { type: 'number', min: 1, max: 10000, step: 1, value: String(c.maxPerHour), required: true });
  const maxSteps = h('input', { type: 'number', min: 1, max: 100, step: 1, value: String(c.maxSteps), required: true });
  const defaultSel = h('select', {});

  const cards = c.providers.map((p) => {
    const on = h('input', { type: 'checkbox', role: 'switch', checked: p.enabled });
    const baseUrl = h('input', { type: 'text', inputmode: 'url', value: p.baseUrl, placeholder: p.defaultBaseUrl || 'https://…/v1', spellcheck: false });
    const key = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: false,
      placeholder: p.hasKey ? 'Clé enregistrée : laisser vide pour la garder' : p.keyUnreadable ? 'Clé illisible (CRAFTY_SECRET changé) : la ressaisir' : (['ollama', 'custom'].includes(p.id) ? 'Facultative' : 'Clé API') });
    let removeKey = false;
    const removeBtn = h('button', { type: 'button', class: 'btn sm ghost danger', hidden: !p.hasKey, onclick: () => { removeKey = true; removeBtn.hidden = true; key.placeholder = 'Clé retirée à l\'enregistrement'; } }, 'Retirer la clé');
    const model = h('input', { type: 'text', value: p.model, placeholder: p.suggestedModel ? `ex. ${p.suggestedModel}` : 'identifiant du modèle', spellcheck: false });
    const effort = h('select', {}, ...c.efforts.map((e) => h('option', { value: e, selected: e === p.effort }, EFFORT_LABELS[e] || e)));
    const badge = h('span', { class: `badge${p.ready ? ' ok' : ''}` }, p.ready ? 'Prêt' : p.enabled ? 'Incomplet' : 'Désactivé');
    const result = h('span', { class: 'mut ai-test' });
    const test = h('button', { type: 'button', class: 'btn sm', onclick: async () => {
      result.textContent = 'Essai…';
      try { await save(true); const r = await api('/api/admin/ai/test', { method: 'POST', body: { provider: p.id } }); result.textContent = `Réponse en ${r.ms} ms (${r.model}) : « ${r.answer} »`; }
      catch (e) { result.textContent = e.message; result.classList.add('error-text'); setTimeout(() => result.classList.remove('error-text'), 8000); }
    } }, 'Tester');
    const el = h('details', { class: 'card ai-provider', open: p.enabled },
      h('summary', {}, h('strong', {}, p.label), badge),
      h('label', { class: 'switch-row' }, h('div', {}, h('strong', {}, 'Activé')), h('span', { class: 'switch' }, on, h('span'))),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Modèle', model, h('span', { class: 'hint' }, p.id === 'openrouter' ? 'Identifiant OpenRouter, ex. anthropic/claude-sonnet-4.5. Choisir un modèle qui sait appeler des outils.' : 'Choisir un modèle qui sait appeler des outils (function calling).')),
        h('label', { class: 'field' }, 'Effort (réflexion)', effort, h('span', { class: 'hint' }, 'Ignoré par les modèles qui ne le prennent pas en charge.'))),
      h('label', { class: 'field' }, 'Clé API', key, h('span', { class: 'hint' }, 'Gardée sur le serveur, jamais renvoyée au navigateur.'), removeBtn),
      h('label', { class: 'field' }, 'Adresse', baseUrl, h('span', { class: 'hint' }, `Vide : ${p.defaultBaseUrl || 'à renseigner'}`)),
      h('div', { class: 'row ai-test-row' }, test, result));
    return { p, el, value: () => ({ enabled: on.checked, baseUrl: baseUrl.value.trim(), model: model.value.trim(), effort: effort.value,
      ...(key.value.trim() ? { apiKey: key.value.trim() } : removeKey ? { apiKey: '' } : {}) }) };
  });
  const fillDefault = (list) => {
    defaultSel.replaceChildren(h('option', { value: '' }, '— premier fournisseur prêt —'),
      ...list.filter((p) => p.ready).map((p) => h('option', { value: p.id, selected: p.id === c.defaultProvider }, p.label)));
  };
  fillDefault(c.providers);

  const usage = h('tbody');
  const errEl = h('div', { class: 'error-text', role: 'alert' });
  async function save(quiet = false) {
    const body = { enabled: enabled.input.checked, everyone: everyone.checked, users: userBoxes.filter((b) => b.cb.checked).map((b) => Number(b.cb.value)),
      maxPerHour: Number(maxPerHour.value), maxSteps: Number(maxSteps.value), defaultProvider: defaultSel.value || null,
      providers: Object.fromEntries(cards.map((k) => [k.p.id, k.value()])) };
    try {
      const r = await api('/api/admin/ai', { method: 'PUT', body });
      errEl.textContent = '';
      if (!quiet) { toast({ title: 'Assistant enregistré.' }); return renderAi(root, users); }
      c = r;
    } catch (e) { errEl.textContent = e.message; throw e; }
  }
  const form = h('form', { class: 'settings', onsubmit: (e) => { e.preventDefault(); save().catch(() => {}); } },
    c.encrypted ? null : h('div', { class: 'card warn' }, icon('key'), h('div', {}, h('strong', {}, 'Clés non chiffrées. '),
      'Elles sont gardées en clair dans la base. Définissez la variable d\'environnement CRAFTY_SECRET (longue valeur aléatoire) puis ressaisissez les clés.')),
    h('div', { class: 'card' }, h('h3', {}, 'Accès'), enabled.el,
      h('div', { class: 'field-set' }, h('strong', {}, 'Comptes autorisés'), h('div', { class: 'mut' }, 'Les administrateurs y ont toujours droit.'),
        h('label', { class: 'radio' }, everyone, 'Tous les comptes'), h('label', { class: 'radio' }, chosen, 'Seulement ces comptes :'), userList)),
    h('div', { class: 'card' }, h('h3', {}, 'Limites et défaut'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Échanges par heure et par compte', maxPerHour, h('span', { class: 'hint' }, 'Chaque étape d\'une demande compte pour un échange.')),
        h('label', { class: 'field' }, 'Étapes par demande', maxSteps, h('span', { class: 'hint' }, 'Appels d\'outils enchaînés avant de rendre la main.')),
        h('label', { class: 'field' }, 'Fournisseur par défaut', defaultSel, h('span', { class: 'hint' }, 'Les comptes peuvent choisir parmi les fournisseurs prêts.')))),
    h('h3', { class: 'ai-providers-title' }, 'Fournisseurs'),
    ...cards.map((k) => k.el),
    errEl, h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer')),
    h('div', { class: 'card' }, h('h3', {}, 'Consommation (30 derniers jours)'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Compte'), h('th', {}, 'Fournisseur'), h('th', {}, 'Échanges'), h('th', {}, 'Jetons envoyés'), h('th', {}, 'Jetons reçus'))), usage))));
  root.replaceChildren(form);
  try {
    const rows = await api('/api/admin/ai/usage');
    usage.replaceChildren(...(rows.length ? rows.map((r) => h('tr', {}, h('td', {}, r.username), h('td', {}, c.providers.find((p) => p.id === r.provider)?.label || r.provider),
      h('td', {}, String(r.requests)), h('td', {}, r.prompt_tokens.toLocaleString('fr-FR')), h('td', {}, r.completion_tokens.toLocaleString('fr-FR'))))
      : [h('tr', {}, h('td', { colspan: 5, class: 'mut' }, 'Aucun échange.'))]));
  } catch {}
}
