const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';

const { ConversationBuffer } = require('../src/conversation/buffer.service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (content) => ({ type: 'text', content, waMessageId: `m-${content}` });

/**
 * Janelas curtas para o teste rodar rapido; a logica e a mesma da producao.
 * As tres janelas precisam ser explicitas: sem isso as mensagens curtas dos
 * testes cairiam na janela de "frase incompleta" vinda do .env.
 */
const makeBuffer = (over = {}) =>
  new ConversationBuffer({
    windowMs: 60,
    typingWindowMs: 200,
    incompleteWindowMs: 60,
    maxWaitMs: 1000,
    maxMessages: 20,
    ...over,
  });

test('quatro mensagens seguidas geram UMA unica execucao', async () => {
  const buffer = makeBuffer();
  const flushes = [];
  buffer.onFlush = async ({ parts }) => flushes.push(parts);

  buffer.add({ channelId: 'c1', chatId: 'a@s.whatsapp.net', part: text('Oi') });
  await sleep(20);
  buffer.add({ channelId: 'c1', chatId: 'a@s.whatsapp.net', part: text('vi o anuncio') });
  await sleep(20);
  buffer.add({ channelId: 'c1', chatId: 'a@s.whatsapp.net', part: text('como funciona') });
  await sleep(20);
  buffer.add({ channelId: 'c1', chatId: 'a@s.whatsapp.net', part: text('e quanto custa') });

  await sleep(150);

  assert.equal(flushes.length, 1, 'deveria responder uma unica vez');
  assert.equal(flushes[0].length, 4);
  buffer.clear();
});

test('cada nova mensagem reinicia a janela de silencio', async () => {
  const buffer = makeBuffer({ windowMs: 80, incompleteWindowMs: 80 });
  let flushed = 0;
  buffer.onFlush = async () => {
    flushed += 1;
  };

  buffer.add({ channelId: 'c1', chatId: 'a', part: text('1') });
  await sleep(50);
  assert.equal(flushed, 0, 'ainda dentro da janela');

  buffer.add({ channelId: 'c1', chatId: 'a', part: text('2') });
  await sleep(50);
  assert.equal(flushed, 0, 'janela foi estendida pela segunda mensagem');

  await sleep(80);
  assert.equal(flushed, 1);
  buffer.clear();
});

test('ordem cronologica e preservada, sem reagrupar por tipo', async () => {
  const buffer = makeBuffer();
  let parts = null;
  buffer.onFlush = async (batch) => {
    parts = batch.parts;
  };

  buffer.add({ channelId: 'c1', chatId: 'a', part: { type: 'text', content: 'vou mandar uma foto' } });
  buffer.add({ channelId: 'c1', chatId: 'a', part: { type: 'image', description: 'um holerite' } });
  buffer.add({ channelId: 'c1', chatId: 'a', part: { type: 'text', content: 'e esse aqui' } });
  buffer.add({ channelId: 'c1', chatId: 'a', part: { type: 'audio', transcription: 'explicando' } });

  await sleep(150);

  assert.deepEqual(
    parts.map((p) => p.type),
    ['text', 'image', 'text', 'audio'],
    'a ordem de envio define o sentido; nao pode ser reordenada'
  );
  buffer.clear();
});

test('buffers de conversas diferentes sao independentes', async () => {
  const buffer = makeBuffer({ windowMs: 80, incompleteWindowMs: 80 });
  const flushes = [];
  buffer.onFlush = async ({ chatId, parts }) => flushes.push({ chatId, size: parts.length });

  buffer.add({ channelId: 'c1', chatId: 'leadA', part: text('a1') });
  await sleep(50);

  // mensagem do Lead B nao pode estender nem misturar com a do Lead A
  buffer.add({ channelId: 'c1', chatId: 'leadB', part: text('b1') });
  await sleep(50);

  assert.equal(flushes.length, 1, 'A ja deveria ter fechado');
  assert.equal(flushes[0].chatId, 'leadA');

  await sleep(80);
  assert.equal(flushes.length, 2);
  assert.equal(flushes[1].chatId, 'leadB');
  assert.ok(flushes.every((f) => f.size === 1), 'contextos nunca se misturam');
  buffer.clear();
});

test('mesmo chatId em canais diferentes nao se mistura', async () => {
  const buffer = makeBuffer();
  const flushes = [];
  buffer.onFlush = async ({ channelId, parts }) => flushes.push({ channelId, size: parts.length });

  buffer.add({ channelId: 'leads-1', chatId: 'mesmo@jid', part: text('x') });
  buffer.add({ channelId: 'leads-2', chatId: 'mesmo@jid', part: text('y') });

  await sleep(150);

  assert.equal(flushes.length, 2);
  assert.ok(flushes.every((f) => f.size === 1));
  assert.deepEqual(flushes.map((f) => f.channelId).sort(), ['leads-1', 'leads-2']);
  buffer.clear();
});

test('teto de espera consolida mesmo sem silencio', async () => {
  const buffer = makeBuffer({ windowMs: 1000, incompleteWindowMs: 1000, maxWaitMs: 120 });
  let trigger = null;
  buffer.onFlush = async (batch) => {
    trigger = batch.trigger;
  };

  // contato digitando sem parar: a janela de silencio nunca fecharia sozinha
  const interval = setInterval(() => {
    buffer.add({ channelId: 'c1', chatId: 'a', part: text(String(Math.random())) });
  }, 30);

  await sleep(220);
  clearInterval(interval);

  assert.equal(trigger, 'teto_de_espera');
  buffer.clear();
});

test('lote cheio consolida antes da janela', async () => {
  const buffer = makeBuffer({ windowMs: 5000, incompleteWindowMs: 5000, maxMessages: 3 });
  let size = 0;
  buffer.onFlush = async ({ parts }) => {
    size = parts.length;
  };

  buffer.add({ channelId: 'c1', chatId: 'a', part: text('1') });
  buffer.add({ channelId: 'c1', chatId: 'a', part: text('2') });
  buffer.add({ channelId: 'c1', chatId: 'a', part: text('3') });

  await sleep(50);
  assert.equal(size, 3);
  buffer.clear();
});

test('nao processa a mesma conversa em paralelo', async () => {
  const buffer = makeBuffer({ windowMs: 40, incompleteWindowMs: 40 });
  let concurrent = 0;
  let maxConcurrent = 0;

  buffer.onFlush = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(120);
    concurrent -= 1;
  };

  buffer.add({ channelId: 'c1', chatId: 'a', part: text('1') });
  await sleep(60); // dispara o primeiro flush
  buffer.add({ channelId: 'c1', chatId: 'a', part: text('2') }); // chega durante o processamento
  await sleep(300);

  assert.equal(maxConcurrent, 1, 'lock por conversa deve impedir execucao concorrente');
  buffer.clear();
});

