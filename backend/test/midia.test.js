const test = require('node:test');
const assert = require('node:assert');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste';

const Fastify = require('fastify');
const mongoose = require('mongoose');
const normalizer = require('../src/whatsapp/message.normalizer');
const mediaService = require('../src/whatsapp/media.service');
const mediaStore = require('../src/whatsapp/media.store');
const audioConverter = require('../src/whatsapp/audio.converter');
const multimodal = require('../src/agent/multimodal.service');
const agentService = require('../src/agent/agent.service');
const manager = require('../src/whatsapp/baileys.manager');
const conversationService = require('../src/conversation/conversation.service');
const clienteService = require('../src/clientes/cliente.service');
const conversationsRoutes = require('../src/routes/conversations.routes');
const { Contact, Message } = require('../src/models');

/**
 * O ARQUIVO DA MIDIA CHEGA AO PAINEL
 * ----------------------------------
 * O problema que originou estes testes: o cliente mandava audio, a
 * transcricao falhava e o painel mostrava um traco. O arquivo tinha sido
 * baixado — e jogado fora. Quem assumia o atendimento nao conseguia ouvir o que
 * a pessoa disse sem pegar o celular.
 *
 * O acesso ao WhatsApp, ao GridFS e a OpenAI e trocado por espioes: o que se
 * confere e a decisao de baixar, guardar e repassar o arquivo.
 */

const ARQUIVO_ID = new mongoose.Types.ObjectId();

/** Troca metodos de modulos por espioes durante `acao` e restaura depois. */
async function comEspioes(trocas, acao) {
  const originais = trocas.map(([alvo, nome]) => [alvo, nome, alvo[nome]]);
  for (const [alvo, nome, fn] of trocas) alvo[nome] = fn;
  try {
    return await acao();
  } finally {
    for (const [alvo, nome, fn] of originais) alvo[nome] = fn;
  }
}

const waMidia = (message) => ({
  key: { id: 'm-midia', remoteJid: 'lead@s.whatsapp.net' },
  messageTimestamp: 1700000000,
  message,
});

function espioesDeMidia({ downloadOk = true, transcricaoOk = true } = {}) {
  const chamadas = { download: 0, salvar: [], whisper: 0 };
  const trocas = [
    [
      mediaService,
      'download',
      async ({ inner, type }) => {
        chamadas.download += 1;
        if (!downloadOk) return { ok: false, error: 'midia expirada' };
        const node = inner?.[mediaService.MEDIA_NODES[type]] || {};
        return {
          ok: true,
          buffer: Buffer.from('bytes'),
          mimetype: node.mimetype || 'audio/ogg; codecs=opus',
          bytes: 5,
          seconds: node.seconds || null,
          fileName: node.fileName || null,
        };
      },
    ],
    [
      mediaStore,
      'salvar',
      async (args) => {
        chamadas.salvar.push(args);
        return { fileId: ARQUIVO_ID, bytes: args.buffer.length };
      },
    ],
    [
      multimodal,
      'transcribeAudio',
      async () => {
        chamadas.whisper += 1;
        return transcricaoOk ? { ok: true, text: 'quero saber do FGTS' } : { ok: false, error: '429' };
      },
    ],
  ];
  return { chamadas, trocas };
}

test('audio cuja transcricao falha ainda chega ao painel com o arquivo', async () => {
  const { chamadas, trocas } = espioesDeMidia({ transcricaoOk: false });

  const part = await comEspioes(trocas, () =>
    normalizer.normalize({
      msg: waMidia({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 7 } }),
      channelId: 'leads-1',
      chatId: 'lead@s.whatsapp.net',
    })
  );

  assert.equal(part.type, 'audio');
  assert.equal(part.failed, true, 'a falha continua sinalizada para o agente');
  assert.equal(part.mediaFileId, ARQUIVO_ID, 'o arquivo fica para a equipe ouvir');
  assert.equal(part.seconds, 7);
  assert.equal(chamadas.salvar.length, 1);
});

test('audio com interpretacao desligada e guardado sem pagar Whisper', async () => {
  const { chamadas, trocas } = espioesDeMidia();

  const part = await comEspioes(trocas, () =>
    normalizer.normalize({
      msg: waMidia({ audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }),
      channelId: 'leads-1',
      chatId: 'lead@s.whatsapp.net',
      midia: { audio: false, imagem: false },
    })
  );

  assert.equal(part.naoInterpretada, true);
  assert.equal(part.mediaFileId, ARQUIVO_ID);
  assert.equal(chamadas.whisper, 0, 'desligado na curadoria continua sem custo de OpenAI');
});

