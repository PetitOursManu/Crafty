// Outils Playwright pour les essais (exploration et test e2e) avec playwright-core et un Chrome déjà installé.
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

// Navigateur + contexte ; `base` = URL du serveur. Les requêtes d'API de page.request portent l'en-tête Origin.
export async function browserFor(base, { headless = true, args = [], colorScheme = 'light', locale = 'fr-FR' } = {}) {
  const browser = await chromium.launch({ headless, args, executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme, locale, acceptDownloads: true }); // locale : langue du navigateur (fr-FR par défaut, en-US pour l'interface anglaise)
  const page = await context.newPage();
  const consoleMsgs = [], requests = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) consoleMsgs.push(`[http ${r.status()}] ${r.url()}`); });
  page.on('download', (d) => consoleMsgs.push(`[download] ${d.suggestedFilename()}`));
  context.on('request', (r) => requests.push(r.url()));
  const apiCall = async (method, path, { json, data, headers = {} } = {}) => {
    const r = await page.request.fetch(`${base}${path}`, { method, headers: { origin: base, ...headers }, data: json !== undefined ? json : data });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status(), body };
  };
  const b = {
    browser, context, page, consoleMsgs, requests, base, api: apiCall,
    async register(username, password) { return apiCall('POST', '/api/auth/register', { json: { username, password } }); },
    async login(username, password) { return apiCall('POST', '/api/auth/login', { json: { username, password } }); },
    async upload(path, { folder = 'root', name = path.split(/[\\/]/).pop() } = {}) {
      const r = await apiCall('POST', `/api/files?folder=${folder}`, { data: await readFile(path), headers: { 'x-file-name': encodeURIComponent(name) } });
      if (r.status >= 300) throw new Error(`upload ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
    // Ouvre la page hôte et attend `ready`.
    async host(params, timeout = 120_000) {
      await page.goto(`${base}/host.html?${new URLSearchParams(params).toString().replace(/=(&|$)/g, '$1')}`);
      await page.waitForFunction(() => window.hostState?.ready || window.hostState?.failed.length, null, { timeout, polling: 100 });
      return b.state();
    },
    state: () => page.evaluate(() => JSON.parse(JSON.stringify(window.hostState, (k, v) => (typeof v === 'function' ? undefined : v)))),
    log: () => page.evaluate(() => window.hostLog.map((l) => `${l.t.toFixed(2)} ${l.dir} ${l.text}`)),
    waitFor: (pred, timeout = 30_000, arg) => page.waitForFunction(pred, arg, { timeout, polling: 100 }),
    // Exécute fn(window.<app>, arg) dans la page (l'application doit être chargée avec ?control).
    inApp: (slug, fn, arg) => page.evaluate(([slug, src, arg]) => (0, eval)(src)(document.getElementById('app').contentWindow[slug], arg), [slug, fn.toString(), arg]),
    async clickApp(x, y) { const box = await page.locator('#app').boundingBox(); await page.mouse.click(box.x + x, box.y + y); },
    shot: (path) => page.screenshot({ path }),
    close: () => browser.close(),
  };
  return b;
}
