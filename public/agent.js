// Assistant IA : panneau latéral commun à l'accueil et aux applications (voir src/ai.js pour le serveur).
// La page fournit ses outils ({ name, description, parameters, run(args), confirm?(args) }) et son contexte. La boucle :
// envoyer la conversation au serveur → le modèle répond ou demande des outils → la page les exécute ici (fichiers,
// commandes de l'application) → résultats renvoyés → … jusqu'à une réponse sans outil ou la limite d'étapes.
// Les outils avec confirm() (suppressions) attendent un clic de l'utilisateur dans le panneau.
// Rien n'est stocké : la conversation vit le temps de la page (choix du 15/11/2026).
import { api, h, icon, toast } from '/ui.js';

const MAX_RESULT = 24_000; // caractères d'un résultat d'outil renvoyé au modèle

export async function mountAgent({ button, context, tools, onBusy }) {
  let info;
  try { info = await api('/api/ai'); } catch { return null; }
  if (!info?.available) return null;
  button.hidden = false;
  button.replaceChildren(icon('sparkles'), h('span', { class: 'agent-btn-label' }, 'Assistant'));

  let messages = [], busy = false, stopped = false;
  const providerSel = h('select', { class: 'agent-provider', 'aria-label': 'Modèle', title: 'Fournisseur et modèle' },
    ...info.providers.map((p) => h('option', { value: p.id }, `${p.label} · ${p.model}`)));
  try { providerSel.value = localStorage.getItem('craft-agent-provider') || info.defaultProvider; } catch { providerSel.value = info.defaultProvider; }
  if (!providerSel.value) providerSel.value = info.defaultProvider;
  providerSel.onchange = () => { try { localStorage.setItem('craft-agent-provider', providerSel.value); } catch {} };
  if (info.providers.length < 2) providerSel.disabled = true;

  const log = h('div', { class: 'agent-log', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'agent-input', rows: 2, placeholder: 'Demandez à l\'assistant… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)', 'aria-label': 'Message à l\'assistant' });
  const sendBtn = h('button', { type: 'button', class: 'btn primary icon', 'aria-label': 'Envoyer', title: 'Envoyer' }, icon('send'));
  const panel = h('aside', { class: 'agent', role: 'complementary', 'aria-label': 'Assistant IA', hidden: true },
    h('div', { class: 'agent-head' }, icon('sparkles'), h('strong', {}, 'Assistant'), providerSel,
      h('button', { type: 'button', class: 'btn icon ghost sm', title: 'Nouvelle conversation', 'aria-label': 'Nouvelle conversation', onclick: reset }, icon('plus')),
      h('button', { type: 'button', class: 'btn icon ghost sm', title: 'Fermer', 'aria-label': 'Fermer l\'assistant', onclick: () => toggle(false) }, icon('close'))),
    log,
    h('div', { class: 'agent-foot' }, input, sendBtn));
  document.body.append(panel);

  function toggle(open = panel.hidden) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('agent-open', open);
    if (open) { if (!log.children.length) hello(); input.focus(); }
  }
  button.setAttribute('aria-expanded', 'false');
  button.onclick = () => toggle();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && panel.contains(document.activeElement) && !busy) toggle(false); });

  const add = (el) => { log.append(el); log.scrollTop = log.scrollHeight; return el; };
  const bubble = (role, text) => add(h('div', { class: `agent-msg ${role}` }, ...render(text)));
  function hello() {
    const ctx = context();
    add(h('div', { class: 'agent-msg note' }, ctx.page === 'home'
      ? 'Je peux chercher, filtrer, ranger, renommer et déplacer vos fichiers et dossiers. Exemple : « Range les PDF dans un dossier Factures ».'
      : ctx.hasApi ? `Je peux piloter ${ctx.appName} : « ajoute une page », « mets le titre en gras », « crée un cube de 20 mm »…`
        : `${ctx.appName} n'a pas d'interface de pilotage : je peux enregistrer, ranger le fichier et répondre aux questions, pas modifier le document.`));
  }
  function reset() { if (busy) stopped = true; messages = []; log.replaceChildren(); hello(); input.focus(); }

  // Texte simple : paragraphes, listes à puces, **gras** et `code` (aucun HTML venu du modèle n'est interprété).
  function render(text) {
    const out = [];
    for (const block of String(text || '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) out.push(h('ul', {}, ...lines.map((l) => h('li', {}, ...inline(l.replace(/^\s*[-*•]\s+/, ''))))));
      else out.push(h('p', {}, ...lines.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)))));
    }
    return out;
  }
  function inline(s) {
    return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((part) => (part.startsWith('**') ? h('strong', {}, part.slice(2, -2))
      : part.startsWith('`') ? h('code', {}, part.slice(1, -1)) : document.createTextNode(part)));
  }

  function step(label) {
    const el = add(h('div', { class: 'agent-step' }, h('span', { class: 'spin' }), label));
    return { done: (ok = true, detail = '') => { el.classList.add(ok ? 'ok' : 'err'); el.firstChild.replaceWith(icon(ok ? 'check' : 'close')); if (detail) el.append(h('span', { class: 'mut' }, ` — ${detail}`)); } };
  }
  function askConfirm(text) {
    return new Promise((resolve) => {
      const card = add(h('div', { class: 'agent-confirm' }, h('p', {}, text)));
      const done = (v) => { card.querySelectorAll('button').forEach((b) => { b.disabled = true; }); card.classList.add(v ? 'yes' : 'no'); resolve(v); };
      card.append(h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn sm danger solid', onclick: () => done(true) }, 'Confirmer'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => done(false) }, 'Refuser')));
    });
  }

  const defs = () => tools().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } }));
  async function runTool(call) {
    const t = tools().find((x) => x.name === call.function?.name);
    if (!t) return { error: `outil inconnu : ${call.function?.name}` };
    let args = {};
    try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { return { error: 'arguments JSON invalides' }; }
    const s = step(t.label?.(args) || t.name);
    try {
      if (t.confirm) {
        const ok = await askConfirm(await t.confirm(args));
        if (!ok) { s.done(false, 'refusé'); return { refused: true, message: 'L\'utilisateur a refusé.' }; }
      }
      const r = await t.run(args);
      s.done(true);
      return r ?? { ok: true };
    } catch (e) { s.done(false, e.message); return { error: e.message }; }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    bubble('user', text);
    messages.push({ role: 'user', content: text });
    busy = true; stopped = false; onBusy?.(true);
    sendBtn.replaceChildren(icon('stop')); sendBtn.title = 'Arrêter'; sendBtn.setAttribute('aria-label', 'Arrêter');
    const thinking = add(h('div', { class: 'agent-thinking' }, h('span', { class: 'spin' }), 'Réflexion…'));
    try {
      for (let i = 0; i < info.maxSteps && !stopped; i++) {
        const r = await api('/api/ai/chat', { method: 'POST', body: { provider: providerSel.value, messages, tools: defs(), context: context() } });
        if (stopped) break;
        const m = r.message || {};
        const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter((c) => c?.function?.name) : [];
        messages.push({ role: 'assistant', content: m.content ?? null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments || '{}' } })) } : {}) });
        if (m.content) log.insertBefore(h('div', { class: 'agent-msg assistant' }, ...render(m.content)), thinking);
        if (!calls.length) break;
        for (const c of calls) {
          if (stopped) break;
          log.insertBefore(thinking, null);
          const result = await runTool(c);
          log.append(thinking);
          let content = JSON.stringify(result);
          if (content.length > MAX_RESULT) content = `${content.slice(0, MAX_RESULT)}… (tronqué)`;
          messages.push({ role: 'tool', tool_call_id: c.id, content });
        }
        if (i === info.maxSteps - 1) add(h('div', { class: 'agent-msg note' }, `Arrêté après ${info.maxSteps} étapes. Dites « continue » pour poursuivre.`));
      }
      if (stopped) add(h('div', { class: 'agent-msg note' }, 'Arrêté.'));
    } catch (e) {
      add(h('div', { class: 'agent-msg error' }, e.message));
      // Le dernier message assistant sans réponse d'outil rendrait la conversation invalide : on le retire.
      while (messages.length && messages.at(-1).role === 'assistant' && messages.at(-1).tool_calls) messages.pop();
    } finally {
      thinking.remove();
      busy = false; onBusy?.(false);
      sendBtn.replaceChildren(icon('send')); sendBtn.title = 'Envoyer'; sendBtn.setAttribute('aria-label', 'Envoyer');
      input.focus();
    }
  }
  sendBtn.onclick = () => (busy ? (stopped = true) : send());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  return { open: () => toggle(true), close: () => toggle(false) };
}

// Résultat d'outil sûr pour JSON (commandes des applications : objets quelconques).
export function plain(v, depth = 0) {
  if (v === undefined) return null;
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? String(v) : v;
  if (depth > 6) return '…';
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `(${v.byteLength} octets)`;
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => plain(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v).slice(0, 300)) out[k] = plain(v[k], depth + 1);
  return out;
}
