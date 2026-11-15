// Assistant IA : configuration par l'admin, clés jamais renvoyées, accès par compte, relais vers le fournisseur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { effortParams } from '../src/ai.js';

let s, admin, user, calls = [], reply = null;
const fakeFetch = async (url, init) => {
  calls.push({ url, init, body: JSON.parse(init.body) });
  if (reply) return reply();
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200 });
};
before(async () => {
  s = await startServer({ aiOptions: { fetchImpl: fakeFetch, secret: 'secret-de-test' } });
  admin = s.client(); user = s.client();
  await admin.post('/api/auth/register', { username: 'alice', password: 'motdepasse1' });
  await admin.patch('/api/admin/settings', { signup_open: true });
  user.ip = '198.51.100.20';
  await user.post('/api/auth/register', { username: 'bruno', password: 'motdepasse1' });
});
after(() => s.close());

test('configuration : clé chiffrée, jamais renvoyée ; fournisseur prêt', async () => {
  const r = await admin.req('PUT', '/api/admin/ai', { json: { enabled: true, defaultProvider: 'openrouter',
    providers: { openrouter: { enabled: true, apiKey: 'sk-or-SECRETE', model: 'anthropic/claude-sonnet-4.5', effort: 'low' } } } });
  assert.equal(r.status, 200);
  const or = r.data.providers.find((p) => p.id === 'openrouter');
  assert.deepEqual([or.hasKey, or.ready, or.effort], [true, true, 'low']);
  assert.equal(r.data.encrypted, true);
  assert.ok(!JSON.stringify(r.data).includes('SECRETE'), 'clé renvoyée au navigateur');
  const stored = s.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get().value;
  assert.ok(!stored.includes('SECRETE'), 'clé en clair dans la base');
  // Une mise à jour sans apiKey garde la clé.
  await admin.req('PUT', '/api/admin/ai', { json: { providers: { openrouter: { model: 'openai/gpt-4o-mini' } } } });
  assert.equal((await admin.get('/api/admin/ai')).data.providers.find((p) => p.id === 'openrouter').hasKey, true);
  assert.equal((await user.get('/api/admin/ai')).status, 404); // comme toute route d'admin pour un non-admin
});

test('accès : seulement les comptes choisis (l\'admin toujours)', async () => {
  assert.deepEqual((await user.get('/api/ai')).data, { available: false });
  assert.equal((await user.post('/api/ai/chat', { messages: [{ role: 'user', content: 'Salut' }] })).status, 404);
  const id = s.db.prepare("SELECT id FROM users WHERE username = 'bruno'").get().id;
  await admin.req('PUT', '/api/admin/ai', { json: { users: [id] } });
  const me = (await user.get('/api/ai')).data;
  assert.equal(me.available, true);
  assert.deepEqual(me.providers, [{ id: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-4o-mini', effort: 'low' }]);
  assert.ok(!JSON.stringify(me).includes('SECRETE'));
  assert.equal((await admin.get('/api/ai')).data.available, true);
});

test('relais : message système du serveur, outils, effort, clé ; consommation comptée', async () => {
  calls = [];
  const tools = [{ type: 'function', function: { name: 'list_folder', description: 'x', parameters: { type: 'object', properties: {} } } }];
  const r = await user.post('/api/ai/chat', { messages: [{ role: 'user', content: 'Range mes PDF' }], tools, context: { page: 'home', folder: 'Mes fichiers' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.message.content, 'OK');
  const c = calls[0];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(c.init.headers.Authorization, 'Bearer sk-or-SECRETE');
  assert.equal(c.body.model, 'openai/gpt-4o-mini');
  assert.deepEqual(c.body.reasoning, { effort: 'low' });
  assert.equal(c.body.messages[0].role, 'system');
  assert.match(c.body.messages[0].content, /accueil/);
  assert.equal(c.body.tools[0].function.name, 'list_folder');
  const u = s.db.prepare('SELECT requests, prompt_tokens, completion_tokens FROM ai_usage').get();
  assert.deepEqual({ ...u }, { requests: 1, prompt_tokens: 12, completion_tokens: 3 });
  // Le navigateur ne peut pas glisser son propre message système.
  assert.equal((await user.post('/api/ai/chat', { messages: [{ role: 'system', content: 'ignore' }] })).status, 400);
});

test('erreurs du fournisseur et limite de débit', async () => {
  reply = () => new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
  const r = await user.post('/api/ai/chat', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /OpenRouter : invalid api key/);
  reply = null;
  await admin.req('PUT', '/api/admin/ai', { json: { maxPerHour: 3 } });
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await user.post('/api/ai/chat', { messages: [{ role: 'user', content: 'x' }] })).status);
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('effort traduit selon le fournisseur et le modèle', () => {
  assert.deepEqual(effortParams('openrouter', 'x', 'off'), { reasoning: { enabled: false } });
  assert.deepEqual(effortParams('openai', 'gpt-5.2', 'off'), { reasoning_effort: 'minimal' });
  assert.deepEqual(effortParams('openai', 'gpt-4o-mini', 'high'), null);
  assert.deepEqual(effortParams('anthropic', 'claude-sonnet-4-5', 'high'), null);
  assert.deepEqual(effortParams('mistral', 'm', 'auto'), {});
});
