const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';
process.env.CORS_ORIGIN = 'http://localhost:3000';

const { isLocalOrigin } = require('../src/config/cors');

/**
 * Regressao de um "Failed to fetch" que nao dizia nada:
 * o painel aberto por 127.0.0.1 ou pelo IP da maquina tinha o preflight
 * respondido com 204, mas SEM access-control-allow-origin - e o navegador
 * bloqueava sem mensagem util.
 */

test('reconhece as formas de acessar a propria maquina', () => {
  const locais = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'https://localhost:3000',
  ];
  for (const origin of locais) {
    assert.equal(isLocalOrigin(origin), true, `${origin} deveria contar como local`);
  }
});

test('reconhece as faixas de rede privada (RFC 1918)', () => {
  const privadas = [
    'http://192.168.208.1:3000', // rede do escritorio
    'http://192.168.0.15:3000',
    'http://10.0.0.5:3000',
    'http://172.16.4.2:3000',
    'http://172.31.255.254:3000',
  ];
  for (const origin of privadas) {
    assert.equal(isLocalOrigin(origin), true, `${origin} deveria contar como rede local`);
  }
});

test('nao confunde endereco publico com rede local', () => {
  const externos = [
    'http://172.15.0.1:3000', // logo abaixo da faixa privada
    'http://172.32.0.1:3000', // logo acima
    'http://11.0.0.1:3000',
    'https://site-qualquer.com',
    'https://localhost.evil.com', // sufixo enganoso
    'http://192.168.0.1.evil.com',
  ];
  for (const origin of externos) {
    assert.equal(isLocalOrigin(origin), false, `${origin} NAO pode ser tratado como local`);
  }
});

test('origin malformada nao derruba a checagem', () => {
  for (const origin of ['', 'nao-e-url', 'null', undefined]) {
    assert.equal(isLocalOrigin(origin), false);
  }
});

/**
 * Regressao do "erro ao gerar o QR": o backend escutava so em 0.0.0.0 (IPv4).
 * Clientes que resolvem localhost para ::1 levavam ECONNREFUSED - o login
 * passava porque o navegador tenta os dois, mas o Socket.IO nao conectava,
 * e o QR (que so chega por socket) nunca aparecia na tela.
 */
test('escuta em dual-stack por padrao, nao so IPv4', () => {
  delete require.cache[require.resolve('../src/config/env')];
  const previous = process.env.HOST;
  delete process.env.HOST;

  const { env } = require('../src/config/env');
  assert.equal(env.host, '::', 'o padrao precisa abrir IPv4 e IPv6');
  assert.notEqual(env.host, '0.0.0.0', 'so IPv4 quebra clientes que preferem ::1');

  if (previous !== undefined) process.env.HOST = previous;
});

test('HOST do ambiente tem prioridade sobre o padrao', () => {
  delete require.cache[require.resolve('../src/config/env')];
  const previous = process.env.HOST;
  process.env.HOST = '127.0.0.1';

  const { env } = require('../src/config/env');
  assert.equal(env.host, '127.0.0.1');

  if (previous === undefined) delete process.env.HOST;
  else process.env.HOST = previous;
  delete require.cache[require.resolve('../src/config/env')];
});
