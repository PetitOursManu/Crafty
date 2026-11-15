// Analyseur de la calculatrice (voir calculator.js), sans dépendance : utilisable par node:test.
const UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }; // en millimètres

export function evaluate(src, { deg = true, ans = 0 } = {}) {
  const s = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/π/g, 'pi').replace(/√/g, 'sqrt').trim();
  let i = 0;
  const err = (m) => { throw new Error(m); };
  const peek = () => { while (s[i] === ' ') i++; return s[i]; };
  const eat = (c) => (peek() === c ? (i++, true) : false);
  const rad = (x) => (deg ? (x * Math.PI) / 180 : x), unrad = (x) => (deg ? (x * 180) / Math.PI : x);
  const FN = {
    sqrt: (x) => (x < 0 ? err('racine d\'un nombre négatif') : Math.sqrt(x)), cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
    ln: (x) => (x <= 0 ? err('logarithme d\'un nombre ≤ 0') : Math.log(x)), log: (x, b) => (x <= 0 ? err('logarithme d\'un nombre ≤ 0') : b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
    sin: (x) => Math.sin(rad(x)), cos: (x) => Math.cos(rad(x)), tan: (x) => Math.tan(rad(x)),
    asin: (x) => unrad(Math.asin(x)), acos: (x) => unrad(Math.acos(x)), atan: (x) => unrad(Math.atan(x)), atan2: (y, x) => unrad(Math.atan2(y, x)),
    round: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max, hypot: Math.hypot,
  };
  const CONST = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, ans };
  function number() {
    const m = /^(\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0].replace(',', '.'));
  }
  function primary() {
    const c = peek();
    if (c === undefined) err('expression incomplète');
    if (eat('(')) { const v = expr(); if (!eat(')')) err('parenthèse non fermée'); return v; }
    const n = number();
    if (n !== null) return n;
    const m = /^[a-zA-Z_]+/.exec(s.slice(i));
    if (!m) err(`caractère inattendu « ${c} »`);
    const name = m[0].toLowerCase();
    i += m[0].length;
    if (FN[name]) {
      if (!eat('(')) err(`${name}(…) attend des parenthèses`);
      const args = [expr()];
      while (eat(';')) args.push(expr());
      if (!eat(')')) err('parenthèse non fermée');
      const v = FN[name](...args);
      return v;
    }
    if (name in CONST) return CONST[name];
    if (name in UNITS) err(`unité « ${name} » sans nombre devant`);
    err(`inconnu : « ${m[0]} »`);
  }
  // Unité après un nombre ou une parenthèse : 2in → 50,8 (mm).
  function withUnit(v) {
    const m = /^(mm|cm|m|in|ft)\b/.exec(s.slice(i).replace(/^ +/, ''));
    if (!m) return v;
    peek(); i += m[1].length;
    return v * UNITS[m[1]];
  }
  function power() {
    let v = withUnit(primary());
    if (eat('^')) v **= unary(); // associatif à droite
    return v;
  }
  function unary() { if (eat('-')) return -unary(); if (eat('+')) return unary(); return power(); }
  function term() {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) { const d = unary(); if (d === 0) err('division par zéro'); v /= d; }
      else if (eat('%')) v %= unary();
      else if (/[\d(a-zA-Z.]/.test(peek() || '')) v *= unary(); // multiplication implicite : 2pi, 3(4+1)
      else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) { if (eat('+')) v += term(); else if (eat('-')) v -= term(); else return v; }
  }
  if (!s) err('expression vide');
  const v = expr();
  if (peek() !== undefined) err(`en trop : « ${s.slice(i)} »`);
  if (!Number.isFinite(v)) err('résultat non fini');
  return v;
}

export const formatNumber = (v) => (Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-9 && v !== 0)
  ? v.toExponential(8).replace(/\.?0+e/, 'e')
  : Number(v.toPrecision(12)).toLocaleString('fr-FR', { maximumFractionDigits: 10, useGrouping: true }));

