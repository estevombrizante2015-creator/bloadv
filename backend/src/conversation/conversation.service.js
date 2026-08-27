const { Conversation, Message, Contact } = require('../models');
const { jidToNumber, isLidJid, jidToIdentifier, formatNumber } = require('../config/agents.config');
const lidResolver = require('../whatsapp/lid.resolver');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * Estado da conversa: quem atende, em que ponto esta, e se pode responder.
 * Fica no Mongo porque reiniciar a aplicacao nao pode perder o vinculo do
 * agente nem a marcacao de pausa por loop.
 */

const PAUSED_STATUSES = new Set([
  Conversation.STATUS.PAUSED,
  Conversation.STATUS.BOT_LOOP_DETECTED,
  Conversation.STATUS.CLOSED,
]);

/**
 * Cria ou atualiza a conversa, sempre reafirmando qual agente a atende.
 *
 * @param {string} [phoneNumber] telefone real do contato, quando o protocolo
 *   revelou (ver whatsapp/lid.resolver). Em chat por LID e a unica forma de
 *   saber o numero - o `chatId` sozinho e um identificador opaco.
 */
async function ensure({
  channelId,
  chatId,
  agent,
  channelNumber,
  verifiedBizName,
  pushName,
  phoneNumber,
}) {
  const eLid = isLidJid(chatId);

  const set = {
    agentId: agent.id,
    agentType: agent.role,
    agentStatusAtBind: agent.status,
    isLid: eLid,
    lid: eLid ? jidToIdentifier(chatId) : null,
  };

  // Chat comum: o numero esta no proprio jid. Chat por LID: vale o que o
  // protocolo revelou agora, ou o que ja foi aprendido antes.
  //
  // A atribuicao e condicional de proposito. `senderPn` nao vem em toda
  // mensagem, e sobrescrever com null o numero ja descoberto faria o painel
  // perder o telefone a cada mensagem que chegasse sem ele.
  const numero = eLid ? phoneNumber || lidResolver.resolver(chatId) : jidToNumber(chatId);
  if (numero) set.phoneNumber = numero;

  if (channelNumber) set.channelNumber = channelNumber;
  if (pushName) set.pushName = pushName;

  const conversation = await Conversation.findOneAndUpdate(
    { sessionId: channelId, chatId },
    {
      $set: set,
      $setOnInsert: { status: Conversation.STATUS.WAITING_MESSAGES },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Conta Business e apenas um sinal registrado. NUNCA bloqueia sozinha:
  // muita empresa legitima usa Business, e perder esses leads seria pior.
  if (verifiedBizName && !conversation.botSignals?.includes('conta_business')) {
    conversation.botSignals = [...(conversation.botSignals || []), 'conta_business'];
    await conversation.save();
  }

  return conversation;
}

const get = (channelId, chatId) =>
  Conversation.findOne({ sessionId: channelId, chatId });

/**
 * Atualiza campos da conversa. Aceita `$inc` misturado aos `$set`
 * para o chamador nao precisar montar o update do Mongo.
 */
async function patch(channelId, chatId, changes = {}) {
  const { $inc, ...set } = changes;
  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if ($inc) update.$inc = $inc;
  if (!Object.keys(update).length) return get(channelId, chatId);

  return Conversation.findOneAndUpdate({ sessionId: channelId, chatId }, update, { new: true });
}

const isPaused = (conversation) =>
  Boolean(conversation) && PAUSED_STATUSES.has(conversation.status);

async function pause(channelId, chatId, reason) {
  logger.warn({ ev: EV.AGENT_PAUSED, channelId, chatId, reason }, 'Agente pausado na conversa');
  return patch(channelId, chatId, {
    status: Conversation.STATUS.PAUSED,
    pausedReason: reason,
    pausedAt: new Date(),
    processing: false,
  });
}

/**
 * Retoma o atendimento: zera os contadores de suspeita junto.
 *
 * E LIMPA O HANDOFF DO CONTATO. O silencio do agente mora em dois documentos
 * diferentes — `Conversation.status` (pausada) e `Contact.humanHandoff` (o
 * contato foi entregue a uma pessoa) — e o guardrail de entrada consulta o
 * segundo ANTES de qualquer outra coisa, descartando a mensagem sem responder
 * nada (input.guard: `handoff_humano_ativo`).
 *
 * Enquanto isto limpava so o primeiro, "Retomar" no painel devolvia a conversa
 * ao estado normal e o agente continuava mudo, para sempre, sem log nenhum. O
 * sintoma era o pior possivel: o botao dizia que funcionou e a pessoa do outro
 * lado seguia sem resposta.
 *
 * `optedOut` NAO e limpo aqui de proposito: pedir para nao receber mensagem e
 * decisao do contato, nao estado de atendimento.
 */
async function resume(channelId, chatId) {
  const conversation = await patch(channelId, chatId, {
    status: Conversation.STATUS.WAITING_USER,
    pausedReason: null,
    pausedAt: null,
    loopCounter: 0,
    repeatCounter: 0,
    fastReplyStreak: 0,
    possibleBot: false,
    processing: false,
  });

  try {
    await Contact.updateOne(
      { channelId, jid: chatId },
      { $set: { humanHandoff: false, handoffReason: null } }
    );
  } catch (error) {
    logger.warn(
      { err: error.message, channelId, chatId },
      'Conversa retomada, mas o handoff do contato nao foi limpo'
    );
  }

  return conversation;
}

/**
 * Resumo de uma linha do que se falou ha pouco. Serve para a analise de imagem
 * entender "e esse aqui?" sem carregar a conversa inteira para a visao.
 */
async function recentHint(channelId, chatId, limit = 3) {
  const docs = await Message.find({ channelId, jid: chatId }, { text: 1, role: 1 })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  if (!docs.length) return null;

  return docs
    .reverse()
    .map((d) => `${d.role === 'user' ? 'contato' : 'atendimento'}: ${(d.text || '').slice(0, 120)}`)
    .join(' | ');
}

/**
 * Conversas pausadas de um canal, para o painel.
 *
 * Vai junto QUEM e a pessoa. A lista devolvia so o documento da conversa, e o
 * painel exibia uma coluna de telefones crus: para decidir qual atendimento
 * retomar primeiro, quem opera tinha de abrir uma por uma. O nome mora no
 * contato (`pushName`), nao na conversa — dai a juncao aqui, em uma consulta
 * so para a pagina inteira.
 */
async function listPaused(channelId) {
  const conversas = await Conversation.find({
    ...(channelId ? { sessionId: channelId } : {}),
    status: { $in: [...PAUSED_STATUSES] },
  })
    .sort({ pausedAt: -1 })
    .limit(50)
    .lean();

  if (!conversas.length) return [];

  const contatos = await Contact.find(
    { $or: conversas.map((c) => ({ channelId: c.sessionId, jid: c.chatId })) },
    { channelId: 1, jid: 1, pushName: 1 }
  ).lean();

  const porChave = new Map(contatos.map((c) => [`${c.channelId}:${c.jid}`, c]));

  return conversas.map((conversa) => {
    const contato = porChave.get(`${conversa.sessionId}:${conversa.chatId}`);

    // Conversas gravadas antes de o telefone aparecer nao tem `phoneNumber`; o
    // vinculo aprendido depois resolve sem precisar de migracao.
    const numero =
      conversa.phoneNumber || lidResolver.resolver(conversa.chatId) || jidToNumber(conversa.chatId);

    return {
      ...conversa,
      nome: contato?.pushName || conversa.pushName || null,
      phoneNumber: numero || null,
      numero: numero ? formatNumber(numero) : null,
      // Chat por LID cujo telefone ainda nao apareceu: melhor dizer isso do que
      // formatar o identificador opaco como se fosse um telefone.
      isLid: Boolean(conversa.isLid) && !numero,
      identificador: conversa.lid || null,
    };
  });
}

module.exports = {
  ensure,
  get,
  patch,
  pause,
  resume,
  isPaused,
  recentHint,
  listPaused,
  PAUSED_STATUSES,
};
