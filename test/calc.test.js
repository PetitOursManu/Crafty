// Calculatrice : priorités, multiplication implicite, virgule, fonctions, angles, unités, erreurs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate as ev, formatNumber } from '../public/calc-eval.js';

test('opérations et priorités', () => {
  assert.equal(ev('2 + 3 × 4'), 14);
  assert.equal(ev('(2 + 3) * 4'), 20);
  assert.equal(ev('2 ^ 3 ^ 2'), 512);
  assert.equal(ev('-2^2'), -4);
  assert.equal(ev('10 % 4'), 2);
  assert.equal(ev('7 ÷ 2'), 3.5);
  assert.equal(ev('2,5 * 2'), 5);
  assert.equal(ev('2pi'), 2 * Math.PI);
  assert.equal(ev('3(4+1)'), 15);
  assert.equal(ev('1e3 + 1'), 1001);
});

test('fonctions, angles, ans, unités', () => {
  assert.ok(Math.abs(ev('sin(30)') - 0.5) < 1e-12);
  assert.ok(Math.abs(ev('sin(pi/6)', { deg: false }) - 0.5) < 1e-12);
  assert.ok(Math.abs(ev('atan(1)') - 45) < 1e-12);
  assert.equal(ev('sqrt(16) + cbrt(27)'), 7);
  assert.equal(ev('round(2,345;2)'), 2.35);
  assert.equal(ev('max(3; 9; 4)'), 9);
  assert.equal(ev('log(1000)'), 3);
  assert.equal(ev('ans * 2', { ans: 21 }), 42);
  assert.equal(ev('2in'), 50.8);
  assert.equal(ev('3cm + 4mm'), 34);
  assert.equal(ev('√(9)'), 3);
});

test('erreurs claires', () => {
  assert.throws(() => ev('1 / 0'), /division par zéro/);
  assert.throws(() => ev('(1 + 2'), /parenthèse/);
  assert.throws(() => ev('2 +'), /incomplète/);
  assert.throws(() => ev('foo(2)'), /inconnu/);
  assert.throws(() => ev('sqrt(-1)'), /négatif/);
  assert.throws(() => ev(''), /vide/);
});

test('affichage français', () => {
  assert.equal(formatNumber(1234.5), '1 234,5');
  assert.equal(formatNumber(0.1 + 0.2), '0,3');
});
