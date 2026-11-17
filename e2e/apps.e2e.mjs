// Test de bout en bout (npm run test:e2e) dans Chrome (HEADED=1 pour voir la fenêtre), avec les vraies
// applications de vendor/, la CSP stricte et une base temporaire :
// connexion → explorateur → double-clic sur le fichier → modification → Ctrl+S au clavier → nouvelle version →
// rechargement → la modification est là ; quota plein → alerte rouge → « Réessayer » ; invité → téléchargement.
// Ignoré si vendor/ ou le navigateur manquent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, tuneServer } from '../src/app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const apps = JSON.parse(readFileSync(ROOT + 'apps.json', 'utf8'));
let pw;
try { pw = await import('../scripts/pw.mjs'); } catch { /* playwright-core absent */ }
const browserOk = pw && existsSync(pw.chromiumPath() || '');
const SAMPLES = join(ROOT, 'test', 'samples');
if (!existsSync(join(SAMPLES, 'test.docx'))) execFileSync(process.execPath, [join(ROOT, 'scripts', 'make-samples.mjs')]);

const CASES = {
  pdfcraft: { sample: 'test.pdf', modify: (a) => a.execute('page.insert_blank'), check: async (a) => (await a.docInspect()).documents[0].pages, expect: 4 },
  wordcraft: { sample: 'test.docx', modify: (a) => a.execute('text.insert', { text: 'E2E ' }), check: async (a) => (await a.docInspect()).blocks[0].text.startsWith('E2E '), expect: true },
};
const missing = (slug) => !apps[slug] ? `${slug} absent de apps.json`
  : !existsSync(join(ROOT, 'vendor', slug, apps[slug].version, 'index.html')) ? `vendor/${slug} absent (npm run fetch ${slug})`
  : !browserOk ? 'navigateur introuvable (PW_CHROMIUM)' : false;

let srv, base, dataDir, db;
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'craft-e2e-'));
  const app = createApp({ dataDir, quiet: true });
  db = app.locals.db;
  srv = tuneServer(app.listen(0, '127.0.0.1'));
  await new Promise((r) => srv.once('listening', r));
  base = `http://localhost:${srv.address().port}`;
});
after(() => { srv?.close(); db?.close(); rmSync(dataDir, { recursive: true, force: true }); });

let user = 0;
// Compte e2e0 (créé par le premier test ; créé ici s'il manque, pour lancer un test seul avec --test-name-pattern).
// La session est réutilisée d'un navigateur à l'autre : la suite ouvre plus de 8 sessions par minute, la limite par IP.
let e2e0Cookies;
async function loginE2e0(b) {
  const creds = { username: 'e2e0', password: 'motdepasse1' };
  if (e2e0Cookies) {
    await b.context.addCookies(e2e0Cookies);
    if ((await b.api('GET', '/api/me')).status === 200) return;
    await b.context.clearCookies();
  }
  let r = await b.api('POST', '/api/auth/login', { json: creds });
  for (let i = 0; r.status === 429 && i < 13; i++) { await b.page.waitForTimeout(5000); r = await b.api('POST', '/api/auth/login', { json: creds }); }
  if (r.status !== 200) {
    r = await b.api('POST', '/api/auth/register', { json: creds });
    assert.ok(r.status < 300, `connexion e2e0 impossible : ${r.status} ${JSON.stringify(r.body)}`);
    if (user === 0) user = 1;
  }
  e2e0Cookies = await b.context.cookies();
}
for (const [slug, c] of Object.entries(CASES)) {
  test(`${slug} : explorateur → ouvrir → modifier → Ctrl+S → version → recharger ; échec de stockage`, { skip: missing(slug), timeout: 180_000 }, async () => {
    const b = await pw.browserFor(base, { headless: !process.env.HEADED });
    const p = b.page;
    try {
      // Connexion par le formulaire (le premier compte du test devient admin).
      const name = `e2e${user++}`;
      if (user === 1) {
        await p.goto(`${base}/`);
        await p.fill('input[name=username]', name);
        await p.fill('input[autocomplete=new-password] >> nth=0', 'motdepasse1');
        await p.fill('input[autocomplete=new-password] >> nth=1', 'motdepasse1');
        await p.click('button[type=submit]');
      } else {
        await loginE2e0(b);
        await p.goto(`${base}/`);
      }
      await p.waitForSelector('#crumbs button');
      const file = await b.upload(join(SAMPLES, c.sample));
      await p.reload();
      // Double-clic dans l'explorateur → page hôte avec la dernière application (ou celle du format).
      await p.dblclick(`.item[data-key="f:${file.id}"]`);
      await p.waitForURL(/\/host\.html\?/);
      assert.match(p.url(), new RegExp(`app=${slug}&file=${file.id}`));
      await p.goto(`${p.url()}&control`);
      await b.waitFor(() => window.hostState?.ready && window.hostState.file && window.hostState.control === true, 90_000);
      let st = await b.state();
      assert.equal(st.ready.version, '1');
      assert.equal(st.ready.appVersion, apps[slug].version);
      assert.equal(await p.textContent('#docName'), c.sample);
      await p.waitForTimeout(1500);
      await b.inApp(slug, c.modify);
      await b.waitFor(() => window.hostState.dirty === true, 10_000);
      assert.match(await p.textContent('#statusText'), /non enregistrées/);

      // Ctrl+S réel, focus dans l'iframe.
      await b.clickApp(600, 500);
      await p.keyboard.press('Control+s');
      await b.waitFor(() => window.hostState.saves[0]?.status === 'ok', 15_000);
      await b.waitFor(() => !window.hostState.dirty, 10_000);
      assert.match(await p.textContent('#statusText'), /^Enregistré/);
      const vs = (await b.api('GET', `/api/files/${file.id}/versions`)).body;
      assert.equal(vs.length, 2, 'un enregistrement = une nouvelle version du même fichier');
      assert.equal(vs[0].app, slug);
      assert.equal((await b.api('GET', '/api/fs')).body.files.length, user, 'pas de nouveau fichier');
      assert.equal((await b.api('GET', `/api/files/${file.id}`)).body.lastApp, slug);

      // Rechargement : la modification est dans le fichier stocké.
      await p.reload();
      await b.waitFor(() => window.hostState?.ready && window.hostState.file && window.hostState.control === true, 90_000);
      await p.waitForTimeout(1500);
      assert.equal(await b.inApp(slug, c.check), c.expect);

      // Stockage en échec (quota plein) : l'application se croit enregistrée, l'hôte affiche l'alerte rouge.
      const me = (await b.api('GET', '/api/me')).body.user;
      const admin = await pw.browserFor(base);
      await admin.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
      await admin.api('PATCH', `/api/admin/users/${me.id}`, { json: { quota: 10 } });
      await b.inApp(slug, c.modify);
      await b.waitFor(() => window.hostState.dirty === true, 10_000);
      await b.inApp(slug, (a) => a.execute('file.save'));
      await b.waitFor(() => window.hostState.unsaved, 10_000);
      assert.equal((await b.state()).dirty, false, 'l\'application se croit enregistrée');
      assert.match(await p.textContent('.toast.error'), /Attention : fichier non sauvegardé/);
      assert.equal(await p.textContent('#statusText'), 'Non sauvegardé');
      await admin.api('PATCH', `/api/admin/users/${me.id}`, { json: { quota: null } });
      await admin.close();
      await p.click('.toast.error .btn');
      await b.waitFor(() => !window.hostState.unsaved, 10_000);
      assert.equal(await p.locator('.toast.error').count(), 0);
      assert.equal((await b.api('GET', `/api/files/${file.id}/versions`)).body.length, 3);

      assert.deepEqual(b.consoleMsgs.filter((m) => /Content Security Policy|TrustedScript/.test(m)), [], 'violation de CSP');
      if (user === 1) await b.api('PATCH', '/api/admin/settings', { json: { guest_enabled: true } }); // pour le test invité
    } finally { await b.close(); }
  });
}