test('mensagem recebida durante o processamento nao se perde', async () => {
  const buffer = makeBuffer({ windowMs: 40, incompleteWindowMs: 40 });
  const lotes = [];

  buffer.onFlush = async ({ parts }) => {
    lotes.push(parts.map((p) => p.content));
    await sleep(100);
  };

  buffer.add({ channelId: 'c1', chatId: 'a', part: text('primeira') });
  await sleep(60); // flush comeca
  buffer.add({ channelId: 'c1', chatId: 'a', part: text('durante') });
  await sleep(400);

  assert.equal(lotes.length, 2, 'a mensagem que chegou durante deve virar um segundo ciclo');
  assert.deepEqual(lotes[0], ['primeira']);
  assert.deepEqual(lotes[1], ['durante']);
  buffer.clear();
});

test('inspect reporta o estado da conversa', async () => {
  const buffer = makeBuffer({ windowMs: 200, incompleteWindowMs: 200 });
  buffer.onFlush = async () => {};

  assert.deepEqual(buffer.inspect('c1', 'a'), {
    open: false,
    size: 0,
    processing: false,
    pending: 0,
  });

  buffer.add({ channelId: 'c1', chatId: 'a', part: text('1') });
  const state = buffer.inspect('c1', 'a');
  assert.equal(state.open, true);
  assert.equal(state.size, 1);

  buffer.clear();
});

test('drop e dropChannel limpam as janelas abertas', async () => {
  const buffer = makeBuffer({ windowMs: 500, incompleteWindowMs: 500 });
  let flushed = 0;
  buffer.onFlush = async () => {
    flushed += 1;
  };

  buffer.add({ channelId: 'c1', chatId: 'a', part: text('1') });
  buffer.add({ channelId: 'c1', chatId: 'b', part: text('2') });
  buffer.add({ channelId: 'c2', chatId: 'c', part: text('3') });

  assert.equal(buffer.drop('c1', 'a'), true);
  assert.equal(buffer.dropChannel('c1'), 1);
  assert.equal(buffer.size, 1);

  await sleep(600);
  assert.equal(flushed, 1, 'apenas a conversa do outro canal deveria ter fechado');
  buffer.clear();
});


// ------------------------------------------------ janela adaptativa

test('frase terminada responde rapido; frase cortada espera mais', () => {
  const buffer = new ConversationBuffer({ windowMs: 2000, incompleteWindowMs: 3500 });

  const rapido = ['Bom dia!', 'Fui demitido ontem.', 'Quanto tempo demora?'];
  for (const t of rapido) {
    assert.equal(buffer.windowFor({ type: 'text', content: t }), 2000, `deveria ser rapido: ${t}`);
  }

  const espera = ['oi', 'preciso de ajuda com', 'vou mandar uma foto e', 'entao,'];
  for (const t of espera) {
    assert.equal(buffer.windowFor({ type: 'text', content: t }), 3500, `deveria esperar: ${t}`);
  }
});

test('"cidade" nao e confundido com a conjuncao "de"', () => {
  const buffer = new ConversationBuffer({ windowMs: 2000, incompleteWindowMs: 3500 });
  assert.equal(buffer.windowFor({ type: 'text', content: 'moro na cidade' }), 2000);
  assert.equal(buffer.windowFor({ type: 'text', content: 'moro perto de' }), 3500);
});

test('contato digitando estende a janela; parar de digitar encurta', async () => {
  const buffer = makeBuffer({ windowMs: 60, incompleteWindowMs: 60, typingWindowMs: 400 });
  let flushed = 0;
  buffer.onFlush = async () => {
    flushed += 1;
  };

  buffer.add({ channelId: 'c1', chatId: 'a', part: text('mensagem longa o suficiente') });
  assert.equal(buffer.onTyping('c1', 'a'), true, 'janela estendida');

  await sleep(150);
  assert.equal(flushed, 0, 'nao pode responder enquanto a pessoa digita');

  buffer.onTypingStopped('c1', 'a');
  await sleep(150);
  assert.equal(flushed, 1, 'parou de digitar: responde logo');
  buffer.clear();
});

test('sinal de digitacao em conversa sem buffer aberto e ignorado', () => {
  const buffer = makeBuffer();
  assert.equal(buffer.onTyping('c1', 'ninguem'), false);
  assert.equal(buffer.onTypingStopped('c1', 'ninguem'), false);
  buffer.clear();
});