test('loop de bot nao baixa nem guarda nada', async () => {
  const { chamadas, trocas } = espioesDeMidia();

  const part = await comEspioes(trocas, () =>
    normalizer.normalize({
      msg: waMidia({ imageMessage: { mimetype: 'image/jpeg' } }),
      channelId: 'leads-1',
      chatId: 'lead@s.whatsapp.net',
      midia: { audio: false, imagem: false, guardar: false },
    })
  );

  assert.equal(part.type, 'image');
  assert.equal(chamadas.download, 0);
  assert.equal(part.mediaFileId, undefined);
});

test('documento com legenda e desembrulhado e guardado com o nome original', async () => {
  const { chamadas, trocas } = espioesDeMidia();

  const part = await comEspioes(trocas, () =>
    normalizer.normalize({
      msg: waMidia({
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              mimetype: 'application/pdf',
              fileName: 'TRCT.pdf',
              caption: 'minha rescisao',
            },
          },
        },
      }),
      channelId: 'leads-1',
      chatId: 'lead@s.whatsapp.net',
    })
  );

  assert.equal(part.type, 'unsupported', 'para o agente continua sendo um marcador');
  assert.equal(part.originalType, 'document');
  assert.equal(part.caption, 'minha rescisao');
  assert.equal(part.mediaFileId, ARQUIVO_ID);
  assert.equal(part.mediaFileName, 'TRCT.pdf');
  assert.equal(chamadas.salvar[0].nome, 'TRCT.pdf');
  assert.match(normalizer.renderBatch([part]), /\[documento recebido\] minha rescisao/);
});

test('download que falha nao derruba a mensagem', async () => {
  const { trocas } = espioesDeMidia({ downloadOk: false });

  const part = await comEspioes(trocas, () =>
    normalizer.normalize({
      msg: waMidia({ videoMessage: { mimetype: 'video/mp4' } }),
      channelId: 'leads-1',
      chatId: 'lead@s.whatsapp.net',
    })
  );

  assert.equal(part.originalType, 'video');
  assert.equal(part.error, 'midia expirada');
  assert.equal(part.mediaFileId, undefined);
});

test('o historico grava o tipo real e o arquivo da parte', async () => {
  let gravados = null;

  await comEspioes(
    [[Message, 'insertMany', async (docs) => (gravados = docs)]],
    () =>
      agentService.persistParts({
        channelId: 'leads-1',
        jid: 'lead@s.whatsapp.net',
        parts: [
          {
            type: 'unsupported',
            originalType: 'document',
            caption: 'segue',
            mediaFileId: ARQUIVO_ID,
            mediaFileName: 'TRCT.pdf',
            mediaMimeType: 'application/pdf',
          },
          { type: 'audio', transcription: 'oi', mediaFileId: ARQUIVO_ID, seconds: 4 },
        ],
        batchId: 'b1',
        startSeq: 1,
      })
  );

  assert.equal(gravados[0].type, 'document', 'o painel precisa saber que e documento');
  assert.equal(gravados[0].mediaFileId, ARQUIVO_ID);
  assert.equal(gravados[0].mediaFileName, 'TRCT.pdf');
  assert.equal(gravados[1].mediaSeconds, 4);
});

test('duracao da nota de voz vem do progresso do ffmpeg', () => {
  const log = 'size= 1kB time=00:00:01.20 ...\nsize= 9kB time=00:01:05.62 bitrate=...';
  assert.equal(audioConverter.segundosDoLog(log), 66);
  assert.equal(audioConverter.segundosDoLog('sem tempo'), null);
});

// ------------------------------------------------------------ envio pelo painel

const CHAT = '5519996383884@s.whatsapp.net';