test('pdfcraft : sauvegarde automatique (une seule version auto), thème du compte, garde contre un autre document', { skip: missing('pdfcraft'), timeout: 180_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED, colorScheme: 'dark' });
  const p = b.page;
  try {
    await loginE2e0(b);
    await b.api('PATCH', '/api/admin/settings', { json: { autosave_seconds: 2 } });
    await b.api('PATCH', '/api/me', { json: { theme: 'light' } });
    const file = await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Auto.pdf' });
    // Pas de &control dans l'URL : la page hôte l'ajoute toujours.
    await b.host({ app: 'pdfcraft', file: file.id });
    assert.match(await p.locator('#app').getAttribute('src'), /[?&]control(&|$)/);
    await b.waitFor(() => window.hostState.file && window.hostState.control === true, 60_000);
    // Thème du compte (clair) appliqué à PdfCraft alors que le système est en sombre.
    await b.waitFor(() => window.hostLog.some((l) => l.text === "thème de l'application : light"), 30_000);
    await p.waitForTimeout(1000);

    await b.inApp('pdfcraft', (a) => a.execute('page.insert_blank'));
    await b.waitFor(() => window.hostState.autosaves === 1, 20_000); // aucune touche pressée
    await b.waitFor(() => !window.hostState.dirty, 10_000);
    assert.match(await p.textContent('#statusText'), /^Enregistré automatiquement/);
    let vs = (await b.api('GET', `/api/files/${file.id}/versions`)).body;
    assert.deepEqual(vs.map((v) => [v.n, v.auto]), [[2, true], [1, false]]);
    await b.inApp('pdfcraft', (a) => a.execute('page.insert_blank'));
    await b.waitFor(() => window.hostState.autosaves === 2, 20_000);
    vs = (await b.api('GET', `/api/files/${file.id}/versions`)).body;
    assert.deepEqual(vs.map((v) => [v.n, v.auto]), [[2, true], [1, false]], 'la seconde auto remplace la première');
    assert.equal((await b.inApp('pdfcraft', (a) => a.docInspect())).documents[0].pages, 5);
    // Ctrl+S explicite : nouvelle version, non automatique.
    await b.inApp('pdfcraft', (a) => a.execute('page.insert_blank'));
    await b.waitFor(() => window.hostState.dirty === true);
    await b.clickApp(600, 500);
    await p.keyboard.press('Control+s');
    await b.waitFor(() => window.hostState.saves.length === 3 && window.hostState.saves[2].status === 'ok', 15_000);
    vs = (await b.api('GET', `/api/files/${file.id}/versions`)).body;
    assert.deepEqual(vs.map((v) => [v.n, v.auto]), [[3, false], [2, true], [1, false]]);

    // Un autre document ouvert dans l'application elle-même ne doit pas écraser le fichier stocké.
    await p.evaluate(async () => {
      const bytes = await (await fetch(`/api/files/${window.hostState.file.id}/content`)).arrayBuffer();
      window.hostApi.send('open', { name: 'autre.pdf', bytes }, [bytes]);
    });
    await p.waitForTimeout(1500);
    // PdfCraft l'ouvre dans un onglet en arrière-plan (vérifié) : on passe dessus, puis Enregistrer.
    await b.inApp('pdfcraft', (a) => a.execute('view.next_tab'));
    await b.inApp('pdfcraft', (a) => a.execute('file.save'));
    await p.waitForSelector('dialog[open] input');
    assert.equal(await p.inputValue('dialog[open] input'), 'autre.pdf');
    await p.click('dialog[open] button[value=cancel]');
    vs = (await b.api('GET', `/api/files/${file.id}/versions`)).body;
    assert.equal(vs.length, 3, 'fichier stocké intact');
    assert.deepEqual(b.consoleMsgs.filter((m) => /Content Security Policy|TrustedScript/.test(m)), [], 'violation de CSP');
    await b.api('PATCH', '/api/admin/settings', { json: { autosave_seconds: 30 } });
  } finally { await b.close(); }
});

