const mongoose = require('mongoose');

/**
 * Estado de uma conversa (um contato dentro de um canal).
 * Persistido para que reinicializacao nao perca vinculo de agente,
 * contador anti-loop nem a marcacao de pausa.
 */
const CONVERSATION_STATUS = {
  WAITING_MESSAGES: 'WAITING_MESSAGES', // buffer aberto, aguardando silencio
  READY_TO_PROCESS: 'READY_TO_PROCESS', // janela fechou, vai processar
  PROCESSING: 'PROCESSING', // agente rodando (lock logico)
  WAITING_USER: 'WAITING_USER', // respondemos, aguardando o contato
  PAUSED: 'PAUSED', // agente pausado manualmente ou por guardrail
  BOT_LOOP_DETECTED: 'BOT_LOOP_DETECTED', // suspeita de bot x bot
  CLOSED: 'CLOSED',
};

const ConversationSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, index: true }, // jid do contato
    sessionId: { type: String, required: true, index: true }, // canal/instancia
    phoneNumber: String, // numero do contato (digitos)
    pushName: String, // nome que o contato exibe no WhatsApp
    // O WhatsApp usa LID no lugar do telefone em muitos chats; o numero real
    // nao e exposto pelo protocolo, entao nao ha o que preencher.
    isLid: { type: Boolean, default: false },
    lid: String,
    channelNumber: String, // numero NOSSO que atende esta conversa

    agentId: { type: String, index: true },
    agentType: String, // role: leads | clients
    agentStatusAtBind: String,

    status: {
      type: String,
      enum: Object.values(CONVERSATION_STATUS),
      default: CONVERSATION_STATUS.WAITING_MESSAGES,
      index: true,
    },

    lastUserMessageAt: Date,
    lastAgentMessageAt: Date,

    bufferStatus: { type: String, enum: ['idle', 'open', 'flushing'], default: 'idle' },
    bufferSize: { type: Number, default: 0 },
    processing: { type: Boolean, default: false },
    processingSince: Date,

    // --- anti-loop ---
    possibleBot: { type: Boolean, default: false },
    botSignals: { type: [String], default: [] },
    loopCounter: { type: Number, default: 0 }, // interacoes automaticas consecutivas
    repeatCounter: { type: Number, default: 0 }, // nossas respostas repetidas seguidas
    fastReplyStreak: { type: Number, default: 0 }, // respostas do contato rapidas demais
    lastOutboundHash: String,
    lastInboundHash: String,
    pausedReason: String,
    pausedAt: Date,

    interactions: { type: Number, default: 0 },
    // Ultima vez que o aviso de fora-do-expediente foi enviado a este contato.
    lastAwayNoticeAt: Date,
  },
  { timestamps: true }
);

ConversationSchema.index({ sessionId: 1, chatId: 1 }, { unique: true });

ConversationSchema.statics.STATUS = CONVERSATION_STATUS;

module.exports = mongoose.model('Conversation', ConversationSchema);
module.exports.CONVERSATION_STATUS = CONVERSATION_STATUS;
