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

// ------------------------------- mensagens que chegam com a aplicacao fora

test('mensagem recuperada na reconexao e processada, nao descartada', async () => {
  // O WhatsApp entrega como `append` tudo o que chegou enquanto o socket
  // esteve fora. Isso era descartado em silencio: sem resposta, sem registro,
  // sem bolha no painel. Toda mensagem enviada durante um restart sumia.
  const manager = new BaileysManager();
  const recebidas = [];
  manager.onMessage = async (payload) => recebidas.push(payload);

  const agora = Math.floor(Date.now() / 1000);
  const mensagem = (id, segundosAtras) => ({
    key: { remoteJid: '5511999990000@s.whatsapp.net', id, fromMe: false },
    message: { conversation: 'oi' },
    messageTimestamp: agora - segundosAtras,
  });

  await manager.onMessagesUpsert('leads-1', {
    type: 'append',
    messages: [mensagem('RECENTE', 20 * 60)],
  });
  assert.equal(recebidas.length, 1, 'mensagem de 20 min atras ainda merece resposta');
  assert.equal(recebidas[0].waMessageId, 'RECENTE');

  // Depois de uma queda longa, responder do nada assusta mais do que ajuda.
  await manager.onMessagesUpsert('leads-1', {
    type: 'append',
    messages: [mensagem('ANTIGA', 30 * 60 * 60)],
  });
  assert.equal(recebidas.length, 1, 'mensagem de 30h nao deve ser respondida');
});

// ------------------------------- resposta digitada no proprio aparelho

test('resposta enviada pelo celular entra no historico, em vez de sumir', async () => {
  // Toda mensagem `fromMe` era descartada. Com o agente pausado, quem atende
  // responde pelo WhatsApp do celular — e o painel mostrava so o que o cliente
  // dizia, como se o escritorio nunca tivesse respondido.
  const manager = new BaileysManager();
  const proprias = [];
  const recebidas = [];
  manager.onOwnMessage = async (payload) => proprias.push(payload);
  manager.onMessage = async (payload) => recebidas.push(payload);

  await manager.onMessagesUpsert('leads-1', {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '5511999990000@s.whatsapp.net', id: 'DIGITADA', fromMe: true },
        message: { conversation: 'ja estou vendo isso para voce' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });

  assert.equal(proprias.length, 1, 'a resposta do atendente precisa ser registrada');
  assert.equal(proprias[0].waMessageId, 'DIGITADA');
  assert.equal(recebidas.length, 0, 'e nunca pode entrar como se o contato tivesse falado');
});

test('o eco da mensagem que o sistema enviou nao vira bolha nova', async () => {
  // O WhatsApp devolve em `messages.upsert` tudo o que sai do numero, inclusive
  // a resposta que o agente acabou de mandar. Sem distinguir, cada resposta
  // apareceria duas vezes no painel.
  const manager = new BaileysManager();
  const proprias = [];
  manager.onOwnMessage = async (payload) => proprias.push(payload);

  manager.registrarEnvioProprio('ENVIADA-PELO-AGENTE');

  await manager.onMessagesUpsert('leads-1', {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '5511999990000@s.whatsapp.net', id: 'ENVIADA-PELO-AGENTE', fromMe: true },
        message: { conversation: 'resposta do agente' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });

  assert.equal(proprias.length, 0);
});

test('resposta antiga recuperada da fila nao e reprocessada', async () => {
  const manager = new BaileysManager();
  const proprias = [];
  manager.onOwnMessage = async (payload) => proprias.push(payload);

  await manager.onMessagesUpsert('leads-1', {
    type: 'append',
    messages: [
      {
        key: { remoteJid: '5511999990000@s.whatsapp.net', id: 'VELHA', fromMe: true },
        message: { audioMessage: {} },
        messageTimestamp: Math.floor(Date.now() / 1000) - 30 * 60 * 60,
      },
    ],
  });

  assert.equal(proprias.length, 0, 'nao vale pagar transcricao por audio de 30h atras');
});

test('sincronizacao de historico continua fora do pipeline', async () => {
  const manager = new BaileysManager();
  const recebidas = [];
  manager.onMessage = async (p) => recebidas.push(p);

  await manager.onMessagesUpsert('leads-1', {
    type: 'prepend',
    messages: [
      {
        key: { remoteJid: '5511999990000@s.whatsapp.net', id: 'X', fromMe: false },
        message: { conversation: 'antiga' },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  });

  assert.equal(recebidas.length, 0, 'carga de historico nao e mensagem nova');
});
