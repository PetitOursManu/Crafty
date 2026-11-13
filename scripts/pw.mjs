// Outils Playwright pour les essais de la phase 0 (exploration et test e2e).
// Utilise le Chromium déjà installé par Playwright (%LOCALAPPDATA%/ms-playwright) via playwright-core.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Navigateur : PW_CHROMIUM, sinon Chrome installé, sinon le Chromium le plus récent de ms-playwright.
export function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'])
    if (existsSync(p)) return p;
  const dir = join(process.env.LOCALAPPDATA || join(process.env.HOME || '', '.cache'), 'ms-playwright');
  if (!existsSync(dir)) return undefined;
  const revs = readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]);
  for (const r of revs) {
    for (const p of [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe'], ['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']]) {
      const exe = join(dir, r, ...p);
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

export async function launch({ base = 'http://localhost:8787', app = 'pdfcraft', flags = '', headless = true, args = [] } = {}) {
  const browser = await chromium.launch({ headless, args, executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) consoleMsgs.push(`[http ${r.status()}] ${r.url()}`); });
  page.on('requestfailed', (r) => consoleMsgs.push(`[failed] ${r.url()} ${r.failure()?.errorText}`));
  const requests = [];
  context.on('request', (r) => requests.push(r.url()));
  context.on('serviceworker', () => {});
  context.on('page', (p) => consoleMsgs.push(`[popup] ${p.url()}`));
  page.on('download', (d) => consoleMsgs.push(`[download] ${d.suggestedFilename()}`));
  const t0 = Date.now();
  await page.goto(`${base}/host.html?app=${app}${flags ? `&${flags}` : ''}`);
  const h = {
    browser, context, page, consoleMsgs, requests, t0,
    frame: () => page.frame({ url: /\/apps\// }),
    state: () => page.evaluate(() => JSON.parse(JSON.stringify(window.hostState))),
    log: () => page.evaluate(() => window.hostLog.map((l) => `${l.t.toFixed(2)} ${l.dir} ${l.text}`)),
    async waitReady(timeout = 120_000) {
      await page.waitForFunction(() => window.hostState.ready || window.hostState.failed.length, null, { timeout, polling: 100 });
      return h.state();
    },
    async open(path, name = path.split(/[\\/]/).pop(), { asBlob = false } = {}) {
      const bytes = await readFile(path);
      // Le fichier passe par le serveur pour éviter de sérialiser 100 Mo dans evaluate().
      const r = await page.request.post(`${base}/api/echo`, { data: bytes, headers: { 'x-file-name': encodeURIComponent(name), 'sec-fetch-site': 'same-origin' } });
      const { id } = await r.json();
      await page.evaluate(async ([id, asBlob]) => {
        document.getElementById('asBlob').checked = asBlob;
        await window.hostApi.openFromServer(id);
      }, [id, asBlob]);
    },
    async waitFor(pred, timeout = 30_000) {
      await page.waitForFunction(pred, null, { timeout, polling: 100 });
    },
    async clickApp(x, y) { // coordonnées relatives à l'iframe
      const box = await page.locator('#app').boundingBox();
      await page.mouse.click(box.x + x, box.y + y);
    },
    shot: (path) => page.screenshot({ path }),
    close: () => browser.close(),
  };
  return h;
}
