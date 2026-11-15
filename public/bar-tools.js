// Outils de la barre du haut d'une application (tools dans apps.json) : calculatrice, convertisseur d'unités, couleurs.
// Un seul panneau ouvert à la fois ; Échap le ferme. Rien n'est envoyé au serveur.
import { h, icon } from '/ui.js';
import { mountCalculator } from '/calculator.js';
import { evaluate, formatNumber } from '/calc-eval.js';

// ---------- Panneau commun ----------
function panel(title, iconName, ...body) {
  const close = h('button', { type: 'button', class: 'btn icon ghost sm', 'aria-label': 'Fermer', title: 'Fermer (Échap)' }, icon('close'));
  const el = h('div', { class: 'calc tool-panel', role: 'dialog', 'aria-label': title, hidden: true },
    h('div', { class: 'calc-head' }, icon(iconName), h('strong', {}, title), close), ...body);
  document.body.append(el);
  return { el, close };
}
function wire(button, label, iconName, p, onOpen) {
  button.hidden = false;
  button.replaceChildren(icon(iconName), h('span', { class: 'agent-btn-label' }, label));
  button.setAttribute('aria-expanded', 'false');
  const toggle = (open = p.el.hidden) => {
    if (open) for (const other of document.querySelectorAll('.tool-panel:not([hidden]), .calc:not([hidden])')) if (other !== p.el) other.__close?.();
    p.el.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) onOpen?.(); else button.focus();
  };
  p.el.__close = () => toggle(false);
  p.close.onclick = () => toggle(false);
  p.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); toggle(false); } });
  button.onclick = () => toggle();
  return { toggle };
}
const copyBtn = (get) => {
  const b = h('button', { type: 'button', class: 'btn sm ghost', title: 'Copier' }, 'Copier');
  b.onclick = async () => { try { await navigator.clipboard.writeText(get()); b.textContent = 'Copié'; setTimeout(() => { b.textContent = 'Copier'; }, 1200); } catch {} };
  return b;
};

// ---------- Convertisseur d'unités ----------
const CATS = {
  'Longueur': { mm: 1, cm: 10, m: 1000, km: 1e6, in: 25.4, ft: 304.8, yd: 914.4, mi: 1609344, pt: 25.4 / 72, 'px (96 ppp)': 25.4 / 96 },
  'Surface': { 'mm²': 1, 'cm²': 100, 'm²': 1e6, ha: 1e10, 'km²': 1e12, 'in²': 645.16, 'ft²': 92903.04 },
  'Volume': { 'mm³': 1, 'cm³ (ml)': 1e3, l: 1e6, 'm³': 1e9, 'in³': 16387.064, 'ft³': 28316846.592, 'gal US': 3785411.784 },
  'Masse': { mg: 0.001, g: 1, kg: 1000, t: 1e6, oz: 28.349523125, lb: 453.59237 },
  'Angle': { '°': 1, rad: 180 / Math.PI, grad: 0.9, tour: 360 },
  'Température': { '°C': 'C', '°F': 'F', K: 'K' },
  'Données': { o: 1, Ko: 1e3, Mo: 1e6, Go: 1e9, Kio: 1024, Mio: 1024 ** 2, Gio: 1024 ** 3 },
};
function convert(cat, v, from, to) {
  const u = CATS[cat];
  if (cat !== 'Température') return (v * u[from]) / u[to];
  const c = from === '°C' ? v : from === '°F' ? ((v - 32) * 5) / 9 : v - 273.15;
  return to === '°C' ? c : to === '°F' ? (c * 9) / 5 + 32 : c + 273.15;
}
export function mountConverter(button) {
  let cat = 'Longueur';
  const catSel = h('select', { 'aria-label': 'Grandeur' }, ...Object.keys(CATS).map((c) => h('option', { value: c }, c)));
  const value = h('input', { type: 'text', inputmode: 'decimal', value: '1', 'aria-label': 'Valeur (calcul accepté)', class: 'calc-input' });
  const from = h('select', { 'aria-label': 'De' }), to = h('select', { 'aria-label': 'Vers' });
  const out = h('output', { class: 'calc-out' });
  const table = h('ul', { class: 'conv-all' });
  const swap = h('button', { type: 'button', class: 'btn sm icon', title: 'Inverser', 'aria-label': 'Inverser les unités' }, '⇄');
  const fillUnits = () => {
    const units = Object.keys(CATS[cat]);
    from.replaceChildren(...units.map((u) => h('option', { value: u }, u)));
    to.replaceChildren(...units.map((u) => h('option', { value: u }, u)));
    to.value = units[Math.min(1, units.length - 1)];
    if (cat === 'Longueur') { from.value = 'in'; to.value = 'mm'; }
  };
  let last = 0;
  function update() {
    let v;
    try { v = evaluate(value.value || '0', { deg: true }); } catch (e) { out.textContent = e.message; out.classList.add('err'); table.replaceChildren(); return; }
    out.classList.remove('err');
    last = convert(cat, v, from.value, to.value);
    out.textContent = `${formatNumber(last)} ${to.value}`;
    table.replaceChildren(...Object.keys(CATS[cat]).filter((u) => u !== from.value).map((u) => {
      const r = convert(cat, v, from.value, u);
      return h('li', {}, h('button', { type: 'button', title: 'Copier', onclick: () => navigator.clipboard?.writeText(String(r).replace('.', ',')).catch(() => {}) },
        h('span', {}, u), h('strong', {}, formatNumber(r))));
    }));
  }
  catSel.onchange = () => { cat = catSel.value; fillUnits(); update(); };
  from.onchange = to.onchange = update;
  value.addEventListener('input', update);
  swap.onclick = () => { const f = from.value; from.value = to.value; to.value = f; update(); };
  const p = panel('Convertisseur', 'convert', catSel, value, h('div', { class: 'conv-row' }, from, swap, to), h('div', { class: 'conv-res' }, out, copyBtn(() => String(last).replace('.', ','))), table);
  fillUnits(); update();
  return wire(button, 'Unités', 'convert', p, () => { value.focus(); value.select(); });
}

