const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';

const antiloop = require('../src/guardrails/antiloop.service');
const { env } = require('../src/config/env');

/** Conversa mínima, no formato que o servico espera. */
const conv = (over = {}) => ({
  loopCounter: 0,
  repeatCounter: 0,
  fastReplyStreak: 0,
  botSignals: [],
  possibleBot: false,
  lastAgentMessageAt: null,
  lastInboundHash: null,
  lastOutboundHash: null,
  ...over,
});

test('mensagem humana comum nao levanta nenhum sinal', () => {
  const r = antiloop.evaluateInbound({
    conversation: conv(),
    text: 'Bom dia, fui demitido semana passada e queria ajuda',
  });
  assert.equal(r.block, false);
  assert.deepEqual(r.signals, []);
  assert.equal(r.patch.loopCounter, 0);
  assert.equal(r.patch.possibleBot, false);
});

test('reconhece texto tipico de resposta automatica', () => {
  const automaticos = [
    'Esta e uma mensagem automatica. Retornaremos em breve.',
    'Estamos fora do horario de atendimento.',
    'Digite o numero da opcao desejada',
    '1 - Vendas\n2 - Suporte\n3 - Financeiro',
    'Obrigado por entrar em contato! Retornaremos assim que possivel.',
  ];
  for (const texto of automaticos) {
    assert.equal(antiloop.looksAutomatic(texto).automatic, true, `nao detectou: ${texto}`);
  }
});

test('nao confunde mensagem humana com automacao', () => {
  const humanos = [
    'Oi, tudo bem? Vi o anuncio de voces',
    'Trabalhei 3 anos sem carteira assinada',
    'Meu horario era das 8h as 18h todo dia',
    'Recebi so 2 mil na rescisao e achei pouco',
  ];
  for (const texto of humanos) {
    assert.equal(antiloop.looksAutomatic(texto).automatic, false, `falso positivo: ${texto}`);
  }
});

test('um sinal isolado nao pausa nada', () => {
  const r = antiloop.evaluateInbound({
    conversation: conv(),
    text: 'Estamos fora do horario de atendimento.',
  });
  assert.equal(r.block, false, 'um sinal so nao pode pausar o atendimento');
  assert.equal(r.patch.loopCounter, 1);
  assert.equal(r.patch.possibleBot, true, 'mas fica registrado como suspeita');
});

test('evidencia acumulada pausa a conversa', () => {
  let conversation = conv();
  let last = null;

  for (let i = 0; i < env.antiloop.maxAutoInteractions; i += 1) {
    last = antiloop.evaluateInbound({
      conversation,
      text: `Mensagem automatica numero ${i}. Retornaremos em breve.`,
    });
    conversation = { ...conversation, ...last.patch };
  }

  assert.equal(last.block, true);
  assert.equal(last.reason, 'possible_bot_loop');
  assert.equal(last.patch.status, 'BOT_LOOP_DETECTED');
});

test('uma mensagem claramente humana zera a suspeita acumulada', () => {
  let conversation = conv();

  for (let i = 0; i < 3; i += 1) {
    const r = antiloop.evaluateInbound({ conversation, text: 'Mensagem automatica.' });
    conversation = { ...conversation, ...r.patch };
  }
  assert.ok(conversation.loopCounter >= 3);

  const humana = antiloop.evaluateInbound({
    conversation,
    text: 'Desculpa a demora, estava no trabalho. Posso falar agora',
  });
  assert.equal(humana.patch.loopCounter, 0, 'contato humano deve zerar o contador');
  assert.equal(humana.block, false);
});

test('resposta instantanea repetida indica cadencia nao humana', () => {
  let conversation = conv({ lastAgentMessageAt: new Date() });
  let last = null;

  for (let i = 0; i < env.antiloop.fastReplyStreak; i += 1) {
    last = antiloop.evaluateInbound({
      conversation,
      text: `resposta ${i}`,
      receivedAt: Date.now() + 100, // 100ms depois da nossa mensagem
    });
    conversation = { ...conversation, ...last.patch, lastAgentMessageAt: new Date() };
  }

  assert.ok(last.signals.includes('cadencia_automatica'));
});

test('intervalo humano normal zera a contagem de respostas rapidas', () => {
  const conversation = conv({
    lastAgentMessageAt: new Date(Date.now() - 30_000),
    fastReplyStreak: 3,
  });
  const r = antiloop.evaluateInbound({ conversation, text: 'oi, desculpa a demora' });
  assert.equal(r.patch.fastReplyStreak, 0);
});

test('mesma entrada repetida e sinalizada', () => {
  const primeira = antiloop.evaluateInbound({ conversation: conv(), text: 'ola' });
  const segunda = antiloop.evaluateInbound({
    conversation: conv({ lastInboundHash: primeira.patch.lastInboundHash }),
    text: 'ola',
  });
  assert.ok(segunda.signals.includes('entrada_repetida'));
});

test('hash ignora acento, caixa e espaco', () => {
  assert.equal(antiloop.hash('Olá,  Tudo Bem?'), antiloop.hash('ola, tudo bem?'));
});

test('nossa resposta repetida pausa antes de virar ping-pong', () => {
  const texto = 'Pode me contar um pouco mais sobre o que aconteceu?';
  let conversation = conv();
  let last = null;

  for (let i = 0; i <= env.antiloop.maxRepeats; i += 1) {
    last = antiloop.evaluateOutbound({ conversation, text: texto });
    conversation = { ...conversation, ...last.patch };
  }

  assert.equal(last.block, true);
  assert.equal(last.reason, 'resposta_repetida');
});

test('resposta diferente zera o contador de repeticao', () => {
  const conversation = conv({ lastOutboundHash: antiloop.hash('igual'), repeatCounter: 2 });
  const r = antiloop.evaluateOutbound({ conversation, text: 'agora e outra coisa' });
  assert.equal(r.block, false);
  assert.equal(r.patch.repeatCounter, 0);
});

test('conta Business por si so nao gera sinal de bot', () => {
  // O sinal 'conta_business' e registrado pelo conversation.service como
  // contexto, mas nao entra na avaliacao que pausa o atendimento.
  const r = antiloop.evaluateInbound({
    conversation: conv({ botSignals: ['conta_business'] }),
    text: 'Ola, gostaria de saber sobre rescisao',
  });
  assert.equal(r.block, false);
  assert.deepEqual(r.signals, [], 'ser Business nao e evidencia de automacao');
  assert.equal(r.patch.loopCounter, 0);
});
