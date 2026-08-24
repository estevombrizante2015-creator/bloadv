const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const resolver = require('../src/config/agent.resolver');
const agents = require('../src/config/agents.config');

const URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
const NUMERO_NOVO = '5519936196755'; // numero pareado que nao esta na config

let connected = false;

test.before(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const { NumberAssignment } = require('../src/models');
    await NumberAssignment.deleteMany({ number: NUMERO_NOVO });
    await resolver.load();
  } catch {
    connected = false;
  }
});

test.after(async () => {
  if (connected) {
    const { NumberAssignment } = require('../src/models');
    await NumberAssignment.deleteMany({ number: NUMERO_NOVO }).catch(() => {});
    await mongoose.connection.close();
  }
});

test('numero da config continua resolvendo pela config', () => {
  const { agent, matched, source } = resolver.resolve('5519996383884');
  assert.equal(agent.id, 'lead_capture');
  assert.equal(matched, true);
  assert.equal(source, 'config');
});

test('numero desconhecido nao responde, e isso fica explicito', () => {
  const { agent, matched, source } = resolver.resolve(NUMERO_NOVO);

  assert.equal(matched, false);
  assert.equal(source, 'fallback');
  assert.equal(agent.id, 'unassigned');
  assert.equal(
    agents.isAgentActive(agent),
    false,
    'era isto que fazia o canal conectar e o agente nunca responder'
  );
});

test('atribuir pelo painel passa a valer na hora, sem editar codigo', async (t) => {
  if (!connected) return t.skip('MongoDB indisponivel');

  const antes = resolver.resolve(NUMERO_NOVO);
  assert.equal(antes.agent.id, 'unassigned');

  await resolver.assign({
    number: NUMERO_NOVO,
    agentId: 'lead_capture',
    assignedBy: 'teste@escritorio.com',
  });

  const depois = resolver.resolve(NUMERO_NOVO);
  assert.equal(depois.agent.id, 'lead_capture');
  assert.equal(depois.matched, true);
  assert.equal(depois.source, 'painel');
  assert.equal(agents.isAgentActive(depois.agent), true, 'agora o agente responde');
});

test('atribuicao casa com as variantes do numero (com e sem nono digito)', async (t) => {
  if (!connected) return t.skip('MongoDB indisponivel');

  await resolver.assign({ number: NUMERO_NOVO, agentId: 'customer_agent' });

  for (const variante of [NUMERO_NOVO, '551936196755', `${NUMERO_NOVO}@s.whatsapp.net`]) {
    const numero = variante.includes('@') ? agents.jidToNumber(variante) : variante;
    assert.equal(
      resolver.resolve(numero).agent.id,
      'customer_agent',
      `variante ${variante} deveria resolver`
    );
  }
});

test('a atribuicao do painel tem precedencia sobre a config', async (t) => {
  if (!connected) return t.skip('MongoDB indisponivel');

  const daConfig = '5519996383884'; // pertence ao lead_capture na config
  const { NumberAssignment } = require('../src/models');

  await resolver.assign({ number: daConfig, agentId: 'customer_agent' });
  assert.equal(resolver.resolve(daConfig).source, 'painel');
  assert.equal(resolver.resolve(daConfig).agent.id, 'customer_agent');

  // desfeita a atribuicao, volta a valer a configuracao
  await resolver.unassign(daConfig);
  assert.equal(resolver.resolve(daConfig).source, 'config');
  assert.equal(resolver.resolve(daConfig).agent.id, 'lead_capture');

  await NumberAssignment.deleteMany({ number: daConfig }).catch(() => {});
});

test('nao e possivel atribuir um numero ao agente inerte', async (t) => {
  if (!connected) return t.skip('MongoDB indisponivel');

  await assert.rejects(
    () => resolver.assign({ number: NUMERO_NOVO, agentId: 'unassigned' }),
    /agente inerte/
  );
});

test('agente inexistente e recusado', async (t) => {
  if (!connected) return t.skip('MongoDB indisponivel');

  await assert.rejects(
    () => resolver.assign({ number: NUMERO_NOVO, agentId: 'nao_existe' }),
    /Agente desconhecido/
  );
});

test('list mostra config e painel juntos, sem duplicar numero', async (t) => {
  if (!connected) return t.skip('MongoDB indisponivel');

  await resolver.assign({ number: NUMERO_NOVO, agentId: 'lead_capture' });
  const lista = await resolver.list();

  const numeros = lista.map((l) => l.number);
  assert.equal(new Set(numeros).size, numeros.length, 'nao pode haver numero repetido');
  assert.ok(lista.some((l) => l.number === NUMERO_NOVO && l.source === 'painel'));
  assert.ok(lista.some((l) => l.number === '5519987587782' && l.source === 'config'));
});
