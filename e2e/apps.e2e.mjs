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
import { createApp } from '../src/app.js';

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
  srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://localhost:${srv.address().port}`;
});
after(() => { srv?.close(); db?.close(); rmSync(dataDir, { recursive: true, force: true }); });

let user = 0;
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
        await b.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
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
    await b.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
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
    await b.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
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
    assert.equal(labels.length, 1);
    assert.ok(labels[0].endsWith('PdfCraft'), labels[0]);
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
    await b.api('POST', '/api/auth/login', { json: { username: 'e2e0', password: 'motdepasse1' } });
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
