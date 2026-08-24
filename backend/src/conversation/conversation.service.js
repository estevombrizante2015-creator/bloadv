const { Conversation, Message } = require('../models');
const { jidToNumber, isLidJid, jidToIdentifier } = require('../config/agents.config');
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

/** Cria ou atualiza a conversa, sempre reafirmando qual agente a atende. */
async function ensure({ channelId, chatId, agent, channelNumber, verifiedBizName, pushName }) {
  const set = {
    agentId: agent.id,
    agentType: agent.role,
    agentStatusAtBind: agent.status,
    phoneNumber: jidToNumber(chatId),
    isLid: isLidJid(chatId),
    lid: isLidJid(chatId) ? jidToIdentifier(chatId) : null,
  };
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

/** Retoma o atendimento: zera os contadores de suspeita junto. */
async function resume(channelId, chatId) {
  return patch(channelId, chatId, {
    status: Conversation.STATUS.WAITING_USER,
    pausedReason: null,
    pausedAt: null,
    loopCounter: 0,
    repeatCounter: 0,
    fastReplyStreak: 0,
    possibleBot: false,
    processing: false,
  });
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

/** Conversas pausadas de um canal, para o painel. */
const listPaused = (channelId) =>
  Conversation.find({
    ...(channelId ? { sessionId: channelId } : {}),
    status: { $in: [...PAUSED_STATUSES] },
  })
    .sort({ pausedAt: -1 })
    .limit(50)
    .lean();

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