async function enviarArquivo({ query, corpo = Buffer.from('arquivo'), conversao }) {
  const enviados = [];
  const gravadas = [];

  const trocas = [
    [manager, 'publicState', () => ({ status: 'connected', label: 'Novos Casos 01' })],
    [manager, 'sendMedia', async (_canal, _chat, conteudo) => enviados.push(conteudo)],
    [manager, 'sendText', async () => {}],
    [manager, 'agentFor', () => null],
    [mediaStore, 'salvar', async ({ buffer }) => ({ fileId: ARQUIVO_ID, bytes: buffer.length })],
    [Contact, 'findOneAndUpdate', async () => ({ messageCount: 3 })],
    [
      Message,
      'create',
      async (doc) => {
        gravadas.push(doc);
        const salvo = { ...doc, _id: new mongoose.Types.ObjectId(), createdAt: new Date() };
        return { ...salvo, toObject: () => salvo };
      },
    ],
    [conversationService, 'pause', async () => null],
    [conversationService, 'patch', async () => null],
    [clienteService, 'registrarInteracao', async () => null],
    ...(conversao ? [[audioConverter, 'paraNotaDeVoz', conversao]] : []),
  ];

  return comEspioes(trocas, async () => {
    const app = Fastify();
    await app.register(conversationsRoutes);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/conversations/leads-1/${encodeURIComponent(CHAT)}/media?${new URLSearchParams(query)}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: corpo,
      });
      return { res, enviados, gravadas };
    } finally {
      await app.close();
    }
  });
}

test('foto enviada pelo painel vai como imagem, com legenda, e fica no historico', async () => {
  const { res, enviados, gravadas } = await enviarArquivo({
    query: { mimetype: 'image/jpeg', nome: 'foto.jpg', legenda: 'segue o comprovante' },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(Buffer.isBuffer(enviados[0].image));
  assert.equal(enviados[0].caption, 'segue o comprovante');

  assert.equal(gravadas[0].type, 'image');
  assert.equal(gravadas[0].sentBy, 'human');
  assert.equal(gravadas[0].mediaFileId, ARQUIVO_ID);
  assert.equal(res.json().mensagem.midia.id, ARQUIVO_ID.toString());
});

test('PDF vai como documento com o nome que o contato vai ver', async () => {
  const { enviados, gravadas } = await enviarArquivo({
    query: { mimetype: 'application/pdf', nome: '../../procuracao.pdf' },
  });

  assert.equal(enviados[0].fileName, '....procuracao.pdf', 'sem caminho no nome');
  assert.equal(enviados[0].mimetype, 'application/pdf');
  assert.equal(gravadas[0].type, 'document');
  assert.equal(gravadas[0].text, '[documento enviado]', 'o agente le um marcador, nao um turno vazio');
});

test('audio gravado no painel vira nota de voz', async () => {
  const { enviados, gravadas } = await enviarArquivo({
    query: { mimetype: 'audio/webm;codecs=opus', voz: '1', segundos: '5' },
    conversao: async () => ({
      ok: true,
      buffer: Buffer.from('OggS'),
      mimetype: audioConverter.MIME_NOTA_DE_VOZ,
      seconds: 6,
    }),
  });

  assert.equal(enviados[0].ptt, true);
  assert.equal(enviados[0].mimetype, 'audio/ogg; codecs=opus');
  assert.equal(enviados[0].seconds, 6);
  assert.equal(gravadas[0].type, 'audio');
  assert.equal(gravadas[0].mediaMimeType, 'audio/ogg; codecs=opus', 'guarda o que o contato recebeu');
});

test('sem conversao, gravacao em WebM vai como documento em vez de audio mudo', async () => {
  const { enviados } = await enviarArquivo({
    query: { mimetype: 'audio/webm;codecs=opus', voz: '1' },
    conversao: async () => ({ ok: false, error: 'ffmpeg indisponivel' }),
  });

  assert.ok(enviados[0].document, 'WebM como audio nao toca em todo celular');
});

test('arquivo vazio e recusado antes de tocar o WhatsApp', async () => {
  const { res, enviados } = await enviarArquivo({
    query: { mimetype: 'image/png' },
    corpo: Buffer.alloc(0),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(enviados.length, 0);
});

test('arquivo inexistente responde 404', async (t) => {
  const app = Fastify();
  await app.register(conversationsRoutes);
  t.after(() => app.close());

  const res = await comEspioes([[mediaStore, 'abrir', async () => null]], () =>
    app.inject({ method: 'GET', url: `/api/midias/${ARQUIVO_ID}` })
  );
  assert.equal(res.statusCode, 404);
});
