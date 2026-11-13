// Test de bout en bout (npm run test:e2e) : pour chaque application de apps.json, dans Chrome sans écran
// (HEADED=1 pour voir la fenêtre), avec la CSP stricte du serveur :
// ready → open → modification → Ctrl+S au clavier → save stocké → rechargement de la page hôte →
// réouverture de la sauvegarde depuis GET /api/echo/:id → la modification est toujours là.
// Ignoré si vendor/ ou le navigateur manquent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const apps = JSON.parse(readFileSync(ROOT + 'apps.json', 'utf8'));
let pw;
try { pw = await import('../scripts/pw.mjs'); } catch { /* playwright-core absent */ }
const browserOk = pw && existsSync(pw.chromiumPath() || '');
if (!existsSync(ROOT + 'public/samples/test.docx')) execFileSync(process.execPath, [ROOT + 'scripts/make-samples.mjs']);

// Ce que chaque application sait faire, d'après la phase 0.
const CASES = {
  pdfcraft: {
    sample: 'test.pdf',
    modify: (a) => a.execute('page.insert_blank'),
    check: async (a) => (await a.docInspect()).documents[0].pages, expect: 4,
  },
  wordcraft: {
    sample: 'test.docx',
    modify: (a) => a.execute('text.insert', { text: 'E2E ' }),
    check: async (a) => (await a.docInspect()).blocks[0].text.startsWith('E2E '), expect: true,
  },
};

for (const [slug, c] of Object.entries(CASES)) {
  const skip = !apps[slug] ? `${slug} absent de apps.json`
    : !existsSync(`${ROOT}vendor/${slug}/${apps[slug].version}/index.html`) ? `vendor/${slug} absent (npm run fetch ${slug})`
    : !browserOk ? 'navigateur introuvable (PW_CHROMIUM)' : false;

  test(`${slug} : ouvrir, modifier, Ctrl+S, recharger, retrouver`, { skip, timeout: 180_000 }, async () => {
    const srv = createApp({ csp: 'auto' }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const h = await pw.launch({ base: `http://localhost:${srv.address().port}`, app: slug, flags: 'control', headless: !process.env.HEADED });
    const inApp = (fn, arg) => h.page.evaluate(([slug, src, arg]) => {
      const a = document.getElementById('app').contentWindow[slug];
      return (0, eval)(src)(a, arg);
    }, [slug, fn.toString(), arg]);
    try {
      let st = await h.waitReady(60_000);
      assert.deepEqual(st.failed, []);
      assert.equal(st.ready.version, '1');
      assert.equal(st.ready.appVersion, apps[slug].version);
      await h.waitFor(() => window.hostState.control === true);

      await h.open(`${ROOT}public/samples/${c.sample}`);
      await h.page.waitForTimeout(1500);
      await inApp(c.modify);
      await h.waitFor(() => window.hostState.dirty === true, 10_000);

      // Ctrl+S réel, focus dans l'iframe (clic dans la zone du document).
      await h.clickApp(600, 500);
      await h.page.keyboard.press('Control+s');
      await h.waitFor(() => window.hostState.saves.length > 0 && window.hostState.saves[0].status, 15_000);
      await h.waitFor(() => window.hostState.dirty === false, 10_000);
      st = await h.state();
      const save = st.saves[0];
      assert.equal(save.name, c.sample);
      assert.equal(save.saveAs, false);
      assert.equal(save.status, 201);
      assert.ok(save.size > 0);
      // Constat phase 0 : les deux applications n'envoient pas d'id, donc l'hôte ne répond jamais `saved`.
      // Si ce test casse ici, le comportement a changé : relire FINDINGS.md (questions 3 et 4).
      assert.equal(save.id, undefined, 'le save porte maintenant un id');
      assert.ok(!(await h.log()).some((l) => l.includes(`${slug}:saved`)));

      // Rechargement de la page hôte, puis réouverture de la dernière sauvegarde (id gardé en localStorage).
      await h.page.reload();
      await h.waitReady(60_000);
      await h.waitFor(() => window.hostState.control === true);
      st = await h.state();
      assert.equal(st.lastId, save.echoId);
      await h.page.click('#reopen');
      await h.page.waitForTimeout(2000);
      assert.equal(await inApp(c.check), c.expect);

      // Les octets rendus par GET /api/echo/:id sont ceux reçus dans le save.
      const r = await h.page.request.get(`http://localhost:${srv.address().port}/api/echo/${save.echoId}`);
      assert.equal(r.status(), 200);
      const body = await r.body();
      assert.equal(body.length, save.size);
      assert.equal(createHash('sha256').update(body).digest('hex'), save.sha256);

      // Échec du stockage : l'application se croit enregistrée, l'hôte affiche l'alerte rouge ;
      // « Réessayer » renvoie les mêmes octets et fait disparaître l'alerte.
      await h.page.check('#fail');
      await inApp(c.modify);
      await h.waitFor(() => window.hostState.dirty === true, 10_000);
      await inApp((a) => a.execute('file.save'));
      await h.waitFor(() => window.hostState.unsaved, 10_000);
      assert.equal((await h.state()).dirty, false, "l'application se croit enregistrée");
      assert.equal(await h.page.isVisible('#toast'), true);
      assert.match(await h.page.textContent('#toast'), /Attention : fichier non sauvegardé/);
      assert.match(await h.page.textContent('#dirty'), /non sauvegardé/);
      await h.page.uncheck('#fail');
      await h.page.click('#toastRetry');
      await h.waitFor(() => window.hostState.unsaved === null, 10_000);
      assert.equal(await h.page.isVisible('#toast'), false);

      const csp = h.consoleMsgs.filter((m) => /Content Security Policy|TrustedScript/.test(m));
      assert.deepEqual(csp, [], 'violation de CSP');
    } finally {
      await h.close();
      srv.close();
    }
  });
}
