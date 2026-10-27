const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');

/**
 * AUDIO GRAVADO NO PAINEL -> NOTA DE VOZ DO WHATSAPP
 * --------------------------------------------------
 * O navegador grava em WebM (Chrome, Edge) ou MP4 (Safari). A nota de voz do
 * WhatsApp e OGG/Opus: mandado como veio, o audio chega como arquivo — e em
 * celular iPhone muitas vezes nem toca. A conversao e o que faz o audio do
 * advogado chegar como chega o de qualquer pessoa.
 *
 * O ffmpeg vem do pacote `ffmpeg-static`, para nao depender do que a imagem
 * do servidor traz instalado. Sem ele, quem chama envia o original como
 * arquivo de audio: chega pior, mas chega.
 */

const ffmpegPath = (() => {
  try {
    return require('ffmpeg-static') || null;
  } catch {
    return null;
  }
})();

const MIME_NOTA_DE_VOZ = 'audio/ogg; codecs=opus';

const jaENotaDeVoz = (mimetype) => /^audio\/ogg/i.test(mimetype || '') && /opus/i.test(mimetype || '');

function rodarFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const processo = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    processo.stderr.on('data', (chunk) => {
      // So o fim interessa (duracao e erro); o log inteiro pode ser grande.
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    processo.once('error', reject);
    processo.once('close', (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg saiu com ${code}: ${stderr.slice(-300)}`))
    );
  });
}

/** Ultimo `time=` do progresso: o WebM do navegador nao declara duracao. */
function segundosDoLog(stderr) {
  const tempos = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const ultimo = tempos.at(-1);
  if (!ultimo) return null;
  const [, h, m, s] = ultimo;
  return Math.round(Number(h) * 3600 + Number(m) * 60 + Number(s));
}

/**
 * @returns {Promise<{ok: true, buffer: Buffer, mimetype: string, seconds: number|null}|{ok: false, error: string}>}
 */
async function paraNotaDeVoz({ buffer, mimetype }) {
  if (jaENotaDeVoz(mimetype)) {
    return { ok: true, buffer, mimetype: MIME_NOTA_DE_VOZ, seconds: null };
  }
  if (!ffmpegPath) return { ok: false, error: 'ffmpeg indisponivel' };

  // Arquivo temporario, nao pipe: o MP4 do Safari pode ter o indice no fim, e
  // o ffmpeg nao volta atras num pipe.
  const base = path.join(os.tmpdir(), `nota-${crypto.randomBytes(6).toString('hex')}`);
  const entrada = `${base}.in`;
  const saida = `${base}.ogg`;

  try {
    await fs.writeFile(entrada, buffer);
    const log = await rodarFfmpeg([
      '-hide_banner',
      '-y',
      '-i', entrada,
      '-vn',
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-application', 'voip',
      saida,
    ]);
    const convertido = await fs.readFile(saida);
    return { ok: true, buffer: convertido, mimetype: MIME_NOTA_DE_VOZ, seconds: segundosDoLog(log) };
  } catch (error) {
    logger.warn({ err: error.message, mimetype }, 'Falha ao converter audio para nota de voz');
    return { ok: false, error: error.message };
  } finally {
    await Promise.all([fs.rm(entrada, { force: true }), fs.rm(saida, { force: true })]);
  }
}

module.exports = { paraNotaDeVoz, MIME_NOTA_DE_VOZ, segundosDoLog };
