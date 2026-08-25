const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const conversationService = require('../src/conversation/conversation.service');
const { Conversation } = require('../src/models');

/**
 * LIGAR E DESLIGAR O AGENTE POR PESSOA
 * ------------------------------------
 * O medo que originou estes testes: "quando envio mensagem desabilita para
 * todas". O alcance de uma pausa e a diferenca entre assumir UM atendimento e
 * derrubar o atendimento automatico do escritorio inteiro — e nada na tela
 * denuncia o erro, porque as outras conversas simplesmente param de responder.
 *
 * Os testes trocam o acesso ao banco por um espiao e conferem o FILTRO da
 * consulta. E o filtro que define o alcance; executar contra um banco de
 * verdade provaria o mesmo caso a caso, mas nao provaria que a consulta nao
 * pode alcancar mais do que devia.
 */

/** Substitui o acesso ao banco por um espiao e devolve os filtros usados. */
async function filtrosDe(acao) {
  const original = Conversation.findOneAndUpdate;
  const capturados = [];

  Conversation.findOneAndUpdate = (filtro, update) => {
    capturados.push({ filtro, update });
    return Promise.resolve(null);
  };

  try {
    await acao();
  } finally {
    Conversation.findOneAndUpdate = original;
  }

  return capturados;
}

const CANAL = 'leads-1';
const PESSOA = '5519996383884@s.whatsapp.net';

test('pausar o agente alcanca UMA conversa, nunca o canal inteiro', async () => {
  const [{ filtro }] = await filtrosDe(() =>
    conversationService.pause(CANAL, PESSOA, 'atendimento_humano')
  );

  assert.equal(filtro.sessionId, CANAL);
  assert.equal(filtro.chatId, PESSOA, 'sem o chatId a consulta pegaria outra conversa do canal');
  assert.equal(Object.keys(filtro).length, 2, 'nada alem de canal + pessoa no filtro');
});

test('devolver ao agente tambem alcanca uma conversa so', async () => {
  const [{ filtro, update }] = await filtrosDe(() => conversationService.resume(CANAL, PESSOA));

  assert.equal(filtro.sessionId, CANAL);
  assert.equal(filtro.chatId, PESSOA);

  // Retomar zera a suspeita acumulada: senao a conversa volta e e pausada de
  // novo no primeiro sinal, e o atendente conclui que o botao nao funciona.
  assert.equal(update.$set.loopCounter, 0);
  assert.equal(update.$set.possibleBot, false);
  assert.equal(update.$set.pausedReason, null);
});

test('a pausa nunca usa updateMany: o alcance e de uma conversa por construcao', async () => {
  const originalMany = Conversation.updateMany;
  let chamou = false;
  Conversation.updateMany = () => {
    chamou = true;
    return Promise.resolve({});
  };

  try {
    await filtrosDe(() => conversationService.pause(CANAL, PESSOA, 'atendimento_humano'));
  } finally {
    Conversation.updateMany = originalMany;
  }

  assert.equal(chamou, false, 'uma escrita em massa aqui derrubaria o agente de todo mundo');
});

test('so a propria conversa decide se esta pausada', () => {
  // `isPaused` le o status do documento recebido. Se algum dia passasse a
  // consultar o canal, uma pausa individual apagaria o agente dos demais.
  const emAtendimento = { status: 'WAITING_USER' };
  const assumida = { status: 'PAUSED' };
  const emLoop = { status: 'BOT_LOOP_DETECTED' };

  assert.equal(conversationService.isPaused(emAtendimento), false);
  assert.equal(conversationService.isPaused(assumida), true);
  assert.equal(conversationService.isPaused(emLoop), true);
  assert.equal(conversationService.isPaused(null), false);
});

test('o estado pausado nao vaza entre conversas do mesmo canal', () => {
  const conversas = [
    { chatId: 'a@s.whatsapp.net', status: 'PAUSED' },
    { chatId: 'b@s.whatsapp.net', status: 'WAITING_USER' },
    { chatId: 'c@s.whatsapp.net', status: 'WAITING_MESSAGES' },
  ];

  const pausadas = conversas.filter((c) => conversationService.isPaused(c));
  assert.equal(pausadas.length, 1);
  assert.equal(pausadas[0].chatId, 'a@s.whatsapp.net');
});
