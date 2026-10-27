const mediaService = require('./media.service');
const mediaStore = require('./media.store');
const multimodal = require('../agent/multimodal.service');
const logger = require('../utils/logger');

/**
 * Converte um evento cru do Baileys numa PARTE normalizada da conversa.
 * Todo o resto do sistema so conhece esta estrutura:
 *
 *   { type: 'text',  content: '...' }
 *   { type: 'audio', transcription: '...', failed?: true }
 *   { type: 'image', description: '...', caption: '...', failed?: true }
 *
 * Toda parte com midia carrega tambem `mediaFileId`: o arquivo guardado (ver
 * media.store), para o painel tocar o audio e mostrar a imagem.
 *
 * Assim o buffer, o agente e a persistencia nao precisam saber nada de WhatsApp.
 */

const SUPPORTED = new Set(['text', 'audio', 'image']);

/** Tipo da mensagem a partir do no do protocolo. */
function messageType(message) {
  if (!message) return 'unknown';
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.audioMessage) return 'audio';
  if (message.videoMessage) return 'video';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  if (message.locationMessage) return 'location';
  if (message.contactMessage) return 'contact';
  if (message.reactionMessage) return 'reaction';
  if (message.protocolMessage) return 'protocol';
  return 'unknown';
}

/** Texto puro ou legenda, conforme o tipo. */
function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    null
  );
}

/** Desembrulha mensagens efemeras e "view once". */
function unwrap(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    // Documento com legenda chega embrulhado; sem isto virava "mensagem".
    message?.documentWithCaptionMessage?.message ||
    message
  );
}

const FALLBACK_LABEL = {
  video: 'video',
  document: 'documento',
  sticker: 'figurinha',
  location: 'localizacao',
  contact: 'contato',
  unknown: 'mensagem',
};

/** Tipos que trazem arquivo: o painel precisa do arquivo para exibi-los. */
const COM_ARQUIVO = new Set(['audio', 'image', 'video', 'document', 'sticker']);

const EXTENSAO_PADRAO = {
  audio: 'ogg',
  image: 'jpg',
  video: 'mp4',
  sticker: 'webp',
  document: 'bin',
};

/**
 * Baixa a midia e guarda o arquivo. Download que falha devolve `{ media }`
 * com `ok: false`; guardar que falha so deixa a parte sem `mediaFileId`.
 */
async function baixarEGuardar({ msg, inner, type, sock, channelId, chatId, origem }) {
  const media = await mediaService.download({ msg, inner, type, sock, channelId });
  if (!media.ok) return { media, arquivo: {} };

  const nome = media.fileName || `${type}.${EXTENSAO_PADRAO[type] || 'bin'}`;
  const guardado = await mediaStore.salvar({
    buffer: media.buffer,
    mimetype: media.mimetype,
    nome,
    channelId,
    chatId,
    origem,
  });

  return {
    media,
    arquivo: {
      mediaMimeType: media.mimetype,
      mediaBytes: media.bytes,
      ...(media.seconds ? { seconds: media.seconds } : {}),
      ...(guardado ? { mediaFileId: guardado.fileId, mediaFileName: nome } : {}),
    },
  };
}

/**
 * Normaliza uma mensagem, processando midia quando necessario.
 * NUNCA lanca: qualquer falha vira uma parte marcada com `failed`, para o
 * agente saber que houve algo e poder pedir reenvio.
 *
 * @param {object} [midia] o que a curadoria autoriza interpretar neste agente.
 *   Desligar audio ou imagem NAO descarta a mensagem: ela vira uma parte
 *   marcada, o agente e avisado que nao consegue ler aquilo e pede o conteudo
 *   em texto. Descartar em silencio deixaria o contato falando sozinho, que e
 *   o pior desfecho possivel para quem mandou um audio pedindo ajuda.
 *
 *   `midia.guardar: false` dispensa ate o arquivo — so no loop de bot, em que
 *   a outra ponta e suspeita de ser automatica e ninguem esta lendo.
 *
 * @returns {Promise<object|null>} parte normalizada, ou null se deve ser ignorada
 */
