const logger = require('./logger');

/**
 * Ponte para o Socket.IO fora do bridge.
 *
 * As rotas HTTP tambem precisam avisar o painel (uma mensagem enviada pelo
 * atendente, por exemplo). Sem isto, elas teriam de receber `io` por parametro
 * em toda a cadeia, ou o painel so veria a mudanca ao trocar de conversa.
 */
let io = null;

const setIo = (instance) => {
  io = instance;
};

function emit(event, payload) {
  if (!io) return false;
  try {
    io.emit(event, payload);
    return true;
  } catch (error) {
    logger.warn({ err: error.message, event }, 'Falha ao emitir evento em tempo real');
    return false;
  }
}

/** Mensagem nova numa conversa, em qualquer direcao. */
const conversationMessage = (payload) => emit('conversation:message', payload);

/** Mudou algo no cabecalho da conversa (status, pausa, agente). */
const conversationUpdate = (payload) => emit('conversation:update', payload);

module.exports = { setIo, emit, conversationMessage, conversationUpdate };