test('format non pris en charge : message clair, application jamais chargée', { skip: missing('wordcraft'), timeout: 60_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = b.page;
  try {
    await loginE2e0(b);
    const pdf = await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Refus.pdf' });
    await p.goto(`${base}/host.html?app=wordcraft&file=${pdf.id}`);
    await p.waitForSelector('.blocked');
    assert.match(await p.textContent('.blocked h2'), /WordCraft n'ouvre pas les fichiers \.pdf/);
    assert.equal(await p.getAttribute('.blocked a.btn.primary', 'href'), `/host.html?app=pdfcraft&file=${pdf.id}`);
    assert.equal(await p.locator('#app').getAttribute('src'), null, 'iframe jamais chargée');
    assert.ok(!b.requests.some((u) => u.includes('/apps/wordcraft/')), 'aucun fichier de WordCraft demandé');
    // L'explorateur ne propose pas WordCraft pour un PDF.
    await p.goto(`${base}/`);
    await p.click(`.item[data-key="f:${pdf.id}"]`, { button: 'right' });
    await p.hover('.menu [role=menuitem]:has-text("Ouvrir avec")');
    await p.waitForTimeout(300);
    const labels = await p.locator('.menu').last().locator('[role=menuitem]').allTextContents();
    // PdfCraft (et d'autres qui importent le PDF : VectorCraft, Craft Anything), jamais WordCraft.
    assert.ok(labels.some((l) => l.endsWith('PdfCraft')), labels.join(' | '));
    assert.ok(!labels.some((l) => /WordCraft/.test(l)), labels.join(' | '));
  } finally { await b.close(); }
});

test('wordcraft : « Ouvrir » de l\'application → sélecteur Crafty (choisir, importer, annuler)', { skip: missing('wordcraft'), timeout: 180_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = b.page;
  const openDialog = async () => {
    await b.inApp('wordcraft', (a) => a.execute('file.open'));
    await p.waitForSelector('dialog[open].picker-dlg');
  };
  try {
    await loginE2e0(b);
    const first = await b.upload(join(SAMPLES, 'test.docx'), { name: 'Premier.docx' });
    const second = await b.upload(join(SAMPLES, 'test.docx'), { name: 'Second.docx' });
    await b.host({ app: 'wordcraft', file: first.id });
    await b.waitFor(() => window.hostState.file && window.hostState.control === true, 60_000);
    await p.waitForTimeout(1200);

    // Annuler puis rouvrir : l'application n'est pas bloquée par la boîte annulée.
    await openDialog();
    const rows = await p.locator('dialog[open] .pk-row:not(.folder) .pk-name').allTextContents();
    assert.ok(rows.includes('Second.docx') && !rows.some((r) => r.endsWith('.pdf')), `liste filtrée : ${rows}`);
    await p.click('dialog[open] button[value=cancel]');
    await openDialog();

    // Choisir un fichier Crafty : WordCraft l'ouvre, et Ctrl+S l'enregistre dans CE fichier.
    await p.click(`dialog[open] .pk-row:has-text("Second.docx")`);
    await p.click('dialog[open] button[value=ok]');
    await b.waitFor(() => window.hostState.file?.name === 'Second.docx', 15_000);
    await p.waitForTimeout(1500);
    await b.inApp('wordcraft', (a) => a.execute('text.insert', { text: 'Choisi ' }));
    await b.waitFor(() => window.hostState.dirty === true);
    await b.clickApp(600, 500);
    await p.keyboard.press('Control+s');
    await b.waitFor((n) => window.hostState.saves.length === n && window.hostState.saves.at(-1).status === 'ok', 15_000, 1);
    assert.equal((await b.state()).saves[0].fileId, second.id);
    assert.equal((await b.api('GET', `/api/files/${second.id}/versions`)).body.length, 2);
    assert.equal((await b.api('GET', `/api/files/${first.id}/versions`)).body.length, 1, 'le premier document est intact');

    // Importer depuis l'ordinateur : le fichier est rangé dans Crafty puis remis à l'application.
    await openDialog();
    await p.setInputFiles('dialog[open] input[type=file]', { name: 'Importé.docx', mimeType: 'application/octet-stream', buffer: readFileSync(join(SAMPLES, 'test.docx')) });
    await b.waitFor(() => window.hostState.file?.name === 'Importé.docx', 15_000);
    const fs = (await b.api('GET', '/api/fs')).body.files.map((f) => f.name);
    assert.ok(fs.includes('Importé.docx'));
    assert.deepEqual(b.consoleMsgs.filter((m) => /Content Security Policy|TrustedScript/.test(m)), [], 'violation de CSP');
  } finally { await b.close(); }
});

test('réglages des applications par compte : isolés sur un navigateur partagé, retrouvés ailleurs', { skip: missing('pdfcraft'), timeout: 180_000 }, async () => {
  const shared = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = shared.page;
  const lsPdf = () => p.evaluate(() => localStorage.getItem('pdfcraft'));
  try {
    // A (e2e0) change un réglage de PdfCraft.
    await loginE2e0(shared);
    await shared.host({ app: 'pdfcraft' });
    await shared.waitFor(() => window.hostState.control === true, 60_000);
    await shared.inApp('pdfcraft', (a) => a.request('ui.set', { key: 'show_page_edge_shadows', value: 'false' }));
    // eframe écrit ses réglages périodiquement (pas tout de suite) : on attend l'écriture.
    await shared.waitFor(() => /"show_page_edge_shadows":false/.test(localStorage.getItem('pdfcraft') || ''), 60_000);
    await p.evaluate(() => window.craftPrefsFlush());
    const stored = (await shared.api('GET', '/api/prefs?keys=pdfcraft')).body.values.pdfcraft;
    assert.match(stored, /"show_page_edge_shadows":false/);
    assert.match(stored, /"author":"e2e0"/);

    // B se connecte sur le même navigateur (sans déconnexion propre de A) : il ne voit pas les réglages de A.
    await shared.api('POST', '/api/auth/logout');
    const admin = await pw.browserFor(base);
    await admin.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
    await admin.api('POST', '/api/admin/users', { json: { username: 'prefsb', password: 'provisoire1' } });
    await admin.close();
    await shared.api('POST', '/api/auth/login', { json: { username: 'prefsb', password: 'provisoire1' } });
    await shared.api('POST', '/api/auth/password', { json: { current: 'provisoire1', password: 'motdepasse2' } });
    await shared.host({ app: 'pdfcraft' });
    await shared.waitFor(() => window.hostState.control === true, 60_000);
    const bLocal = await lsPdf();
    assert.ok(!bLocal || (!/"show_page_edge_shadows":false/.test(bLocal) && !/"author":"e2e0"/.test(bLocal)), 'réglages de A visibles pour B');

    // A sur un autre navigateur : ses réglages reviennent.
    const other = await pw.browserFor(base, { headless: !process.env.HEADED });
    try {
      await other.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
      await other.host({ app: 'pdfcraft' });
      await other.waitFor(() => window.hostState.control === true, 60_000);
      assert.match(await other.page.evaluate(() => localStorage.getItem('pdfcraft')), /"show_page_edge_shadows":false/);
      const shadows = await other.inApp('pdfcraft', (a) => a.docInspect().then((d) => d.show_page_edge_shadows));
      assert.equal(shadows, false, 'l\'application applique le réglage restauré');
    } finally { await other.close(); }
  } finally { await shared.close(); }
});

// Données gardées par l'application dans le navigateur (ici la session EffectCraft, dans l'OPFS) : elles suivent le compte.
test('données des applications par compte (session EffectCraft) : effacées à la déconnexion, invisibles pour B, retrouvées ailleurs', { skip: missing('effectcraft'), timeout: 420_000 }, async () => {
  const opfsSession = (p) => p.evaluate(async () => {
    try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('effectcraft'); const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort(); }
    catch { return []; }
  });
  const comps = (b) => b.inApp('effectcraft', async (a) => (await a.execute('project.summary', {})).items.map((i) => i.name));
  const openEc = async (b) => { await b.host({ app: 'effectcraft' }, 150_000); await b.page.waitForTimeout(15_000); };
  const shared = await pw.browserFor(base, { headless: !process.env.HEADED });
  try {
    // A : renomme une composition ; EffectCraft écrit sa session (OPFS) ; envoi au serveur.
    await loginE2e0(shared);
    await shared.api('DELETE', '/api/appdata/effectcraft');
    await openEc(shared);
    await shared.inApp('effectcraft', (a) => a.execute('project.rename', { item: 'Lower Third', name: 'Session de A' }));
    await shared.page.waitForTimeout(12_000); // la session est écrite ~10 s après une modification (vérifié)
    await shared.page.evaluate(() => window.craftDataFlush());
    const stored = await shared.api('GET', '/api/appdata/effectcraft');
    assert.equal(stored.status, 200, 'instantané envoyé');
    assert.ok((await opfsSession(shared.page)).includes('config%2Fsession.ecproj'));

    // Déconnexion par le menu : la session de A quitte ce navigateur.
    await shared.page.click('.avatar');
    await shared.page.click('.menu [role=menuitem]:has-text("Se déconnecter")');
    await shared.page.waitForURL(/login\.html/);
    assert.deepEqual((await opfsSession(shared.page)).filter((n) => n.startsWith('config%2Fsession.')), [], 'session de A restée dans le navigateur');

    // B sur le même navigateur : pas la session de A.
    const admin = await pw.browserFor(base);
    await loginE2e0(admin);
    await admin.api('POST', '/api/admin/users', { json: { username: 'datab', password: 'provisoire1' } });
    await admin.close();
    await shared.api('POST', '/api/auth/login', { json: { username: 'datab', password: 'provisoire1' } });
    await shared.api('POST', '/api/auth/password', { json: { current: 'provisoire1', password: 'motdepasse2' } });
    await openEc(shared);
    assert.ok(!(await comps(shared)).includes('Session de A'), 'B voit la session de A');

    // A sur un autre navigateur : sa session revient.
    const other = await pw.browserFor(base, { headless: !process.env.HEADED });
    try {
      await loginE2e0(other);
      await openEc(other);
      assert.ok((await comps(other)).includes('Session de A'), 'session de A non retrouvée');
    } finally { await other.close(); }
  } finally { await shared.close(); }
});