async function normalize({ msg, channelId, chatId, sock, conversationHint, midia, origem = 'contato' }) {
  const interpretar = { audio: midia?.audio !== false, imagem: midia?.imagem !== false };
  const guardar = midia?.guardar !== false;
  const inner = unwrap(msg.message);
  const type = messageType(inner);
  const timestamp = Number(msg.messageTimestamp) * 1000 || Date.now();

  const base = {
    waMessageId: msg.key?.id,
    timestamp,
    type,
  };

  // Eventos de protocolo e reacoes nao sao conteudo de conversa.
  if (type === 'protocol' || type === 'reaction') return null;

  if (type === 'text') {
    const content = (extractText(inner) || '').trim();
    if (!content) return null;
    return { ...base, content };
  }

  // O arquivo e baixado mesmo com a interpretacao desligada: a equipe precisa
  // ouvir o audio que o agente nao pode ouvir.
  const precisaBaixar =
    COM_ARQUIVO.has(type) &&
    (guardar || (type === 'audio' && interpretar.audio) || (type === 'image' && interpretar.imagem));

  const { media, arquivo } = precisaBaixar
    ? await baixarEGuardar({ msg, inner, type, sock, channelId, chatId, origem })
    : { media: null, arquivo: {} };

  if (type === 'audio') {
    if (!interpretar.audio) {
      return {
        ...base,
        ...arquivo,
        failed: true,
        naoInterpretada: true,
        transcription: null,
        ...(media && !media.ok ? { error: media.error } : {}),
      };
    }

    if (!media.ok) {
      return { ...base, failed: true, error: media.error, transcription: null };
    }

    const result = await multimodal.transcribeAudio({
      buffer: media.buffer,
      mimetype: media.mimetype,
      channelId,
      chatId,
    });

    return {
      ...base,
      ...arquivo,
      transcription: result.ok ? result.text : null,
      failed: !result.ok,
      error: result.ok ? undefined : result.error,
    };
  }

  if (type === 'image') {
    const caption = (extractText(inner) || '').trim() || null;

    if (!interpretar.imagem) {
      return {
        ...base,
        ...arquivo,
        caption,
        failed: true,
        naoInterpretada: true,
        description: null,
        ...(media && !media.ok ? { error: media.error } : {}),
      };
    }

    if (!media.ok) {
      return { ...base, caption, failed: true, error: media.error, description: null };
    }

    const result = await multimodal.describeImage({
      buffer: media.buffer,
      mimetype: media.mimetype,
      caption,
      channelId,
      chatId,
      conversationHint,
    });

    return {
      ...base,
      ...arquivo,
      caption,
      description: result.ok ? result.description : null,
      visionUsage: result.usage || null,
      failed: !result.ok,
      error: result.ok ? undefined : result.error,
    };
  }

  // Tipos nao suportados entram como marcador, com a legenda se houver. O
  // agente nao le video nem documento, mas o arquivo fica para a equipe.
  const caption = (extractText(inner) || '').trim() || null;
  logger.debug({ channelId, chatId, type }, 'Tipo de mensagem sem processamento dedicado');
  return {
    ...base,
    ...arquivo,
    type: 'unsupported',
    originalType: type,
    label: FALLBACK_LABEL[type] || 'mensagem',
    caption,
    ...(media && !media.ok ? { error: media.error } : {}),
  };
}

/**
 * Consolida as partes de um lote num unico texto para o agente,
 * PRESERVANDO a ordem cronologica de envio - o sentido depende dela.
 */
function renderBatch(parts) {
  const lines = [];

  for (const part of parts) {
    if (part.type === 'text') {
      lines.push(part.content);
    } else if (part.type === 'audio') {
      if (part.transcription) lines.push(`[audio transcrito] ${part.transcription}`);
      // O marcador distingue "falhou" de "desligado na configuracao": no
      // segundo caso pedir para reenviar o audio nao resolveria nada.
      else if (part.naoInterpretada) lines.push('[audio recebido; voce nao consegue ouvir audio]');
      else lines.push('[audio recebido, nao foi possivel transcrever]');
    } else if (part.type === 'image') {
      const pieces = [];
      if (part.description) pieces.push(`[imagem] ${part.description}`);
      else if (part.naoInterpretada) pieces.push('[imagem recebida; voce nao consegue ver imagens]');
      else pieces.push('[imagem recebida, nao foi possivel analisar]');
      if (part.caption) pieces.push(`[legenda da imagem] ${part.caption}`);
      lines.push(pieces.join('\n'));
    } else if (part.type === 'unsupported') {
      lines.push(`[${part.label} recebido]${part.caption ? ` ${part.caption}` : ''}`);
    }
  }

  return lines.filter(Boolean).join('\n');
}

/** Texto "cru" do que o contato disse, sem os marcadores - usado no anti-loop. */
function plainText(parts) {
  return parts
    .map((p) => p.content || p.transcription || p.caption || '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** Resumo dos tipos presentes no lote, para log e auditoria. */
const batchTypes = (parts) => parts.map((p) => p.type);

const hasFailure = (parts) => parts.some((p) => p.failed);

module.exports = {
  normalize,
  renderBatch,
  plainText,
  batchTypes,
  hasFailure,
  messageType,
  extractText,
  unwrap,
  SUPPORTED,
};
