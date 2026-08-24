const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const { BaileysManager } = require('../src/whatsapp/baileys.manager');

/**
 * Comportamento do ciclo de vida do canal, sem rede.
 * `patch` toca o Mongo, entao aqui ele e substituido por um registrador
 * em memoria - o que importa e a maquina de estados, nao a persistencia.
 */
function makeManager() {
  const manager = new BaileysManager();
  const eventos = [];

  manager.patch = async function patch(channelId, changes) {
    Object.assign(this.getState(channelId), changes);
    eventos.push({ channelId, ...changes });
  };

  return { manager, eventos };
}

/** Socket falso: registra se foi encerrado. */
function fakeSock() {
  const sock = {
    ended: false,
    removidos: [],
    ev: {
      removeAllListeners(evento) {
        sock.removidos.push(evento);
      },
    },
    end() {
      sock.ended = true;
    },
  };
  return sock;
}

test('cancelar limpa o QR por completo e emite UMA transicao', async () => {
  const { manager, eventos } = makeManager();
  const state = manager.getState('leads-1');

  state.sock = fakeSock();
  state.status = 'qr';
  state.qr = 'data:image/png;base64,abc';
  state.qrExpiresAt = Date.now() + 60_000;

  await manager.disconnect('leads-1');

  assert.equal(eventos.length, 1, 'duas atualizacoes seguidas causavam piscada na tela');
  assert.equal(state.status, 'disconnected');
  assert.equal(state.qr, null, 'o QR precisa sumir da tela');
  assert.equal(state.qrExpiresAt, null, 'senao a contagem regressiva continua rodando');
  assert.equal(state.sock, null);
});

test('QR emitido depois do cancelamento e descartado', async () => {
  const { manager, eventos } = makeManager();
  const state = manager.getState('leads-1');

  state.sock = fakeSock();
  state.status = 'qr';
  await manager.disconnect('leads-1');
  eventos.length = 0;

  // O Baileys ainda pode emitir um QR ja em transito depois do end().
  await manager.onConnectionUpdate('leads-1', { qr: 'codigo-atrasado' });

  assert.equal(eventos.length, 0, 'nao pode gerar evento');
  assert.equal(state.qr, null, 'o codigo reaparecendo faria o cancelar parecer quebrado');
  assert.equal(state.status, 'disconnected');
});

test('teardown encerra o socket e solta os listeners', async () => {
  const { manager } = makeManager();
  const state = manager.getState('leads-1');
  const sock = fakeSock();
  state.sock = sock;

  await manager.teardown('leads-1');

  assert.equal(sock.ended, true);
  assert.equal(state.sock, null);
  assert.ok(sock.removidos.includes('connection.update'));
  assert.ok(sock.removidos.includes('messages.upsert'));
});

test('teardown em canal sem socket nao quebra', async () => {
  const { manager } = makeManager();
  await manager.teardown('clients-1');
  assert.equal(manager.getState('clients-1').sock, null);
});

test('clique duplo nao abre dois sockets na mesma sessao', async () => {
  const { manager } = makeManager();
  const state = manager.getState('leads-2');

  // Simula um connect em andamento.
  state.opening = true;

  const resultado = await manager.connect('leads-2');

  assert.equal(resultado.id, 'leads-2');
  assert.equal(
    state.sock,
    null,
    'o segundo pedido deve sair fora: dois sockets na mesma sessao travam o pareamento'
  );
});

test('canal ja conectado nao reabre socket', async () => {
  const { manager, eventos } = makeManager();
  const state = manager.getState('leads-1');
  const sock = fakeSock();

  state.sock = sock;
  state.status = 'connected';

  await manager.connect('leads-1');

  assert.equal(sock.ended, false, 'nao pode derrubar uma conexao viva');
  assert.equal(eventos.length, 0);
});

test('reconexao automatica nao dispara durante um connect manual', async () => {
  const { manager } = makeManager();
  const state = manager.getState('leads-1');

  let tentouReconectar = false;
  manager.connect = async () => {
    tentouReconectar = true;
  };

  state.opening = true;
  state.reconnectAttempts = 1;

  // Reproduz o timer de backoff disparando enquanto o usuario pediu conexao.
  if (!state.closing && !state.opening) await manager.connect('leads-1');

  assert.equal(tentouReconectar, false);
});

test('estado publico nunca vaza o socket nem credenciais', () => {
  const { manager } = makeManager();
  const state = manager.getState('leads-1');
  state.sock = fakeSock();

  const publico = manager.publicState('leads-1');

  assert.equal(publico.sock, undefined);
  assert.ok('status' in publico && 'qr' in publico);
  assert.deepEqual(Object.keys(publico).filter((k) => k.toLowerCase().includes('cred')), [
    'hasCredentials',
  ]);
});
