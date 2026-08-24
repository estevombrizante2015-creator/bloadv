const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

const { downloadMediaMessage } = baileys;
const waLogger = pino({ level: 'silent' });

/**
 * Download da midia recebida no WhatsApp.
 * Isolado do resto para que uma falha aqui (midia expirada, chave perdida,
 * servidor do WhatsApp fora) nunca derrube o atendimento: devolve erro e o
 * pipeline segue tratando a mensagem como "midia nao lida".
 */

const MEDIA_NODES = {
  audio: 'audioMessage',
  image: 'imageMessage',
  video: 'videoMessage',
  document: 'documentMessage',
  sticker: 'stickerMessage',
};

function mediaNode(message, type) {
  const key = MEDIA_NODES[type];
  return key ? message?.[key] : null;
}

/** Limite por tipo, para nao gastar banda nem tokens com arquivo gigante. */
function sizeLimitFor(type) {
  if (type === 'audio') return env.media.audioMaxBytes;
  if (type === 'image') return env.media.imageMaxBytes;
  return env.media.imageMaxBytes;
}

/**
 * @returns {Promise<{ok: boolean, buffer?: Buffer, mimetype?: string, bytes?: number, error?: string}>}
 */
async function download({ msg, type, sock, channelId }) {
  if (!env.media.enabled) {
    return { ok: false, error: 'midia desabilitada por configuracao' };
  }

  const inner = msg.message?.ephemeralMessage?.message || msg.message;
  const node = mediaNode(inner, type);

  if (!node) return { ok: false, error: `mensagem sem no de midia para tipo ${type}` };

  const declaredSize = Number(node.fileLength || 0);
  const limit = sizeLimitFor(type);
  if (declaredSize && declaredSize > limit) {
    return { ok: false, error: `arquivo acima do limite (${declaredSize} > ${limit} bytes)` };
  }

  if (type === 'audio' && node.seconds && node.seconds > env.media.audioMaxSeconds) {
    return {
      ok: false,
      error: `audio acima do limite (${node.seconds}s > ${env.media.audioMaxSeconds}s)`,
    };
  }

  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: waLogger, reuploadRequest: sock?.updateMediaMessage }
    );

    if (!buffer?.length) return { ok: false, error: 'download retornou vazio' };
    if (buffer.length > limit) {
      return { ok: false, error: `arquivo acima do limite apos download (${buffer.length} bytes)` };
    }

    return {
      ok: true,
      buffer,
      mimetype: node.mimetype || null,
      bytes: buffer.length,
      seconds: node.seconds || null,
    };
  } catch (error) {
    logger.warn(
      { ev: EV.MEDIA_DOWNLOAD_FAILED, channelId, type, err: error.message },
      'Falha ao baixar midia'
    );
    return { ok: false, error: error.message };
  }
}

module.exports = { download, mediaNode, MEDIA_NODES };