// Applications ajoutées le 14/11/2026 : nouveau document → modification → Ctrl+S (nom demandé) → Ctrl+S (nouvelle
// version) → réouverture depuis Crafty (le contenu est là) → modification → sauvegarde automatique (version « auto »).
const NEW_APPS = {
  gridcraft: { modify: (a, n) => a.execute('cell.set', { cell: `A${n}`, input: String(40 + n) }),
    check: async (a) => (await a.docInspect()).sheets[0].cells, expect: 2, name: 'Book1.xlsx' },
  deckcraft: { modify: (a, n) => a.execute('shape.insert', { preset: 'rect', rect: [50 + n * 30, 50, 200, 100], text: `Essai ${n}` }),
    // docInspect ne donne que le nombre de formes : 2 espaces réservés de la diapositive titre + 2 insertions.
    check: async (a) => (await a.docInspect()).slides[0].shapes, expect: 4, name: 'Presentation1.deckcraft' },
  cadcraft: { setup: (a) => a.execute('new', {}), modify: (a, n) => a.execute('line', { points: [[0, 0], [100 + n, 100]] }),
    check: async (a) => (await a.docInspect()).entityCount, expect: 2, name: 'Drawing1.dxf' },
  figcraft: { setup: (a) => a.execute('file.new', { name: 'Essai' }), modify: (a, n) => a.execute('node.create', { type: 'rectangle', x: 20 * n, y: 20, width: 100, height: 80 }),
    check: async (a) => (await a.docInspect()).pages[0].children.length, expect: 2, name: 'Essai.figcraft' },
};
for (const [slug, c] of Object.entries(NEW_APPS)) {
  test(`${slug} : nouveau document, enregistrer sous, version, réouverture, sauvegarde automatique, thème`, { skip: missing(slug), timeout: 180_000 }, async () => {
    const b = await pw.browserFor(base, { headless: !process.env.HEADED, colorScheme: 'dark' });
    const p = b.page;
    const ctrlS = async () => { await b.clickApp(620, 420); await p.keyboard.press('Control+s'); };
    try {
      await loginE2e0(b);
      await b.api('PATCH', '/api/admin/settings', { json: { autosave_seconds: 3 } });
      await b.api('PATCH', '/api/me', { json: { theme: 'light' } });
      const folder = (await b.api('POST', '/api/folders', { json: { name: `Essais ${slug}` } })).body;
      let st = await b.host({ app: slug, folder: folder.id });
      assert.equal(st.ready.version, '1');
      assert.equal(st.ready.appVersion, apps[slug].version);
      await b.waitFor(() => window.hostState.control === true, 60_000);
      await p.waitForTimeout(1500);
      if (c.setup) await b.inApp(slug, c.setup);
      await b.inApp(slug, c.modify, 1);
      await p.waitForTimeout(500);
      await ctrlS();
      await p.waitForSelector('dialog[open] input');
      assert.equal(await p.inputValue('dialog[open] input'), c.name);
      await p.click('dialog[open] button[value=ok]');
      await b.waitFor(() => window.hostState.saves[0]?.status === 'ok', 15_000);
      await b.inApp(slug, c.modify, 2);
      await p.waitForTimeout(500);
      await ctrlS();
      await b.waitFor(() => window.hostState.saves[1]?.status === 'ok', 15_000);
      st = await b.state();
      assert.deepEqual(st.saves.map((s) => s.target), ['post', 'put']);
      const file = (await b.api('GET', `/api/fs?folder=${folder.id}`)).body.files.find((f) => f.name === c.name);
      assert.equal(file.versions, 2);
      assert.ok((await b.log()).some((l) => l.includes("thème de l'application : light")), 'thème du compte appliqué');

      // Réouverture depuis Crafty : le contenu enregistré est là.
      await b.host({ app: slug, file: file.id });
      await b.waitFor(() => window.hostState.file && window.hostState.control === true, 60_000);
      await p.waitForTimeout(2500);
      assert.equal(await b.inApp(slug, c.check), c.expect);
      await b.inApp(slug, c.modify, 3);
      await b.waitFor(() => window.hostState.autosaves === 1, 30_000);
      const vs = (await b.api('GET', `/api/files/${file.id}/versions`)).body;
      assert.deepEqual(vs.map((v) => [v.n, v.auto]), [[3, true], [2, false], [1, false]]);
      assert.deepEqual(b.consoleMsgs.filter((m) => /Content Security Policy|TrustedScript/.test(m)), [], 'violation de CSP');
    } finally {
      await b.api('PATCH', '/api/admin/settings', { json: { autosave_seconds: 30 } }).catch(() => {});
      await b.close();
    }
  });
}

// Sélecteur Crafty dans les applications ajoutées : leur propre bouton « Ouvrir » → choisir le fichier enregistré au test
// précédent → l'application l'ouvre (contenu vérifié) → Ctrl+S l'enregistre dans ce fichier.
const OPEN_DIALOG = {
  gridcraft: (b) => b.inApp('gridcraft', (a) => a.execute('file.open')),
  deckcraft: (b) => b.inApp('deckcraft', (a) => a.execute('app.openDialog')),
  cadcraft: (b) => b.inApp('cadcraft', (a) => a.execute('ui.open')),
  figcraft: (b) => b.clickApp(410, 218), // bouton « Ouvrir un fichier » de l'accueil de FigCraft
};
for (const [slug, c] of Object.entries(NEW_APPS)) {
  test(`${slug} : « Ouvrir » de l'application → sélecteur Crafty → enregistrement dans ce fichier`, { skip: missing(slug), timeout: 120_000 }, async () => {
    const b = await pw.browserFor(base, { headless: !process.env.HEADED });
    const p = b.page;
    try {
      await loginE2e0(b);
      const folder = (await b.api('GET', '/api/fs')).body.folders.find((f) => f.name === `Essais ${slug}`);
      const file = (await b.api('GET', `/api/fs?folder=${folder.id}`)).body.files.find((f) => f.name === c.name);
      const before = file.versions;
      // debug : mise en page avec le journal, celle où le bouton d'accueil de FigCraft a été repéré (410, 218).
      await b.host({ app: slug, folder: folder.id, debug: '' });
      await b.waitFor(() => window.hostState.control === true, 60_000);
      await p.waitForTimeout(2000);
      await OPEN_DIALOG[slug](b);
      await p.waitForSelector('dialog[open].picker-dlg');
      await p.click(`dialog[open] .pk-row:has-text("${c.name}")`);
      await p.click('dialog[open] button[value=ok]');
      await b.waitFor((n) => window.hostState.file?.name === n, 15_000, c.name);
      await p.waitForTimeout(2500);
      assert.equal(await b.inApp(slug, c.check), c.expect + 1, 'contenu du fichier choisi (3 modifications enregistrées)');
      await b.inApp(slug, c.modify, 4);
      await b.waitFor(() => window.hostState.dirty === true, 10_000);
      await b.clickApp(620, 420);
      await p.keyboard.press('Control+s');
      await b.waitFor(() => window.hostState.saves.at(-1)?.status === 'ok', 15_000);
      const st = await b.state();
      assert.equal(st.saves.at(-1).fileId, file.id, 'enregistré dans le fichier choisi');
      assert.equal(st.saves.at(-1).target, 'put');
      assert.equal((await b.api('GET', `/api/files/${file.id}`)).body.versions, before + 1);
      assert.deepEqual(b.consoleMsgs.filter((m) => /Content Security Policy|TrustedScript/.test(m)), [], 'violation de CSP');
    } finally { await b.close(); }
  });
}

// Réglages des applications qui en écrivent (GridCraft, CadCraft) : envoyés au serveur, retrouvés sur un autre navigateur.
for (const slug of ['gridcraft', 'cadcraft']) {
  test(`${slug} : réglages enregistrés dans le compte et retrouvés ailleurs`, { skip: missing(slug), timeout: 150_000 }, async () => {
    const keys = apps[slug].prefKeys;
    const one = await pw.browserFor(base, { headless: !process.env.HEADED });
    try {
      await one.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
      await one.host({ app: slug });
      await one.waitFor(() => window.hostState.control === true, 60_000);
      // Les applications écrivent leurs réglages périodiquement (environ 30 s).
      await one.waitFor((k) => k.every((x) => localStorage.getItem(x) !== null), 60_000, keys);
      await one.page.evaluate(() => window.craftPrefsFlush());
      const local = await one.page.evaluate((k) => Object.fromEntries(k.map((x) => [x, localStorage.getItem(x)])), keys);
      const server = (await one.api('GET', `/api/prefs?keys=${keys.join(',')}`)).body.values;
      assert.deepEqual(server, local);
    } finally { await one.close(); }
    const two = await pw.browserFor(base, { headless: !process.env.HEADED });
    try {
      await two.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
      await two.page.goto(`${base}/`);
      assert.equal(await two.page.evaluate((k) => k.filter((x) => localStorage.getItem(x) !== null).length, keys), 0, 'navigateur neuf');
      await two.host({ app: slug });
      const restored = await two.page.evaluate((k) => k.filter((x) => localStorage.getItem(x) !== null), keys);
      assert.deepEqual(restored, keys, 'réglages remis avant le chargement');
    } finally { await two.close(); }
  });
}

