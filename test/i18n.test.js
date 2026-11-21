// Traduction anglaise : chaque texte de l'interface (t('…'), data-i18n, data-i18n-attr) et chaque message d'erreur du
// serveur a sa traduction ; les variables {x} sont conservées ; le serveur choisit la langue selon Accept-Language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { langOf, translate } from '../src/i18n.js';
import SERVER_EN, { PATTERNS, BOARD_ADMIN } from '../src/i18n-en.js';
import { SECTION_TITLES, EFFORT_LABELS, AUDIT_LABELS } from '../src/kosmy-admin.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pub = join(ROOT, 'public');
const EN = {};
for (const f of readdirSync(join(pub, 'i18n'))) Object.assign(EN, (await import(`../public/i18n/${f}`)).default);

// Premier argument littéral de t(…) : '…', "…" ou `…` sans ${}.
function tKeys(src) {
  const out = [], bad = [];
  const re = /\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] === '`' && m[2].includes('${')) bad.push(m[2]);
    else out.push(m[2].replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'));
  }
  return { keys: out, bad };
}
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('interface : chaque t(…) a sa traduction, avec les mêmes variables', () => {
  const missing = [], wrongVars = [], templates = [];
  for (const f of readdirSync(pub).filter((x) => x.endsWith('.js'))) {
    const { keys, bad } = tKeys(readFileSync(join(pub, f), 'utf8'));
    templates.push(...bad.map((b) => `${f} : ${b}`));
    for (const k of keys) {
      if (!(k in EN)) missing.push(`${f} : ${k}`);
      else if (vars(k).join() !== vars(EN[k]).join()) wrongVars.push(`${f} : ${k} → ${EN[k]}`);
    }
  }
  assert.deepEqual(templates, [], 't(`…${x}…`) interdit : utiliser t(\'… {x} …\', { x })');
  assert.deepEqual(missing, [], 'traductions manquantes');
  assert.deepEqual(wrongVars, [], 'variables différentes');
});

test('pages : textes data-i18n et attributs data-i18n-attr traduits', () => {
  const missing = [];
  for (const f of readdirSync(pub).filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(join(pub, f), 'utf8');
    for (const m of html.matchAll(/<(\w+)([^>]*\bdata-i18n(?:="([^"]*)")?[^>]*)>([^<]*)</g)) {
      if (/data-i18n-attr/.test(m[2]) && !/\bdata-i18n(=|\s|>)/.test(m[2] + '>')) continue;
      const key = (m[3] || m[4]).trim();
      if (key && !(key in EN)) missing.push(`${f} : ${key}`);
    }
    for (const m of html.matchAll(/<\w+([^>]*\bdata-i18n-attr="([^"]+)"[^>]*)>/g)) {
      for (const a of m[2].split(',')) {
        const v = new RegExp(`\\b${a.trim()}="([^"]*)"`).exec(m[1])?.[1];
        if (v && !(v in EN)) missing.push(`${f} [${a.trim()}] : ${v}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'traductions manquantes dans les pages');
});

test('serveur : chaque message d\'erreur a sa traduction (exacte ou motif)', () => {
  const missing = [];
  for (const f of readdirSync(join(ROOT, 'src')).filter((x) => x.endsWith('.js') && !x.startsWith('i18n'))) {
    const src = readFileSync(join(ROOT, 'src', f), 'utf8');
    const msgs = [
      ...[...src.matchAll(/\berr\(\d{3},\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]),
      ...[...src.matchAll(/\berror:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]),
      ...[...src.matchAll(/\bbad\(res,\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]),
      ...[...src.matchAll(/new Error\((['"`])((?:\\.|(?!\1)[^\\])*)\1\), \{ status/g)].map((m) => m[2]),
    ];
    for (const raw of msgs) {
      // ${p.label} : un nom de fournisseur d'IA (le motif général n'accepte que ceux-là).
      const msg = raw.replace(/\\'/g, "'").replace(/\$\{p\.label\}/g, 'OpenRouter').replace(/\$\{[^}]+\}/g, 'X');
      if (!/[a-zà-ÿ]/i.test(msg)) continue;
      const ok = msg in SERVER_EN || PATTERNS.some(([re]) => re.test(msg));
      if (!ok) missing.push(`${f} : ${raw}`);
    }
  }
  assert.deepEqual(missing, [], 'messages du serveur sans traduction');
});

