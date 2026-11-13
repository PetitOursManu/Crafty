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