// Mode interception (applications sans pont) : Enregistrer = téléchargement ou showSaveFilePicker capté, ou Ctrl+S tenu par
// Crafty par l'API de l'application ; Ouvrir = sélecteur Crafty ; réouverture = dépôt, Ctrl+O simulé ou commande de l'API.
// prepare : crée le document de départ ; confirm(first) : la boîte propre de l'application ; keepName : l'application nomme
// ses enregistrements d'après son projet (TextureCraft), le fichier garde donc ce nom ; ctrlO : vrai Ctrl+O testé.
const api = (slug, fn, arg) => async (p) => p.frame({ url: /\/apps\// }).evaluate(fn, arg);
const INTERCEPT_APPS = {
  designcraft: { name: 'Untitled-1.designcraft' },
  soundcraft: { name: 'Midnight Groove.scraftz', confirm: async (p) => { await p.waitForTimeout(1500); await p.keyboard.press('Enter'); } },
  solidcraft: { name: 'Cube.sc', focus: 'canvas', // un clic sur son écran d'accueil ouvrirait un exemple
    prepare: api('solidcraft', async () => { await window.solidcraft.execute('file.new', { name: 'Cube' }); await window.solidcraft.execute('solid.box', { length: 20, width: 30, height: 40 }); }) },
  vectorcraft: { name: 'Untitled-1.vectorcraft', focus: [300, 600],
    prepare: api('vectorcraft', async () => { await window.vectorcraft.execute('file.newWithoutDialog', {}); await window.vectorcraft.execute('shape.rectangle', { x: 50, y: 50, width: 200, height: 120 }); }) },
  texturecraft: { name: 'Material_Ball.tcraft', keepName: true, focus: [330, 750],
    prepare: async (p) => { await p.mouse.click(581, 516); await p.waitForTimeout(1500); } }, // « Continuer avec le projet d'exemple »
  materialcraft: { name: 'Untitled package.mcraft', focus: [500, 500],
    prepare: async (p) => { await p.mouse.click(872, 255); await p.waitForTimeout(800); }, // ferme « Home »
    // Sa boîte « Save package » au premier enregistrement : format .mcraft, puis Download.
    confirm: async (p, first) => { if (!first) return; await p.waitForTimeout(1500); await p.mouse.click(32, 193); await p.waitForTimeout(500); await p.mouse.click(58, 222); } },
  effectcraft: { name: 'document.ecproj', settle: 15_000, focus: [500, 700], ctrlO: false },
};
for (const [slug, c] of Object.entries(INTERCEPT_APPS)) {
  test(`${slug} (interception) : enregistrer, réouverture, Ouvrir de l'application, état « peut-être modifié »`, { skip: missing(slug), timeout: 420_000 }, async () => {
    const b = await pw.browserFor(base, { headless: !process.env.HEADED });
    const p = b.page;
    // Premier chargement : le serveur compresse le wasm à la volée (plusieurs secondes de CPU) ; DesignCraft démarre en 12 à 14 s.
    const ready = async () => { await b.waitFor(() => window.hostState?.ready, 150_000); await p.waitForTimeout(c.settle ?? 8000); };
    const [fx, fy] = Array.isArray(c.focus) ? c.focus : [500, 400];
    const focus = async () => (c.focus === 'canvas'
      ? p.frame({ url: /\/apps\// }).evaluate(() => { const cv = document.querySelector('canvas'); cv.tabIndex = 0; cv.focus(); })
      : b.clickApp(fx, fy));
    const save = async (first = false) => {
      const n = (await b.state()).saves.length;
      await focus();
      await p.keyboard.press('Control+s');
      await c.confirm?.(p, first);
      return n;
    };
    try {
      await loginE2e0(b);
      await p.goto(`${base}/host.html?app=${slug}`);
      await ready();
      assert.doesNotMatch(await p.locator('#app').getAttribute('src'), /host=parent/);
      assert.equal((await b.state()).ready.mode, 'intercept');
      await c.prepare?.(p);
      await save(true);
      await p.waitForSelector('dialog[open] input', { timeout: 30_000 });
      assert.equal(await p.inputValue('dialog[open] input'), c.name);
      const ext = c.name.split('.').pop();
      const fname = c.keepName ? c.name : `Interception ${slug}.${ext}`;
      await p.fill('dialog[open] input', fname);
      await p.keyboard.press('Enter'); // Entrée valide (elle annulait : premier bouton du formulaire)
      await b.waitFor(() => window.hostState.saves[0]?.status === 'ok', 30_000);
      const file = (await b.api('GET', '/api/fs')).body.files.find((f) => f.name === fname);
      assert.ok(file && file.size > 0);
      assert.match(await p.textContent('#statusText'), /^Enregistré/);
      await b.clickApp(fx, fy); // un vrai clic (le document est ouvert : plus d'écran d'accueil)
      await b.waitFor(() => window.hostState.maybeDirty === true, 5_000);
      assert.equal(await p.textContent('#statusText'), 'Pensez à enregistrer (Ctrl+S)');

      // Réouverture depuis Crafty : l'enregistrement suivant porte le nom du fichier, donc va dans ce fichier.
      await p.goto(`${base}/host.html?app=${slug}&file=${file.id}`);
      await ready();
      await b.waitFor(() => window.hostState.reopened, 150_000); // réouverture terminée (Ctrl+O simulé : l'application doit être disponible)
      await p.waitForTimeout(3000);
      let n = await save();
      await b.waitFor((k) => window.hostState.saves.length > k && window.hostState.saves.at(-1).status, 30_000, n);
      let last = (await b.state()).saves.at(-1);
      assert.equal(last.target, 'put');
      assert.equal(last.fileId, file.id);

      // Ouvrir de l'application (vrai Ctrl+O) → sélecteur Crafty → fichier remis → Ctrl+S dans ce fichier.
      if (c.ctrlO === false) return;
      await p.goto(`${base}/host.html?app=${slug}`);
      await ready();
      await focus();
      await p.keyboard.press('Control+o');
      await p.waitForSelector('dialog[open].picker-dlg', { timeout: 15_000 });
      await p.click(`dialog[open] .pk-row:has-text("${fname.replace(/\.[^.]+$/, '')}")`);
      await p.click('dialog[open] button[value=ok]');
      await b.waitFor((nm) => window.hostState.file?.name === nm, 15_000, file.name);
      await p.waitForTimeout(3000);
      n = await save();
      await b.waitFor((k) => window.hostState.saves.length > k && window.hostState.saves.at(-1).status, 30_000, n);
      last = (await b.state()).saves.at(-1);
      assert.equal(last.fileId, file.id, 'enregistré dans le fichier choisi');
      assert.deepEqual(b.consoleMsgs.filter((m) => /Content Security Policy|TrustedScript/.test(m)), [], 'violation de CSP');
    } catch (err) {
      // Diagnostic en cas d'échec : capture et état de la page hôte dans le dossier temporaire.
      const out = join(tmpdir(), `e2e-${slug}-echec`);
      await p.screenshot({ path: `${out}.png` }).catch(() => {});
      const info = await p.evaluate(() => ({ state: window.hostState, frame: (() => { const w = document.getElementById('app')?.contentWindow; return { wasm: !!w?.wasmBindings, url: w?.location?.href, title: w?.document?.title, canvas: !!w?.document?.querySelector('canvas') }; })() })).catch((x) => String(x));
      console.log(`diagnostic ${slug} : ${out}.png`, JSON.stringify(info).slice(0, 1500), b.consoleMsgs.slice(-10).join(' || ').slice(0, 2000));
      throw err;
    } finally { await b.close(); }
  });
}

test('accueil : Entrée crée le dossier ; sélection multiple (case, Ctrl, Maj, lasso) ; déplacer et supprimer en groupe', { skip: !browserOk && 'navigateur introuvable', timeout: 90_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = b.page;
  const fs = async (folder = 'root') => (await b.api('GET', `/api/fs?folder=${folder}`)).body;
  try {
    await loginE2e0(b);
    // Repartir d'un dossier racine vide (les autres tests y laissent des fichiers).
    const old = await fs();
    for (const f of old.files) await b.api('DELETE', `/api/files/${f.id}`);
    for (const d of old.folders) await b.api('DELETE', `/api/folders/${d.id}`);
    for (const n of ['Un.pdf', 'Deux.pdf', 'Trois.pdf']) await b.upload(join(SAMPLES, 'test.pdf'), { name: n });
    await p.goto(`${base}/`);
    await p.waitForSelector('.item');

    // « Nouveau dossier » + Entrée : créé (avant : Entrée prenait « Annuler »).
    await p.click('#newFolder');
    await p.fill('dialog[open] input', 'Rangement');
    await p.keyboard.press('Enter');
    await p.waitForSelector('.item:has-text("Rangement")');
    assert.deepEqual((await fs()).folders.map((d) => d.name), ['Rangement']);

    const item = (n) => p.locator(`.item:has-text("${n}")`);
    const selected = () => p.locator('.item[aria-selected=true]').count();
    // Case à cocher : barre d'actions dès un élément (le dossier créé est sélectionné : Échap d'abord).
    await p.keyboard.press('Escape');
    assert.equal(await selected(), 0);
    await item('Un.pdf').hover();
    await item('Un.pdf').locator('.check').click();
    assert.equal(await selected(), 1);
    assert.equal(await p.isVisible('#selBar'), true);
    // Ctrl+clic ajoute, Maj+clic prend la plage, Échap vide.
    await item('Trois.pdf').click({ modifiers: ['Control'] });
    assert.equal(await selected(), 2);
    await item('Deux.pdf').click();
    await item('Un.pdf').click({ modifiers: ['Shift'] });
    assert.equal(await p.textContent('#selCount'), '3 éléments sélectionnés'); // ordre affiché : Deux, Trois, Un
    await p.keyboard.press('Escape');
    assert.equal(await selected(), 0);
    assert.equal(await p.isVisible('#selBar'), false);

    // Lasso depuis un endroit vide de la zone jusqu'au premier élément : tout est pris.
    const area = await p.locator('#area').boundingBox(), first = await p.locator('.item').first().boundingBox();
    await p.mouse.move(area.x + area.width - 8, area.y + area.height - 8);
    await p.mouse.down();
    await p.mouse.move(area.x + area.width / 2, area.y + area.height / 2, { steps: 5 });
    await p.mouse.move(first.x + 6, first.y + 6, { steps: 5 });
    assert.equal(await p.locator('.lasso').count(), 1);
    await p.mouse.up();
    assert.equal(await selected(), 4);
    assert.equal(await p.textContent('#selCount'), '4 éléments sélectionnés');
    await p.screenshot({ path: join(tmpdir(), 'e2e-selection.png') });

    // Déplacer les trois fichiers dans « Rangement » (le dossier lui-même est grisé dans la liste).
    await item('Rangement').click({ modifiers: ['Control'] });
    assert.equal(await selected(), 3);
    await p.click('#selMove');
    await p.click('dialog[open] .picker-list button:has-text("Rangement")');
    await p.click('dialog[open] button[value=ok]');
    await p.waitForFunction(() => document.querySelectorAll('.item').length === 1);
    const folderId = (await fs()).folders[0].id;
    assert.deepEqual((await fs(folderId)).files.map((f) => f.name).sort(), ['Deux.pdf', 'Trois.pdf', 'Un.pdf']);

    // Dans le dossier : Ctrl+A puis Supprimer (confirmation).
    await item('Rangement').dblclick();
    await p.waitForSelector('.item:has-text("Un.pdf")');
    await p.locator('#items').click({ position: { x: 2, y: 2 } }).catch(() => {});
    await p.keyboard.press('Control+a');
    assert.equal(await selected(), 3);
    await p.click('#selDelete'); // corbeille : sans confirmation, avec « Annuler »
    await p.waitForSelector('.toast:has-text("3 éléments placés dans la corbeille")');
    await p.waitForSelector('#empty:not([hidden])');
    assert.equal((await fs(folderId)).files.length, 0);
    assert.equal((await b.api('GET', '/api/trash')).body.items.length >= 3, true);
  } finally { await b.close(); }
});

// Assistant IA avec un faux fournisseur local (dialecte OpenAI) qui joue un scénario d'appels d'outils : la boucle, les
// outils de l'accueil et d'une application, la confirmation des suppressions. Aucun vrai modèle n'est appelé.
async function fakeModel(script) {
  const { createServer } = await import('node:http');
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body);
      seen.push(b);
      const tools = b.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
      const out = script(b.messages, tools, b);
      const message = out.tool ? { role: 'assistant', content: out.say ?? null, tool_calls: [{ id: `c${seen.length}`, type: 'function', function: { name: out.tool, arguments: JSON.stringify(out.args || {}) } }] }
        : { role: 'assistant', content: out.say };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message, finish_reason: out.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  srv.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, seen, close: () => srv.close() };
}

test('assistant IA : ranger des fichiers sur l\'accueil (suppression confirmée), piloter PdfCraft', { skip: missing('pdfcraft'), timeout: 240_000 }, async () => {
  const model = await fakeModel((messages, tools) => {
    const user = messages.filter((m) => m.role === 'user').at(-1).content;
    const n = tools.length - messages.slice(0, messages.lastIndexOf(messages.filter((m) => m.role === 'user').at(-1))).filter((m) => m.role === 'tool').length;
    const last = tools.at(-1);
    if (/range/i.test(user)) {
      if (n === 0) return { tool: 'search_files', args: { extension: 'pdf' } };
      if (n === 1) return { tool: 'create_folder', args: { name: 'Factures' } };
      const pdfs = tools.find((t) => t.results)?.results || [], folder = tools.find((t) => t.type === 'folder' && t.name === 'Factures');
      if (n === 2) return { tool: 'move_items', args: { items: pdfs.map((p) => ({ type: 'file', id: p.id })), target_folder_id: folder.id } };
      if (n === 3) return { tool: 'search_files', args: { query: 'Brouillon' } };
      if (n === 4) return { tool: 'delete_items', args: { items: last.results.map((p) => ({ type: 'file', id: p.id })) } };
      return { say: `C'est rangé : **${pdfs.length} PDF** dans Factures.` };
    }
    if (/page/i.test(user)) {
      if (n === 0) return { tool: 'list_commands', args: { query: 'insert blank' } };
      if (n === 1) return { tool: 'run_command', args: { id: last.commands[0].id } };
      if (n === 2) return { tool: 'save_document' };
      return { say: 'Page ajoutée et document enregistré.' };
    }
    return { say: 'Bonjour.' };
  });
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = b.page;
  try {
    await loginE2e0(b);
    const r = await b.api('PUT', '/api/admin/ai', { json: { enabled: true, everyone: true, defaultProvider: 'custom', providers: { custom: { enabled: true, baseUrl: model.url, model: 'faux-modele' } } } });
    assert.equal(r.status, 200);
    const old = (await b.api('GET', '/api/fs')).body;
    for (const f of old.files) await b.api('DELETE', `/api/files/${f.id}`);
    for (const d of old.folders) await b.api('DELETE', `/api/folders/${d.id}`);
    await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Facture-1.pdf' });
    await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Facture-2.pdf' });
    await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Brouillon.pdf' });

    // Accueil : le bouton apparaît ; le scénario range, puis la suppression attend la confirmation.
    await p.goto(`${base}/`);
    await p.waitForSelector('#agentBtn:not([hidden])');
    await p.click('#agentBtn');
    await p.fill('.agent-input', 'Range mes PDF dans un dossier Factures et supprime le brouillon');
    await p.keyboard.press('Enter');
    await p.waitForSelector('.agent-confirm button:has-text("Confirmer")', { timeout: 30_000 });
    assert.match(await p.textContent('.agent-confirm'), /Brouillon\.pdf/);
    await p.click('.agent-confirm button:has-text("Confirmer")');
    await p.waitForSelector('.agent-msg.assistant:has-text("C\'est rangé")', { timeout: 30_000 });
    const root = (await b.api('GET', '/api/fs')).body;
    assert.deepEqual(root.folders.map((d) => d.name), ['Factures']);
    assert.deepEqual(root.files.map((f) => f.name), [], 'PDF rangés, brouillon supprimé');
    const inside = (await b.api('GET', `/api/fs?folder=${root.folders[0].id}`)).body.files.map((f) => f.name).sort();
    assert.deepEqual(inside, ['Facture-1.pdf', 'Facture-2.pdf'], 'PDF rangés dans Factures, brouillon supprimé');
    // Le message système vient du serveur ; les outils de l'accueil ont été proposés.
    assert.match(model.seen[0].messages[0].content, /accueil/);
    assert.ok(model.seen[0].tools.some((t) => t.function.name === 'delete_items'));

    // PdfCraft : la commande trouvée est exécutée, puis le document enregistré (nouvelle version).
    const pdf = (await b.api('GET', `/api/fs?folder=${root.folders[0].id}`)).body.files.find((f) => f.name === 'Facture-1.pdf');
    await b.host({ app: 'pdfcraft', file: pdf.id });
    await b.waitFor(() => window.hostState.file && window.hostState.control === true, 60_000);
    await p.waitForSelector('#agentBtn:not([hidden])');
    await p.click('#agentBtn');
    await p.fill('.agent-input', 'Ajoute une page blanche et enregistre');
    await p.keyboard.press('Enter');
    await p.waitForSelector('.agent-msg.assistant:has-text("Page ajoutée")', { timeout: 60_000 });
    assert.equal(await b.inApp('pdfcraft', async (a) => (await a.docInspect()).documents[0].pages), 4);
    const meta = (await b.api('GET', `/api/files/${pdf.id}`)).body;
    assert.equal(meta.versions, 2, 'enregistré par l\'assistant');
    assert.match(model.seen.at(-1).messages[0].content, /PdfCraft/);
  } finally {
    await b.api('PUT', '/api/admin/ai', { json: { enabled: false } }).catch(() => {});
    await b.close(); model.close();
  }
});

test('accueil : corbeille (annuler, restaurer), favoris, récents, partage sans compte, miniature d\'image', { skip: missing('pdfcraft'), timeout: 180_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = b.page;
  const item = (n) => p.locator(`#items .item:has-text("${n}")`);
  try {
    await loginE2e0(b);
    const old = (await b.api('GET', '/api/fs')).body;
    for (const f of old.files) await b.api('DELETE', `/api/files/${f.id}?permanent=1`);
    for (const d of old.folders) await b.api('DELETE', `/api/folders/${d.id}?permanent=1`);
    await b.api('POST', '/api/trash/delete', { json: { all: true } });
    await b.upload(join(ROOT, 'public', 'brand', 'crafty-192.png'), { name: 'Logo.png' });
    const doc = await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Doc.pdf' });
    await p.goto(`${base}/`);

    // Miniature de l'image, faite par le navigateur.
    await p.waitForSelector('#items .item:has-text("Logo.png") .thumb img', { timeout: 20_000 });
    // L'élément peut être inséré avant la fin du chargement de l'image : attendre son « load ».
    assert.ok(await item('Logo.png').locator('.thumb img').evaluate((i) => new Promise((r) => (i.complete ? r(i.naturalWidth > 0)
      : (i.addEventListener('load', () => r(i.naturalWidth > 0)), i.addEventListener('error', () => r(false)))))));

    // Favori : étoile et accès rapide.
    await item('Doc.pdf').click({ button: 'right' });
    await p.click('.menu [role=menuitem]:has-text("Ajouter aux favoris")');
    await p.waitForSelector('#items .item:has-text("Doc.pdf") .fav');
    await p.waitForSelector('#quick:not([hidden])');
    await p.click('#quick [role=tab]:has-text("Favoris")');
    await p.waitForSelector('#quick .q-card:has-text("Doc.pdf")');

    // Supprimer → corbeille, « Annuler » ; puis vue Corbeille et « Restaurer ».
    await item('Doc.pdf').click();
    await p.keyboard.press('Delete');
    await p.waitForSelector('.toast:has-text("placé dans la corbeille")');
    assert.equal(await item('Doc.pdf').count(), 0);
    await p.click('.toast button:has-text("Annuler")');
    await p.waitForSelector('#items .item:has-text("Doc.pdf")');
    await item('Doc.pdf').click();
    await p.keyboard.press('Delete');
    await p.waitForSelector('#trashBtn .count');
    await p.click('#trashBtn');
    await p.waitForSelector('.trash-row:has-text("Doc.pdf")');
    assert.match(p.url(), /trash=1/);
    await p.click('.trash-row:has-text("Doc.pdf") button:has-text("Restaurer")');
    await p.waitForSelector('#empty:not([hidden])');
    await p.click('#crumbs button:has-text("Mes fichiers")');
    await p.waitForSelector('#items .item:has-text("Doc.pdf")');

    // Récents : ouvert dans PdfCraft, puis retour à l'accueil.
    await b.host({ app: 'pdfcraft', file: doc.id });
    await b.waitFor(() => window.hostState.file, 60_000);
    await p.goto(`${base}/`);
    await p.click('#quick [role=tab]:has-text("Récents")');
    await p.waitForSelector('#quick .q-card:has-text("Doc.pdf")');

    // Partage : lien créé, ouvert sans compte dans un autre navigateur.
    await item('Logo.png').click({ button: 'right' });
    await p.click('.menu [role=menuitem]:has-text("Partager")');
    await p.click('dialog[open] button:has-text("Créer un lien")');
    const url = await p.inputValue('dialog[open] .share-fresh input');
    assert.match(url, /\/s\/[A-Za-z0-9_-]{43}$/);
    const anon = await pw.browserFor(base, { headless: !process.env.HEADED });
    try {
      await anon.page.goto(url);
      await anon.page.waitForSelector('.share-card h1:has-text("Logo.png")');
      assert.ok(await anon.page.locator('.share-preview img').evaluate((i) => new Promise((r) => (i.complete ? r(i.naturalWidth > 0) : i.addEventListener('load', () => r(i.naturalWidth > 0))))));
      assert.match(await anon.page.getAttribute('a:has-text("Télécharger")', 'href'), /content\?dl=1$/);
      assert.match(await anon.page.textContent('.share-head'), /partagé par e2e0/);
    } finally { await anon.close(); }
    await p.click('dialog[open] .share-list button:has-text("Révoquer")');
    await p.waitForSelector('dialog[open] .share-list li.mut');
    const gone = await pw.browserFor(base, { headless: true });
    try { await gone.page.goto(url); await gone.page.waitForSelector('.share-card h1:has-text("Lien indisponible")'); } finally { await gone.close(); }
  } finally { await b.close(); }
});

test("miniature d'un document rendue par l'application (DeckCraft), sans toucher au document", { skip: missing('deckcraft'), timeout: 180_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = b.page;
  try {
    await loginE2e0(b);
    await b.host({ app: 'deckcraft' });
    await b.waitFor(() => window.hostState.control === true, 60_000);
    await b.inApp('deckcraft', (a) => a.execute('shape.insert', { preset: 'rect', rect: [50, 50, 300, 150], text: 'Miniature' }));
    await b.clickApp(500, 400);
    await p.keyboard.press('Control+s');
    await p.waitForSelector('dialog[open] input');
    await p.fill('dialog[open] input', 'Miniature.deckcraft');
    await p.keyboard.press('Enter');
    await b.waitFor(() => window.hostState.saves.at(-1)?.status === 'ok', 30_000);
    const id = (await b.state()).file.id;
    // Inactivité de 3 s puis rendu : la miniature suit la version courante.
    let f;
    for (let i = 0; i < 60 && !(f = (await b.api('GET', `/api/files/${id}`)).body).thumb; i++) await p.waitForTimeout(500);
    assert.equal(f.thumb, f.versionId);
    assert.equal((await b.api('GET', `/api/files/${id}/thumb`)).status, 200);
    assert.equal(await b.inApp('deckcraft', async (a) => (await a.docInspect()).slides[0].shapes), 3, 'document intact');
  } finally { await b.close(); }
});

test('outils de barre : unités (CadCraft), couleurs (FigCraft), un seul panneau ouvert', { skip: missing('figcraft') || missing('cadcraft'), timeout: 180_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = b.page;
  try {
    await loginE2e0(b);
    await b.host({ app: 'cadcraft' });
    await p.waitForSelector('#barTools [data-tool=calculator]');
    await p.click('#barTools [data-tool=converter]');
    await p.fill('.tool-panel:not([hidden]) .calc-input', '2');
    assert.equal(await p.textContent('.tool-panel:not([hidden]) .conv-res .calc-out'), '50,8 mm');
    await p.fill('.tool-panel:not([hidden]) .calc-input', '1 + 1');
    assert.equal(await p.textContent('.tool-panel:not([hidden]) .conv-res .calc-out'), '50,8 mm', 'calcul accepté');
    await p.click('#barTools [data-tool=calculator]');
    assert.equal(await p.locator('.tool-panel:not([hidden])').count(), 1, 'un seul panneau');
    await b.host({ app: 'figcraft' });
    await p.click('#barTools [data-tool=colors]');
    await p.fill('.tool-panel:not([hidden]) .calc-input', '#ff0000');
    await p.waitForSelector('.tool-panel:not([hidden]) .col-row code:has-text("rgb(255, 0, 0)")');
    assert.ok(await p.locator('.tool-panel:not([hidden]) .col-row code:has-text("hsl(0, 100%, 50%)")').count());
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('.tool-panel:not([hidden])').count(), 0);
  } finally { await b.close(); }
});

// Interface anglaise (navigateur en-US) : aucun texte français visible dans Crafty (hors applications et noms de fichiers).
test('interface en anglais selon la langue du navigateur', { skip: missing('cadcraft'), timeout: 240_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED, locale: 'en-US' });
  const p = b.page;
  const FRENCH = /[éèêëàâçùûôîï«»]|\b(Mes fichiers|Enregistr\w*|Supprimer|Annuler|Corbeille|Dossier|Fichier|Nouveau|Partager|Applications? \w+ \w+ de)\b/;
  // Texte visible de Crafty, hors iframe de l'application et hors noms de fichiers de l'utilisateur.
  const leftovers = () => p.evaluate((src) => {
    const re = new RegExp(src);
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { const s = n.textContent.trim(); if (s && re.test(s)) out.push(s.slice(0, 80)); return; }
      if (n.nodeType !== 1 || n.matches('iframe, script, style, .name, .q-name, .doc-name, .t-main, [hidden]') || getComputedStyle(n).display === 'none') return;
      for (const a of ['title', 'aria-label', 'placeholder']) { const v = n.getAttribute(a); if (v && re.test(v)) out.push(`[${a}] ${v.slice(0, 80)}`); }
      for (const c of n.childNodes) walk(c);
    };
    walk(document.body);
    return [...new Set(out)];
  }, FRENCH.source);
  try {
    await p.goto(`${base}/login.html`);
    assert.equal(await p.evaluate(() => document.documentElement.lang), 'en');
    assert.deepEqual(await leftovers(), [], 'connexion');
    const bad = await b.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'mauvais-mdp' }, headers: { 'accept-language': 'en-US' } });
    assert.doesNotMatch(bad.body.error, /[éèàç]|mot de passe/i, 'message du serveur en anglais');
    await loginE2e0(b);
    await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Report.pdf' });
    await p.goto(`${base}/`);
    await p.waitForSelector('#items .item');
    assert.deepEqual(await leftovers(), [], 'accueil');
    await p.locator('#items .item:has-text("Report.pdf")').click({ button: 'right' });
    assert.deepEqual(await leftovers(), [], 'menu d\'un fichier');
    await p.keyboard.press('Escape');
    await p.click('#trashBtn');
    await p.waitForSelector('#items.trash', { state: 'attached' }); // masquée si la corbeille est vide
    assert.deepEqual(await leftovers(), [], 'corbeille');
    await b.host({ app: 'cadcraft' });
    for (const tool of ['calculator', 'converter', 'colors']) {
      await p.click(`#barTools [data-tool=${tool}]`);
      await p.keyboard.press('Escape'); // pipette du navigateur, si elle s'est ouverte
      assert.deepEqual(await leftovers(), [], `page d'application, outil ${tool}`);
    }
    await p.goto(`${base}/admin.html#settings`);
    await p.waitForSelector('#settings .card');
    assert.deepEqual(await leftovers(), [], 'administration');
  } finally { await b.close(); }
});

