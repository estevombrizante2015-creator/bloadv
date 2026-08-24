const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';

const Fastify = require('fastify');
const channelsRoutes = require('../src/routes/channels.routes');

/** Rotas que nao tocam o banco: valida registro e contrato com o front. */
async function buildApp() {
  const app = Fastify();
  await app.register(channelsRoutes);
  return app;
}

test('GET /api/config expoe os 3 canais com papel e tier', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.channels.length, 3);

  const leads = body.channels.filter((c) => c.role === 'leads');
  const clients = body.channels.filter((c) => c.role === 'clients');
  assert.equal(leads.length, 2, 'dois numeros para leads');
  assert.equal(clients.length, 1, 'um numero para clientes');
  assert.ok(leads.every((c) => c.agentTier === 'sol'));
  assert.equal(clients[0].agentTier, 'luna');
});

test('GET /api/agent/tiers lista mini, sol, luna e terra', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/agent/tiers' });
  assert.equal(res.statusCode, 200);

  const keys = res.json().tiers.map((tier) => tier.key).sort();
  assert.deepEqual(keys, ['luna', 'mini', 'sol', 'terra']);

  const mini = res.json().tiers.find((tier) => tier.key === 'mini');
  assert.equal(mini.userFacing, false, 'mini e utilitario, nao conversa com o contato');
  assert.ok(mini.model.length > 0, 'todo tier aponta para um modelo real');
});

test('canal inexistente responde 404', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'POST', url: '/api/channels/nao-existe/connect' });
  assert.equal(res.statusCode, 404);
});

test('GET /api/channels/:id devolve o estado publico sem credenciais', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/channels/leads-1' });
  assert.equal(res.statusCode, 200);

  const state = res.json();
  assert.equal(state.id, 'leads-1');
  assert.equal(state.role, 'leads');
  assert.equal(state.sock, undefined, 'o socket nunca pode vazar para o front');
  assert.ok('status' in state && 'qr' in state);
});

test('GET /api/agents expoe os dois contextos e os numeros cadastrados', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/agents' });
  assert.equal(res.statusCode, 200);

  const { agents, numbers } = res.json();
  const captacao = agents.find((a) => a.id === 'lead_capture');
  const clientes = agents.find((a) => a.id === 'customer_agent');

  assert.equal(captacao.status, 'active');
  assert.equal(captacao.numbers.length, 2, 'os dois numeros de captacao');
  assert.equal(clientes.status, 'active', 'agente de clientes ativo, com numero proprio');
  assert.equal(clientes.numbers.length, 1);
  assert.equal(numbers.length, 3);
});

test('GET /api/config publica os parametros operacionais do pipeline', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const body = (await app.inject({ method: 'GET', url: '/api/config' })).json();

  // Janela curta de proposito: quem manda uma mensagem so nao pode esperar
  // o tempo de quem escreve em varias partes.
  assert.ok(body.buffer.windowMs <= 3000, 'a janela base precisa ser curta');
  assert.ok(body.buffer.maxWaitMs > body.buffer.windowMs, 'teto maior que a janela');
  assert.ok(body.antiloop.maxAutoInteractions > 0);
  assert.ok(body.media.whisperModel);
  assert.ok(body.media.visionModel);
  assert.ok(['memory', 'mongo'].includes(body.knowledgeBackend));
  assert.equal(body.agents.length, 2);
});

test('rotas de conversa validam o canal', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const lista = await app.inject({ method: 'GET', url: '/api/channels/inexistente/conversations' });
  assert.equal(lista.statusCode, 404);

  const resume = await app.inject({
    method: 'POST',
    url: '/api/conversations/inexistente/abc/resume',
  });
  assert.equal(resume.statusCode, 404);
});