// ---------- Couleurs ----------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function parseColor(s) {
  const t = String(s).trim().toLowerCase();
  let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (m) { let x = m[1]; if (x.length === 3) x = [...x].map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(t);
  if (m) return m.slice(1, 4).map((x) => clamp(Number(x), 0, 255));
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(t);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}
function hslToRgb(hh, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + hh / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let hh = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh = (hh * 60 + 360) % 360;
  }
  return [Math.round(hh), Math.round(s * 100), Math.round(l * 100)];
}
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
function cmyk([r, g, b]) {
  const k = 1 - Math.max(r, g, b) / 255;
  if (k === 1) return [0, 0, 0, 100];
  return [r, g, b].map((v) => Math.round((100 * (1 - v / 255 - k)) / (1 - k))).concat(Math.round(k * 100));
}
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Styles posés par le CSSOM : la CSP refuse les attributs style en ligne.
const sample = (bg, fg, text) => { const el = h('span', {}, text); el.style.background = bg; el.style.color = fg; return el; };
export function mountColors(button) {
  let rgb = [47, 111, 237];
  let recent = [];
  try { recent = JSON.parse(sessionStorage.getItem('craft-colors') || '[]'); } catch {}
  const picker = h('input', { type: 'color', 'aria-label': 'Choisir une couleur', class: 'col-picker' });
  const text = h('input', { type: 'text', class: 'calc-input', 'aria-label': 'Couleur (HEX, rgb(), hsl())', spellcheck: false });
  const swatch = h('div', { class: 'col-swatch' });
  const rows = h('div', { class: 'col-rows' });
  const recentEl = h('div', { class: 'col-recent', 'aria-label': 'Couleurs récentes' });
  const eye = h('button', { type: 'button', class: 'btn sm', title: 'Prendre une couleur à l\'écran (application comprise)' }, icon('pipette'), 'Pipette');
  if (!('EyeDropper' in window)) { eye.disabled = true; eye.title = 'Pipette indisponible dans ce navigateur'; }
  const remember = () => {
    const x = hex(rgb);
    recent = [x, ...recent.filter((c) => c !== x)].slice(0, 12);
    try { sessionStorage.setItem('craft-colors', JSON.stringify(recent)); } catch {}
  };
  function render(fromText = false) {
    const [hh, s, l] = rgbToHsl(rgb), c = cmyk(rgb), x = hex(rgb);
    swatch.style.background = x;
    picker.value = x;
    if (!fromText) text.value = x.toUpperCase();
    const line = (label, value) => h('div', { class: 'col-row' }, h('span', { class: 'mut' }, label), h('code', {}, value), copyBtn(() => value));
    const cw = contrast(rgb, [255, 255, 255]), cb = contrast(rgb, [0, 0, 0]);
    rows.replaceChildren(line('HEX', x.toUpperCase()), line('RVB', `rgb(${rgb.join(', ')})`), line('TSL', `hsl(${hh}, ${s}%, ${l}%)`), line('CMJN', `${c.join(' % ')} %`),
      h('div', { class: 'col-contrast' },
        sample(x, '#fff', `Aa ${cw.toFixed(1)}`), sample(x, '#000', `Aa ${cb.toFixed(1)}`),
        h('span', { class: 'mut' }, `Contraste WCAG : ${Math.max(cw, cb) >= 4.5 ? 'texte lisible' : 'faible'} (4,5 pour du texte)`)));
    recentEl.replaceChildren(...recent.map((c2) => { const chip = h('button', { type: 'button', class: 'col-chip', title: c2.toUpperCase(), 'aria-label': c2.toUpperCase(), onclick: () => { rgb = parseColor(c2); render(); } }); chip.style.background = c2; return chip; }));
  }
  picker.addEventListener('input', () => { rgb = parseColor(picker.value); render(); });
  picker.addEventListener('change', () => { remember(); render(); });
  text.addEventListener('input', () => { const v = parseColor(text.value); if (v) { rgb = v; render(true); } });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && parseColor(text.value)) { remember(); render(); } });
  eye.onclick = async () => {
    try { const r = await new window.EyeDropper().open(); rgb = parseColor(r.sRGBHex); remember(); render(); } catch {} // annulé
  };
  const p = panel('Pipette', 'pipette', h('div', { class: 'col-top' }, swatch, h('div', { class: 'col-in' }, text, h('div', { class: 'row' }, picker, eye))), rows, recentEl);
  render();
  return wire(button, 'Pipette', 'pipette', p, () => text.focus());
}

// Boutons de la barre selon l'application.
const TOOLS = { calculator: (b) => mountCalculator(b), converter: mountConverter, colors: mountColors };
export function mountBarTools(container, tools = []) {
  for (const t of tools) {
    if (!TOOLS[t]) continue;
    const b = h('button', { type: 'button', class: 'btn agent-btn', dataset: { tool: t } });
    container.append(b);
    TOOLS[t](b);
  }
}
