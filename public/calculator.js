// Calculatrice de la barre du haut (applications qui la déclarent : tools: ["calculator"] dans apps.json, SolidCraft).
// Analyseur maison (aucun eval : interdit par la CSP, et inutile) : + − × ÷ % ^, parenthèses, multiplication implicite
// (2pi, 3(4+1)), virgule ou point décimal, fonctions (sqrt, cbrt, sin, cos, tan, asin, acos, atan, ln, log, exp, abs,
// round, floor, ceil, min, max, hypot ; arguments séparés par « ; »), constantes pi, π, e, tau, « ans » (dernier
// résultat), unités de longueur en, mm, cm, m, in, ft (résultat en mm). Angles en degrés ou radians au choix.
import { h, icon } from '/ui.js';
import { evaluate, formatNumber } from '/calc-eval.js';

export function mountCalculator(button) {
  let ans = 0, deg = true;
  const hist = [];
  try { Object.assign(hist, JSON.parse(sessionStorage.getItem('craft-calc') || '[]')); ans = hist.at(-1)?.v ?? 0; } catch {}
  const input = h('input', { type: 'text', class: 'calc-input', inputmode: 'decimal', autocomplete: 'off', spellcheck: false, 'aria-label': 'Calcul', placeholder: 'ex. 2 × (15 + 3,5)' });
  const out = h('output', { class: 'calc-out', 'aria-live': 'polite' }, '0');
  const list = h('ol', { class: 'calc-hist', 'aria-label': 'Historique' });
  const degBtn = h('button', { type: 'button', class: 'btn sm calc-mode', title: 'Unité des angles' });
  const syncDeg = () => { degBtn.textContent = deg ? 'DEG' : 'RAD'; degBtn.setAttribute('aria-pressed', String(deg)); };
  degBtn.onclick = () => { deg = !deg; syncDeg(); input.focus(); };
  syncDeg();
  const insert = (t) => {
    const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
    input.value = input.value.slice(0, a) + t + input.value.slice(b);
    const p = a + t.length - (t.endsWith('()') ? 1 : 0);
    input.setSelectionRange(p, p); input.focus(); preview();
  };
  function preview() {
    if (!input.value.trim()) { out.textContent = formatNumber(ans); out.classList.remove('err', 'live'); return; }
    try { out.textContent = `= ${formatNumber(evaluate(input.value, { deg, ans }))}`; out.classList.remove('err'); out.classList.add('live'); }
    catch { out.classList.remove('live'); }
  }
  function run() {
    if (!input.value.trim()) return;
    try {
      const v = evaluate(input.value, { deg, ans });
      ans = v;
      hist.push({ e: input.value.trim(), v });
      if (hist.length > 30) hist.shift();
      try { sessionStorage.setItem('craft-calc', JSON.stringify(hist)); } catch {}
      out.textContent = formatNumber(v); out.classList.remove('err', 'live');
      input.value = '';
      renderHist();
    } catch (e) { out.textContent = e.message; out.classList.add('err'); }
  }
  function renderHist() {
    list.replaceChildren(...hist.slice(-8).reverse().map((x) => h('li', {},
      h('button', { type: 'button', title: 'Reprendre ce calcul', onclick: () => { input.value = x.e; preview(); input.focus(); } }, x.e),
      h('button', { type: 'button', class: 'res', title: 'Insérer ce résultat', onclick: () => insert(String(x.v).replace('.', ',')) }, `= ${formatNumber(x.v)}`))));
  }
  const key = (label, act, cls = '') => h('button', { type: 'button', class: `calc-key ${cls}`, onclick: act }, label);
  const keys = [
    ['(', ')', '%', '÷', '√'], ['7', '8', '9', '×', '^'], ['4', '5', '6', '−', 'π'], ['1', '2', '3', '+', 'sin'], ['0', ',', 'ans', '=', 'cos'],
  ];
  const pad = h('div', { class: 'calc-pad' }, ...keys.flat().map((k) => key(k,
    k === '=' ? run : () => insert(k === '√' ? 'sqrt()' : ['sin', 'cos'].includes(k) ? `${k}()` : k === 'ans' ? 'ans' : k),
    k === '=' ? 'eq' : /^[\d,]$/.test(k) ? 'num' : '')));
  const copyBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => { navigator.clipboard?.writeText(String(ans).replace('.', ',')).catch(() => {}); } }, 'Copier');
  const panel = h('div', { class: 'calc', role: 'dialog', 'aria-label': 'Calculatrice', hidden: true },
    h('div', { class: 'calc-head' }, icon('calc'), h('strong', {}, 'Calculatrice'), degBtn,
      h('button', { type: 'button', class: 'btn icon ghost sm', 'aria-label': 'Fermer', title: 'Fermer (Échap)', onclick: () => toggle(false) }, icon('close'))),
    out, input, pad,
    h('div', { class: 'calc-foot' }, h('span', { class: 'mut' }, 'Unités : 2in, 3cm… → mm ; fonctions : sqrt, sin, atan, ln, round(x;2)…'), copyBtn),
    list);
  document.body.append(panel);
  input.addEventListener('input', preview);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'Escape') { e.preventDefault(); toggle(false); }
    else if (e.key === 'ArrowUp' && !input.value && hist.length) { e.preventDefault(); input.value = hist.at(-1).e; preview(); }
  });
  function toggle(open = panel.hidden) {
    if (open) for (const other of document.querySelectorAll('.tool-panel:not([hidden])')) if (other !== panel) other.__close?.();
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) { renderHist(); preview(); input.focus(); } else button.focus();
  }
  panel.classList.add('tool-panel');
  panel.__close = () => toggle(false);
  button.hidden = false;
  button.replaceChildren(icon('calc'), h('span', { class: 'agent-btn-label' }, 'Calculatrice'));
  button.setAttribute('aria-expanded', 'false');
  button.onclick = () => toggle();
  return { toggle };
}
