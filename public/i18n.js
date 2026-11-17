// Langue de l'interface : celle du navigateur (français si elle commence par « fr », sinon anglais).
// Les textes restent écrits en français dans le code : t(« Texte {n} », { n }) renvoie le français, ou sa traduction
// anglaise (public/i18n/en-*.js). Une phrase sans traduction reste en français (test/i18n.test.js veille à ce qu'il n'y
// en ait pas). Pages : les éléments marqués data-i18n (texte) et data-i18n-attr="title,placeholder,aria-label"
// (valeurs des attributs) sont traduits par translateDom ; la page reste masquée jusque-là (theme.js).
import explorer from '/i18n/en-explorer.js';
import host from '/i18n/en-host.js';
import common from '/i18n/en-common.js';
import account from '/i18n/en-account.js';

const EN = { ...common, ...explorer, ...host, ...account };
export const lang = (() => {
  try { return String(navigator.languages?.[0] || navigator.language || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en'; } catch { return 'fr'; }
})();
export const locale = lang === 'fr' ? 'fr-FR' : (navigator.languages?.find((l) => /^en/i.test(l)) || 'en-US');
document.documentElement.lang = lang;

export function t(fr, vars) {
  let s = lang === 'fr' ? fr : (EN[fr] ?? fr);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}
export function translateDom(root = document) {
  if (lang !== 'fr') {
    for (const el of root.querySelectorAll('[data-i18n]')) {
      const key = el.dataset.i18n || el.textContent.trim();
      el.dataset.i18n = key;
      el.textContent = t(key);
    }
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
      for (const a of el.dataset.i18nAttr.split(',')) { const v = el.getAttribute(a.trim()); if (v) el.setAttribute(a.trim(), t(v)); }
    }
  }
  document.documentElement.classList.remove('i18n-pending');
}
