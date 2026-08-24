const manager = require('../whatsapp/baileys.manager');
const { isValidChannel } = require('../config/channels');
const logger = require('../utils/logger');

/**
 * O socket e o canal de tempo real do front: QR, status e mensagens.
 * As acoes tambem existem em HTTP; aqui ficam por conveniencia da UI.
 */
function socketHandler(io) {
  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'Front conectado');

    // Estado inicial dos 3 canais assim que a UI abre.
    socket.emit('channels:snapshot', manager.listPublicStates());

    socket.on('channels:list', () => {
      socket.emit('channels:snapshot', manager.listPublicStates());
    });

    socket.on('channel:connect', async (channelId, ack) => {
      if (!isValidChannel(channelId)) {
        return ack?.({ error: 'Canal invalido' });
      }
      try {
        const state = await manager.connect(channelId);
        ack?.({ state });
      } catch (error) {
        logger.error({ err: error.message, channelId }, 'Falha ao conectar canal');
        ack?.({ error: error.message });
      }
    });

    socket.on('channel:disconnect', async (channelId, ack) => {
      if (!isValidChannel(channelId)) return ack?.({ error: 'Canal invalido' });
      ack?.({ state: await manager.disconnect(channelId) });
    });

    socket.on('channel:logout', async (channelId, ack) => {
      if (!isValidChannel(channelId)) return ack?.({ error: 'Canal invalido' });
      ack?.({ state: await manager.logout(channelId) });
    });

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'Front desconectado');
    });
  });
}

module.exports = socketHandler;
