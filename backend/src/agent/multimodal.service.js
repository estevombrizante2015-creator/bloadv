const sharp = require('sharp');
const { toFile } = require('openai');
const { env } = require('../config/env');
const { getClient } = require('./openai.service');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * Transcricao de audio (Whisper) e leitura de imagem (visao).
 *
 * Regra de resiliencia: nada aqui lanca para cima. Falha de Whisper ou de visao
 * devolve `{ ok: false, error }` e o pipeline continua - a mensagem entra no
 * contexto como "audio nao transcrito" em vez de derrubar o atendimento.
 */

const MIME_EXTENSION = {
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

const audioExtension = (mimetype) => MIME_EXTENSION[(mimetype || '').toLowerCase()] || 'ogg';

/**
 * Audio -> texto, via Whisper.
 * O contato pode falar; a resposta do agente sempre volta em texto.
 */
async function transcribeAudio({ buffer, mimetype, channelId, chatId }) {
  const startedAt = Date.now();
  logger.info(
    { ev: EV.AUDIO_TRANSCRIPTION_STARTED, channelId, chatId, bytes: buffer?.length, mimetype },
    'Transcrevendo audio'
  );

  try {
    const file = await toFile(buffer, `audio.${audioExtension(mimetype)}`, {
      type: mimetype || 'audio/ogg',
    });

    const result = await getClient().audio.transcriptions.create({
      file,
      model: env.media.whisperModel,
      language: 'pt',
      // Vocabulario do dominio: reduz erro em termos que o Whisper nao conhece.
      prompt:
        'Atendimento de escritorio de advocacia trabalhista. Termos comuns: rescisao, ' +
        'verbas rescisorias, FGTS, aviso previo, hora extra, insalubridade, periculosidade, ' +
        'assedio moral, justa causa, carteira assinada, CTPS, INSS, estabilidade, holerite.',
    });

    const text = (result.text || '').trim();
    const latencyMs = Date.now() - startedAt;

    logger.info(
      { ev: EV.AUDIO_TRANSCRIPTION_FINISHED, channelId, chatId, chars: text.length, latencyMs },
      'Audio transcrito'
    );

    if (!text) return { ok: false, error: 'transcricao vazia' };
    return { ok: true, text, latencyMs };
  } catch (error) {
    logger.error(
      { ev: EV.AUDIO_TRANSCRIPTION_FAILED, channelId, chatId, err: error.message },
      'Whisper falhou'
    );
    return { ok: false, error: error.message };
  }
}

const VISION_PROMPT = [
  'Voce LE imagens recebidas no WhatsApp de um escritorio de advocacia trabalhista.',
  '',
  'Sua tarefa principal e TRANSCREVER o texto que aparece na imagem. O contato',
  'costuma fotografar documento ou mandar print, e o conteudo escrito e o que importa.',
  '',
  'Faca, nesta ordem:',
  '1. Diga em uma linha o que e a imagem (holerite, termo de rescisao, CTPS,',
  '   extrato de FGTS, contrato, atestado, print de conversa, tela de sistema, foto comum).',
  '2. TRANSCREVA o texto legivel, fielmente. Nao resuma valores, datas, nomes de',
  '   campos, numeros de processo nem periodos - copie como esta.',
  '3. Em print de conversa, indique quem disse o que.',
  '4. Se algo estiver ilegivel, diga qual parte, em vez de adivinhar.',
  '',
  'Seja completo no texto e economico no resto: nada de descrever cores, fundo ou',
  'diagramacao que nao carregue informacao.',
  '',
  'Nao interprete juridicamente, nao opine, nao conclua nada sobre o caso da pessoa.',
  'Voce le e transcreve; quem analisa e o advogado.',
].join('\n');

const MAX_LADO = 1600;

/**
 * Reduz a imagem se ela for maior que o necessario para ler texto.
 * Falha aqui nao e fatal: manda o original.
 */
async function prepararImagem(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    const maior = Math.max(meta.width || 0, meta.height || 0);

    if (maior <= MAX_LADO) {
      return { buffer, bytes: buffer.length, redimensionada: false };
    }

    const reduzida = await sharp(buffer)
      .rotate() // respeita o EXIF: foto de celular costuma vir deitada
      .resize({ width: MAX_LADO, height: MAX_LADO, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();

    return { buffer: reduzida, bytes: reduzida.length, redimensionada: true };
  } catch {
    return { buffer, bytes: buffer.length, redimensionada: false };
  }
}

/**
 * Imagem -> descricao textual.
 * A legenda entra junto: "e esse aqui?" so faz sentido com a imagem ao lado.
 */
async function describeImage({ buffer, mimetype, caption, channelId, chatId, conversationHint }) {
  const startedAt = Date.now();
  logger.info(
    { ev: EV.IMAGE_ANALYSIS_STARTED, channelId, chatId, bytes: buffer?.length, mimetype },
    'Analisando imagem'
  );

  try {
    // Foto de celular vem com 3000px ou mais. Em `detail: high` a OpenAI cobra
    // por ladrilho, entao mandar o arquivo cru custa muito sem ganhar leitura:
    // acima de ~1600px o texto ja esta legivel. Redimensionar da precisao de
    // documento com custo controlado.
    const { buffer: pronta, bytes, redimensionada } = await prepararImagem(buffer);
    const dataUrl = `data:${redimensionada ? 'image/jpeg' : mimetype || 'image/jpeg'};base64,${pronta.toString('base64')}`;

    const userContent = [
      {
        type: 'text',
        text: [
          caption ? `Legenda enviada junto: "${caption}"` : 'A imagem veio sem legenda.',
          conversationHint ? `Contexto da conversa ate aqui: ${conversationHint}` : '',
          'Descreva a imagem.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      // `detail` decide se a OpenAI le a imagem inteira ou uma versao reduzida
      // a 512px. Com 'low' o texto de um holerite ou print vira borrao - o que
      // e exatamente o conteudo que este escritorio recebe. Custa mais tokens
      // e vale cada um deles.
      { type: 'image_url', image_url: { url: dataUrl, detail: env.media.visionDetail } },
    ];

    const response = await getClient().chat.completions.create({
      model: env.media.visionModel,
      temperature: 0.2,
      max_tokens: env.media.visionMaxTokens,
      messages: [
        { role: 'system', content: VISION_PROMPT },
        { role: 'user', content: userContent },
      ],
    });

    const description = (response.choices?.[0]?.message?.content || '').trim();
    const latencyMs = Date.now() - startedAt;
    const usage = {
      prompt: response.usage?.prompt_tokens || 0,
      completion: response.usage?.completion_tokens || 0,
      total: response.usage?.total_tokens || 0,
    };

    logger.info(
      {
        ev: EV.IMAGE_ANALYSIS_FINISHED,
        channelId,
        chatId,
        chars: description.length,
        latencyMs,
        usage,
        bytesEnviados: bytes,
        redimensionada,
      },
      'Imagem analisada'
    );

    if (!description) return { ok: false, error: 'descricao vazia' };
    return { ok: true, description, usage, latencyMs };
  } catch (error) {
    logger.error(
      { ev: EV.IMAGE_ANALYSIS_FAILED, channelId, chatId, err: error.message },
      'Analise de imagem falhou'
    );
    return { ok: false, error: error.message };
  }
}

module.exports = { transcribeAudio, describeImage, audioExtension };
