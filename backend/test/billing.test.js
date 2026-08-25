const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

/**
 * O custo e o unico numero do painel que fala de dinheiro. Duas garantias
 * importam mais que a soma em si: nunca inventar valor quando a leitura falha,
 * e explicar a falha em portugues para quem opera o painel.
 */

const recarregar = () => {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/agent/billing.service')];
  return require('../src/agent/billing.service');
};

test('sem chave configurada, o painel diz o que falta em vez de estimar', async () => {
  const anterior = process.env.BILLING_OPENAI;
  delete process.env.BILLING_OPENAI;

  const billing = recarregar();
  const r = await billing.resumo();

  assert.equal(r.ok, false);
  assert.match(r.motivo, /BILLING_OPENAI/);
  assert.equal(r.custoMes, undefined, 'nenhum valor de dinheiro pode ser inventado');

  if (anterior !== undefined) process.env.BILLING_OPENAI = anterior;
  recarregar();
});

test('a soma dos buckets respeita a janela pedida', () => {
  const billing = require('../src/agent/billing.service');

  const buckets = [
    { start_time: 100, results: [{ amount: { value: 1.5, currency: 'usd' } }] },
    { start_time: 200, results: [{ amount: { value: 2.25, currency: 'usd' } }] },
    { start_time: 300, results: [{ amount: { value: 0.1, currency: 'usd' } }] },
  ];

  assert.equal(billing.somar(buckets).total, 3.85);
  assert.equal(billing.somar(buckets, 200).total, 2.35, 'buckets anteriores ficam de fora');
  assert.equal(billing.somar(buckets).moeda, 'usd');
  assert.equal(billing.somar([]).total, 0);
  assert.equal(billing.somar(undefined).total, 0, 'resposta vazia nao pode quebrar o painel');
});

test('erro da OpenAI vira instrucao, nao codigo HTTP', () => {
  const billing = require('../src/agent/billing.service');

  const naoAutorizado = billing.explicar(Object.assign(new Error('HTTP 401'), { status: 401 }));
  assert.match(naoAutorizado, /admin/i, 'precisa dizer que a chave tem de ser de admin');

  const semPermissao = billing.explicar(Object.assign(new Error('HTTP 403'), { status: 403 }));
  assert.match(semPermissao, /permiss/i);

  const limite = billing.explicar(Object.assign(new Error('HTTP 429'), { status: 429 }));
  assert.match(limite, /minutos/i, 'rate limit precisa dizer que volta sozinho');

  const timeout = billing.explicar(Object.assign(new Error('abort'), { name: 'AbortError' }));
  assert.match(timeout, /nao respondeu a tempo/i);
});