test('admin dans Kosmy Board : chaque texte a sa traduction (interface, serveur ou BOARD_ADMIN), avec les mêmes variables', async () => {
  const UI = { ...(await import('../public/i18n/en-account.js')).default, ...(await import('../public/i18n/en-common.js')).default };
  const { keys, bad } = tKeys(readFileSync(join(ROOT, 'src', 'kosmy-admin.js'), 'utf8'));
  const all = [...keys, ...Object.values(SECTION_TITLES), ...Object.values(EFFORT_LABELS), ...Object.values(AUDIT_LABELS)];
  const en = (k) => BOARD_ADMIN[k] ?? UI[k] ?? SERVER_EN[k] ?? (PATTERNS.some(([re]) => re.test(k)) ? k : undefined);
  const missing = all.filter((k) => en(k) === undefined);
  const wrongVars = all.filter((k) => en(k) !== undefined && vars(k).join() !== vars(en(k)).join());
  assert.deepEqual(bad, [], 't(`…${x}…`) interdit');
  assert.deepEqual([...new Set(missing)], [], 'traductions manquantes');
  assert.deepEqual(wrongVars, [], 'variables différentes');
  const unused = Object.keys(BOARD_ADMIN).filter((k) => !all.includes(k));
  assert.deepEqual(unused, [], 'textes de BOARD_ADMIN inutilisés');
});

test('langue du serveur selon Accept-Language ; français sans en-tête', () => {
  const req = (h) => ({ headers: h === undefined ? {} : { 'accept-language': h } });
  assert.equal(langOf(req()), 'fr');
  assert.equal(langOf(req('fr-FR,fr;q=0.9,en;q=0.8')), 'fr');
  assert.equal(langOf(req('en-US,en;q=0.9')), 'en');
  assert.equal(langOf(req('de-DE,de;q=0.9')), 'en');
  assert.equal(langOf(req('en;q=0.5, fr;q=0.9')), 'fr');
  assert.equal(langOf(req('*')), 'fr', 'fetch de Node envoie « * » par défaut');
  assert.equal(translate('fr', 'Introuvable.'), 'Introuvable.');
});

test('serveur réel : message d\'erreur en anglais avec Accept-Language: en-US, en français sans en-tête', async () => {
  const { startServer } = await import('./helpers.js');
  const s = await startServer();
  try {
    const admin = s.client();
    assert.equal((await admin.post('/api/auth/register', { username: 'admin', password: 'motdepasse1' })).status, 201);
    const en = { headers: { 'accept-language': 'en-US,en;q=0.9' } };
    const u = s.client();
    const loginEn = await u.post('/api/auth/login', { username: 'admin', password: 'mauvais-mot' }, en);
    assert.equal(loginEn.status, 401);
    assert.equal(loginEn.data.error, 'Incorrect username or password.');
    const loginFr = await u.post('/api/auth/login', { username: 'admin', password: 'mauvais-mot' });
    assert.equal(loginFr.data.error, 'Identifiant ou mot de passe incorrect.');
    const folderEn = await admin.post('/api/folders', { name: '../x' }, en);
    assert.equal(folderEn.status, 400);
    assert.equal(folderEn.data.error, 'Invalid folder name.');
    assert.equal((await admin.post('/api/folders', { name: '../x' })).data.error, 'Nom de dossier invalide.');
    const weak = await s.client().post('/api/auth/register', { username: 'bob', password: 'x' }, en);
    assert.equal(weak.data.error, 'Sign-ups are closed.');
    assert.equal((await admin.post('/api/admin/users', { username: 'bob', password: 'court', role: 'user' }, en)).data.error,
      'Password: at least 8 characters.', 'message avec une valeur : motif');
  } finally { s.close(); }
});