test('craft-anything : n\'importe quel fichier de Crafty est analysé (lecture seule)', { skip: missing('craft-anything'), timeout: 150_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  try {
    await loginE2e0(b);
    const file = await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Analyse.pdf' });
    await b.host({ app: 'craft-anything', file: file.id });
    await b.waitFor(() => window.hostState.reopened, 120_000);
    // Interface dessinée dans un canvas : l'analyse affichée (type, taille, SHA-256) a été vérifiée à l'œil, pas ici.
    assert.equal((await b.state()).reopened, file.id);
    assert.equal(await b.page.locator('.toast').count(), 0, 'aucune erreur');
    await b.clickApp(400, 300);
    assert.equal((await b.state()).maybeDirty, false, 'rien à enregistrer');
  } finally { await b.close(); }
});

test('pdfcraft : un export (Word) est capté et rangé à côté du document', { skip: missing('pdfcraft'), timeout: 120_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  try {
    await loginE2e0(b);
    const file = await b.upload(join(SAMPLES, 'test.pdf'), { name: 'Export.pdf' });
    await b.host({ app: 'pdfcraft', file: file.id });
    await b.waitFor(() => window.hostState.file && window.hostState.control === true, 60_000);
    await b.page.waitForTimeout(1500);
    await b.inApp('pdfcraft', (a) => a.execute('export.docx'));
    await b.waitFor(() => window.hostState.saves.some((s) => s.name === 'Export.docx' && s.status === 'ok'), 30_000);
    const names = (await b.api('GET', '/api/fs')).body.files.map((f) => f.name);
    assert.ok(names.includes('Export.docx'), names.join(', '));
    assert.ok(!b.consoleMsgs.some((m) => m.startsWith('[download]')), 'aucun téléchargement du navigateur');
  } finally { await b.close(); }
});

test('invité : application sans stockage, « Enregistrer » télécharge le fichier', { skip: missing('pdfcraft'), timeout: 120_000 }, async () => {
  const b = await pw.browserFor(base, { headless: !process.env.HEADED });
  const p = b.page;
  try {
    await p.goto(`${base}/login.html`);
    await p.click('text=Continuer en invité');
    await p.waitForURL(`${base}/`);
    assert.equal(await p.isVisible('#guestSection'), true);
    assert.equal(await p.isVisible('#filesSection'), false);
    await p.click('.app-card >> text=PdfCraft');
    await b.waitFor(() => window.hostState?.ready, 90_000);
    await p.setInputFiles('#localFile', join(SAMPLES, 'test.pdf'));
    await p.waitForTimeout(1500);
    const download = p.waitForEvent('download');
    await b.clickApp(600, 500);
    await p.keyboard.press('Control+s');
    const d = await download;
    assert.equal(d.suggestedFilename(), 'test.pdf');
    assert.equal((await b.api('GET', '/api/fs')).status, 401);
  } finally { await b.close(); }
});
