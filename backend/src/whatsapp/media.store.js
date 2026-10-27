const mongoose = require('mongoose');
const logger = require('../utils/logger');

/**
 * ARQUIVO DA MIDIA, GUARDADO NO BANCO
 * -----------------------------------
 * Audio, imagem e documento eram baixados so para transcrever e ler, e o
 * arquivo ia embora logo depois. O painel ficava com a transcricao — e quando
 * ela falhava, com um traco: a equipe assumia o atendimento sem conseguir
 * ouvir o que o cliente tinha dito.
 *
 * O arquivo mora no GridFS do mesmo MongoDB, pelo mesmo motivo das credenciais
 * do WhatsApp (ver whatsapp/auth.store): o banco ja e obrigatorio e duravel, e
 * disco de container some a cada deploy.
 *
 * Nada aqui lanca para cima: falhar ao guardar nao pode derrubar o
 * atendimento. A mensagem segue sem o arquivo, como era antes.
 */

const BUCKET = 'midias';

const bucket = () =>
  new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

const comoObjectId = (id) => {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

/**
 * @returns {Promise<{fileId: import('mongoose').Types.ObjectId, bytes: number}|null>}
 */
async function salvar({ buffer, mimetype, nome, channelId, chatId, origem }) {
  if (!buffer?.length || !mongoose.connection.db) return null;

  try {
    const fileId = await new Promise((resolve, reject) => {
      const upload = bucket().openUploadStream(nome || 'midia', {
        metadata: { mimetype: mimetype || 'application/octet-stream', channelId, chatId, origem },
      });
      upload.once('error', reject);
      upload.once('finish', () => resolve(upload.id));
      upload.end(buffer);
    });

    return { fileId, bytes: buffer.length };
  } catch (error) {
    logger.warn({ err: error.message, channelId, chatId }, 'Falha ao guardar o arquivo da midia');
    return null;
  }
}

/** Abre o arquivo para leitura, ou null se ele nao existe. */
async function abrir(fileId) {
  const id = comoObjectId(fileId);
  if (!id || !mongoose.connection.db) return null;

  const [arquivo] = await bucket().find({ _id: id }).limit(1).toArray();
  if (!arquivo) return null;

  return {
    stream: bucket().openDownloadStream(id),
    mimetype: arquivo.metadata?.mimetype || 'application/octet-stream',
    bytes: arquivo.length,
    nome: arquivo.filename,
  };
}

/** Apaga os arquivos de uma conversa excluida. Ignora o que ja nao existe. */
async function remover(fileIds = []) {
  if (!mongoose.connection.db) return 0;

  let removidos = 0;
  for (const fileId of fileIds) {
    const id = comoObjectId(fileId);
    if (!id) continue;
    try {
      await bucket().delete(id);
      removidos += 1;
    } catch {
      // Arquivo ja apagado: o objetivo foi atingido.
    }
  }
  return removidos;
}

module.exports = { salvar, abrir, remover, BUCKET };
