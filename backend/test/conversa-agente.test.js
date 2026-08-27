const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const conversationService = require('../src/conversation/conversation.service');
const agentService = require('../src/agent/agent.service');
const curadoria = require('../src/curadoria/config.service');
const clienteService = require('../src/clientes/cliente.service');
const manager = require('../src/whatsapp/baileys.manager');
const buffer = require('../src/conversation/buffer.service');
const { registerBridge } = require('../src/whatsapp/bridge');
const { Conversation, ProcessedMessage } = require('../src/models');

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

// ------------------------------- quem responde assume o atendimento

/**
 * O bridge conversa com Mongo em todo passo. Aqui cada dependencia vira um
 * espiao: o que esta sob teste e a DECISAO de calar o agente, nao a gravacao.
 */
function comBridgeEspiao(ajustes = {}) {
  const original = [];
  const trocar = (obj, chave, valor) => {
    const antigo = obj[chave];
    original.push(() => {
      obj[chave] = antigo;
    });
    obj[chave] = valor;
  };

  const registro = { pausas: [], lotesGravados: [], respostasDoAgente: 0 };

  trocar(conversationService, 'ensure', async () => ajustes.conversa || { status: 'WAITING_USER' });
  trocar(conversationService, 'get', async () => ajustes.conversa || { status: 'WAITING_USER' });
  trocar(conversationService, 'recentHint', async () => null);
  trocar(conversationService, 'patch', async () => ({}));
  trocar(conversationService, 'pause', async (canal, chat, motivo) => {
    registro.pausas.push({ canal, chat, motivo });
    return {};
  });

  trocar(agentService, 'getOrCreateContact', async () => ({
    messageCount: 3,
    save: async () => {},
  }));
  trocar(agentService, 'persistParts', async ({ parts, direction, sentBy }) => {
    registro.lotesGravados.push({ partes: parts.length, direction, sentBy });
  });
  trocar(agentService, 'handleBatch', async () => {
    registro.respostasDoAgente += 1;
    return { reply: null, tier: null, meta: {} };
  });

  trocar(curadoria, 'publicada', () => ({}));
  trocar(curadoria, 'estaAtivo', () => true);
  trocar(clienteService, 'registrarInteracao', async () => {});

  trocar(ProcessedMessage, 'create', async () => ({}));
  trocar(ProcessedMessage, 'updateMany', () => Promise.resolve({}));

  trocar(manager, 'agentFor', () => ({ id: 'teste', role: 'leads', status: 'ativo' }));
  trocar(manager, 'getState', () => ({ phoneNumber: '5511999990000' }));
  trocar(manager, 'socketFor', () => null);

  registerBridge(null);

  return { registro, restaurar: () => original.forEach((f) => f()) };
}

const mensagemDoAparelho = {
  channelId: CANAL,
  jid: PESSOA,
  msg: {
    key: { remoteJid: PESSOA, id: 'RESPOSTA-DO-ADVOGADO', fromMe: true },
    message: { conversation: 'Bom dia, ja estou vendo seu caso.' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  },
  waMessageId: 'RESPOSTA-DO-ADVOGADO',
  timestamp: Date.now(),
};

test('responder pelo celular pausa o agente naquela conversa', async () => {
  // Escrever pelo painel ja pausava. Pelo aparelho, nao: o advogado respondia
  // do celular e o agente seguia atuando, os dois falando com a mesma pessoa.
  const { registro, restaurar } = comBridgeEspiao();

  try {
    await manager.onOwnMessage(mensagemDoAparelho);
  } finally {
    restaurar();
  }

  assert.equal(registro.pausas.length, 1, 'quem responde assume o atendimento');
  assert.equal(registro.pausas[0].canal, CANAL);
  assert.equal(registro.pausas[0].chat, PESSOA, 'a pausa e desta conversa, nao do canal');
  assert.equal(registro.pausas[0].motivo, 'atendimento_humano');

  // E a resposta entra no historico como mensagem de saida escrita por pessoa.
  assert.deepEqual(registro.lotesGravados, [{ partes: 1, direction: 'out', sentBy: 'human' }]);
});

test('conversa ja pausada nao tem o motivo trocado', async () => {
  // Sobrescrever apagaria a razao real do silencio (loop de bot, pedido do
  // contato) e o painel passaria a mostrar "atendimento_humano" no lugar.
  const { registro, restaurar } = comBridgeEspiao({
    conversa: { status: 'BOT_LOOP_DETECTED', pausedReason: 'loop_de_bot' },
  });

  try {
    await manager.onOwnMessage(mensagemDoAparelho);
  } finally {
    restaurar();
  }

  assert.equal(registro.pausas.length, 0);
});

test('mensagem que ficou no buffer nao e respondida depois da pausa', async () => {
  /**
   * A checagem de pausa no flush vinha DEPOIS de marcar a conversa como
   * PROCESSING, e lia o documento que ela mesma acabara de escrever: nunca era
   * verdadeira. O contato mandava a mensagem, o advogado assumia dentro da
   * janela do buffer, e o agente respondia assim mesmo alguns segundos depois.
   */
  const { registro, restaurar } = comBridgeEspiao({
    conversa: { status: 'PAUSED', pausedReason: 'atendimento_humano' },
  });

  try {
    await buffer.onFlush({
      channelId: CANAL,
      chatId: PESSOA,
      parts: [{ type: 'text', content: 'e o meu caso?', waMessageId: 'DO-CONTATO' }],
      meta: {},
    });
  } finally {
    restaurar();
  }

  assert.equal(registro.respostasDoAgente, 0, 'o agente esta calado nesta conversa');
  // Mas o que o contato disse continua no historico: quem persistia era o
  // proprio handleBatch, entao o lote descartado antes dele sumia do banco.
  assert.deepEqual(registro.lotesGravados, [
    { partes: 1, direction: undefined, sentBy: undefined },
  ]);
});
