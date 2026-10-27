const { Conversation, Contact, Message, AgentRun, GuardrailEvent } = require('../models');
const manager = require('../whatsapp/baileys.manager');
const mediaStore = require('../whatsapp/media.store');
const audioConverter = require('../whatsapp/audio.converter');
const multimodal = require('../agent/multimodal.service');
const curadoria = require('../curadoria/config.service');
const { env } = require('../config/env');
const conversationService = require('../conversation/conversation.service');
const buffer = require('../conversation/buffer.service');
const {
  formatNumber,
  digitsOnly,
  jidToIdentifier,
  jidToNumber,
  comDdiBrasil,
} = require('../config/agents.config');
const lidResolver = require('../whatsapp/lid.resolver');
const clienteService = require('../clientes/cliente.service');
const { getChannel } = require('../config/channels');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');
const realtime = require('../utils/realtime');

/**
 * Historico de conversas: quem falou com o escritorio, o que foi dito e como
 * o agente respondeu. Serve tanto para acompanhar leads quanto para auditar
 * a performance do agente e do time.
 */

/** Junta o que o painel precisa mostrar numa linha da lista. */
function resumo(conversation, contact) {
  // Conversas gravadas antes da descoberta do telefone nao tem `phoneNumber`;
  // o vinculo aprendido depois resolve sem precisar de migracao.
  const numero = conversation.phoneNumber || lidResolver.resolver(conversation.chatId);

  return {
    id: conversation._id.toString(),
    chatId: conversation.chatId,
    channelId: conversation.sessionId,
    channelLabel: getChannel(conversation.sessionId)?.label || conversation.sessionId,
    nome: contact?.pushName || conversation.pushName || null,
    numero: numero ? formatNumber(numero) : null,
    numeroBruto: numero || null,
    // Chat por LID cujo telefone ainda nao apareceu. Melhor dizer isso do que
    // exibir o identificador formatado como se fosse um numero.
    isLid: Boolean(conversation.isLid) && !numero,
    identificador: conversation.lid || null,
    agentId: conversation.agentId,
    agentType: conversation.agentType,
    status: conversation.status,
    pausedReason: conversation.pausedReason || null,
    possibleBot: conversation.possibleBot,
    botSignals: conversation.botSignals || [],
    interactions: conversation.interactions || 0,
    mensagens: contact?.messageCount || 0,
    tokens: contact?.tokenUsage?.tokens || 0,
    handoff: contact?.humanHandoff ? contact.handoffReason : null,
    optedOut: Boolean(contact?.optedOut),
    tipoCaso: contact?.ontology?.slots?.tipo_caso || null,
    estagio: contact?.ontology?.stage || null,
    lastUserMessageAt: conversation.lastUserMessageAt,
    lastAgentMessageAt: conversation.lastAgentMessageAt,
    updatedAt: conversation.updatedAt,
  };
}

/** O arquivo da mensagem, no formato que o painel usa para exibi-lo. */
const midiaDaMensagem = (m) =>
  m.mediaFileId
    ? {
        id: m.mediaFileId.toString(),
        mimetype: m.mediaMimeType || null,
        bytes: m.mediaBytes || null,
        nome: m.mediaFileName || null,
        segundos: m.mediaSeconds || null,
      }
    : null;

/** Mensagem do banco no formato da tela. */
const paraTela = (m) => ({
  id: m._id.toString(),
  direcao: m.direction,
  tipo: m.type,
  texto: m.text,
  transcricao: m.transcription || null,
  descricaoImagem: m.imageDescription || null,
  legenda: m.caption || null,
  erroMidia: m.mediaError || null,
  midia: midiaDaMensagem(m),
  tier: m.tier || null,
  autor: m.sentBy || 'agent',
  operador: m.operatorEmail || null,
  tokens: m.tokens?.total || 0,
  bloqueadoPor: m.blockedBy || null,
  lote: m.batchId || null,
  em: m.createdAt,
});

/**
 * Como o arquivo vai para o WhatsApp.
 *
 * Imagem e video so viram "foto" e "video" nos formatos que todo celular
 * abre; o resto vai como documento, que sempre chega e sempre baixa. Audio
 * idem: MP3 e M4A tocam no app, WAV e WebM nao.
 */
const AUDIO_TOCAVEL = /^audio\/(mpeg|mp3|mp4|m4a|aac|ogg|amr)\b/i;

function tipoDoEnvio(mimetype) {
  if (/^image\/(jpeg|png)$/i.test(mimetype)) return 'image';
  if (/^video\/(mp4|3gpp)$/i.test(mimetype)) return 'video';
  if (AUDIO_TOCAVEL.test(mimetype)) return 'audio';
  return 'document';
}

const MARCADOR_ENVIO = {
  image: '[imagem enviada]',
  video: '[video enviado]',
  audio: '[audio enviado]',
  document: '[documento enviado]',
};

/** Nome que vai para o celular do contato: sem caminho e sem controle. */
const nomeSeguro = (nome, padrao) =>
  String(nome || '')
    .replace(/[\\/\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 200) || padrao;

const mimetypeSeguro = (mimetype) =>
  /^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(String(mimetype || '').trim())
    ? String(mimetype).trim().slice(0, 120)
    : 'application/octet-stream';

async function conversationsRoutes(fastify) {
  /**
   * Arquivo enviado pelo painel chega cru, sem JSON nem base64: o corpo e o
   * proprio arquivo, e nome, tipo e legenda vao na query. Vale so para as
   * rotas deste plugin — o resto da API continua recusando corpo binario.
   */
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: env.media.fileMaxBytes + 1024 },
    (request, body, done) => done(null, body)
  );

  /**
   * O arquivo de uma mensagem: audio, imagem, video ou documento.
   *
   * Pede o token como qualquer rota da API — o painel baixa com `fetch` e
   * monta o player a partir do resultado. Token na URL acabaria em log de
   * proxy e no historico do navegador.
   */
  fastify.get('/api/midias/:fileId', async (request, reply) => {
    const arquivo = await mediaStore.abrir(request.params.fileId).catch(() => null);
    if (!arquivo) return reply.code(404).send({ error: 'Arquivo nao encontrado' });

    return reply
      .header('Content-Type', arquivo.mimetype)
      .header('Content-Length', arquivo.bytes)
      .header('Cache-Control', 'private, max-age=86400')
      .header(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(arquivo.nome || 'arquivo')}`
      )
      .send(arquivo.stream);
  });

  /**
   * Lista de conversas, com filtros de busca.
   * Query: channelId, status, agentId, q (nome ou numero), limit, skip
   */
  fastify.get('/api/conversations', async (request) => {
    const { channelId, status, agentId, q, limit = 50, skip = 0 } = request.query || {};

    const filtro = {};
    if (channelId) filtro.sessionId = channelId;
    if (status) filtro.status = status;
    if (agentId) filtro.agentId = agentId;
    if (q) {
      const termo = String(q).trim();
      const digitos = termo.replace(/\D/g, '');
      filtro.$or = [
        { chatId: { $regex: termo, $options: 'i' } },
        ...(digitos ? [{ phoneNumber: { $regex: digitos } }] : []),
      ];
    }

    const [conversations, total] = await Promise.all([
      Conversation.find(filtro)
        .sort({ updatedAt: -1 })
        .skip(Number(skip))
        .limit(Math.min(Number(limit), 200))
        .lean(),
      Conversation.countDocuments(filtro),
    ]);

    // Uma consulta so para todos os contatos da pagina, em vez de N consultas.
    const contatos = await Contact.find({
      $or: conversations.map((c) => ({ channelId: c.sessionId, jid: c.chatId })),
    }).lean();

    const porChave = new Map(contatos.map((c) => [`${c.channelId}:${c.jid}`, c]));

    let lista = conversations.map((c) =>
      resumo(c, porChave.get(`${c.sessionId}:${c.chatId}`))
    );

    // Busca por nome so e possivel depois de juntar com o contato.
    if (q && !/^\d+$/.test(String(q).replace(/\D/g, ''))) {
      const termo = String(q).toLowerCase();
      lista = lista.filter(
        (l) => l.nome?.toLowerCase().includes(termo) || l.numeroBruto?.includes(termo)
      );
    }

    return { conversations: lista, total, skip: Number(skip), limit: Number(limit) };
  });

  /** Uma conversa com as mensagens. */
  fastify.get('/api/conversations/:channelId/:chatId', async (request, reply) => {
    const channelId = request.params.channelId;
    const chatId = decodeURIComponent(request.params.chatId);
    const limit = Math.min(Number(request.query?.limit) || 200, 500);

    const [conversation, contact, mensagens] = await Promise.all([
      Conversation.findOne({ sessionId: channelId, chatId }).lean(),
      Contact.findOne({ channelId, jid: chatId }).lean(),
      Message.find({ channelId, jid: chatId }).sort({ createdAt: 1 }).limit(limit).lean(),
    ]);

    if (!conversation && !contact) {
      return reply.code(404).send({ error: 'Conversa nao encontrada' });
    }

    return {
      conversa: conversation ? resumo(conversation, contact) : null,
      ontologia: contact?.ontology || null,
      resumoRolante: contact?.rollingSummary || null,
      buffer: buffer.inspect(channelId, chatId),
      mensagens: mensagens.map(paraTela),
    };
  });

  /**
   * Apaga a conversa por completo: mensagens, contato, auditoria e estado.
   *
   * E irreversivel de proposito - o pedido e "excluir conversa", nao arquivar.
   * A ontologia acumulada vai junto: manter o perfil sem as mensagens deixaria
   * o agente falando de coisas que ninguem mais consegue conferir.
   */
  fastify.delete('/api/conversations/:channelId/:chatId', async (request, reply) => {
    const channelId = request.params.channelId;
    const chatId = decodeURIComponent(request.params.chatId);

    const existe = await Conversation.exists({ sessionId: channelId, chatId });
    const temContato = await Contact.exists({ channelId, jid: chatId });
    if (!existe && !temContato) {
      return reply.code(404).send({ error: 'Conversa nao encontrada' });
    }

    // Tira do buffer antes de apagar: um flush em andamento recriaria tudo.
    buffer.drop(channelId, chatId);

    // Os arquivos saem junto: excluir a conversa e deixar o audio do cliente
    // guardado seria excluir pela metade.
    const comArquivo = await Message.find(
      { channelId, jid: chatId, mediaFileId: { $ne: null } },
      { mediaFileId: 1 }
    ).lean();
    await mediaStore.remover(comArquivo.map((m) => m.mediaFileId));

    const [mensagens] = await Promise.all([
      Message.deleteMany({ channelId, jid: chatId }),
      Contact.deleteMany({ channelId, jid: chatId }),
      Conversation.deleteMany({ sessionId: channelId, chatId }),
      AgentRun.deleteMany({ channelId, jid: chatId }),
      GuardrailEvent.deleteMany({ channelId, jid: chatId }),
    ]);

    logger.warn(
      { channelId, chatId, mensagens: mensagens.deletedCount, por: request.user?.email },
      'Conversa excluida do painel'
    );

    return { excluida: true, mensagens: mensagens.deletedCount };
  });

  /**
   * Grava, pausa e avisa: o que acontece depois de qualquer envio pelo painel,
   * seja texto ou arquivo. Os dois caminhos tem de deixar o historico, a ficha
   * do cliente e as outras telas abertas exatamente no mesmo estado.
   */
  async function registrarEnvioDoPainel({ channelId, chatId, request, pauseAgent, doc, textoDaFicha }) {
    // `upsert`: quem escreve primeiro pelo painel, antes de o contato
    // responder, tambem precisa de ficha de contato — senao a mensagem nasce
    // com seq 0 e o historico embaralha.
    const contact = await Contact.findOneAndUpdate(
      { channelId, jid: chatId },
      { $inc: { messageCount: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const mensagem = await Message.create({
      channelId,
      jid: chatId,
      direction: 'out',
      role: 'assistant',
      sentBy: 'human',
      operatorEmail: request.user?.email,
      seq: contact?.messageCount || 0,
      ...doc,
    });

    if (pauseAgent) {
      await conversationService.pause(channelId, chatId, 'atendimento_humano');
    }
    await conversationService.patch(channelId, chatId, { lastAgentMessageAt: new Date() });

    logger.info(
      { channelId, chatId, por: request.user?.email, pausouAgente: pauseAgent, tipo: doc.type },
      'Mensagem enviada pelo painel'
    );

    // A ficha do cliente registra o que o agente responde; o que o ATENDENTE
    // responde tem de entrar pela mesma porta, senao a timeline mostra so
    // metade da conversa a partir do momento em que alguem assume.
    // `jidToNumber` devolve null para chat por LID: o identificador opaco nao e
    // telefone, e abrir ficha com ele criaria um cliente fantasma.
    const telefoneDoContato = jidToNumber(chatId) || lidResolver.resolver(chatId);
    if (telefoneDoContato) {
      clienteService
        .registrarInteracao({
          telefone: telefoneDoContato,
          channelId,
          chatId,
          direcao: 'out',
          texto: textoDaFicha,
        })
        .catch((error) =>
          logger.warn({ err: error.message, channelId }, 'Falha ao atualizar a ficha do cliente')
        );
    }

    const payload = paraTela(mensagem.toObject());

    // Outros atendentes com o painel aberto veem a mensagem na hora.
    realtime.conversationMessage({ channelId, chatId, mensagem: payload });
    if (pauseAgent) {
      realtime.conversationUpdate({ channelId, chatId, status: 'PAUSED', pausedReason: 'atendimento_humano' });
    }

    return { mensagem, payload };
  }

  /**
   * O atendente escreve direto pelo painel.
   *
   * Por padrao PAUSA o agente nessa conversa: pessoa e agente respondendo ao
   * mesmo tempo confunde o contato e ainda pode gerar respostas contraditorias.
   * Passe `pauseAgent: false` para escrever sem assumir o atendimento.
   */
  fastify.post('/api/conversations/:channelId/:chatId/send', async (request, reply) => {
    const channelId = request.params.channelId;
    const chatId = decodeURIComponent(request.params.chatId);
    const texto = String(request.body?.text ?? '').trim();
    const pauseAgent = request.body?.pauseAgent !== false;

    if (!texto) return reply.code(400).send({ error: 'Escreva a mensagem' });
    if (texto.length > 4000) return reply.code(400).send({ error: 'Mensagem muito longa' });

    const canal = manager.publicState(channelId);
    if (canal.status !== 'connected') {
      return reply.code(409).send({ error: `O numero ${canal.label} nao esta conectado` });
    }

    try {
      await manager.sendText(channelId, chatId, texto);
    } catch (error) {
      logger.error({ channelId, chatId, err: error.message }, 'Falha ao enviar pelo painel');
      return reply.code(502).send({ error: 'Nao foi possivel enviar pelo WhatsApp' });
    }

    const { payload } = await registrarEnvioDoPainel({
      channelId,
      chatId,
      request,
      pauseAgent,
      doc: { type: 'text', text: texto },
      textoDaFicha: texto,
    });

    return { enviada: true, agentePausado: pauseAgent, mensagem: payload };
  });

  /**
   * O atendente envia um arquivo: foto, video, documento ou audio.
   *
   * O corpo e o arquivo cru (`application/octet-stream`). Na query:
   *   mimetype   tipo real do arquivo
   *   nome       nome do arquivo, que o contato ve no documento
   *   legenda    texto que acompanha foto, video ou documento
   *   voz=1      audio gravado no painel: vira nota de voz
   *   segundos   duracao medida na gravacao
   *   pauseAgent=0  enviar sem assumir o atendimento
   *
   * O arquivo enviado fica guardado como o recebido: o painel mostra os dois
   * lados da conversa, e baixar de novo nao depende de ninguem ter o celular.
   */
  fastify.post(
    '/api/conversations/:channelId/:chatId/media',
    { bodyLimit: env.media.fileMaxBytes + 1024 },
    async (request, reply) => {
      const channelId = request.params.channelId;
      const chatId = decodeURIComponent(request.params.chatId);
      const query = request.query || {};
      const pauseAgent = query.pauseAgent !== '0' && query.pauseAgent !== 'false';
      const voz = query.voz === '1' || query.voz === 'true';
      const legenda = String(query.legenda ?? '').trim().slice(0, 1024) || null;

      const arquivo = Buffer.isBuffer(request.body) ? request.body : null;
      if (!arquivo?.length) return reply.code(400).send({ error: 'Arquivo vazio' });

      const canal = manager.publicState(channelId);
      if (canal.status !== 'connected') {
        return reply.code(409).send({ error: `O numero ${canal.label} nao esta conectado` });
      }

      let buffer = arquivo;
      let mimetype = mimetypeSeguro(query.mimetype);
      let segundos = Number(query.segundos) > 0 ? Math.round(Number(query.segundos)) : null;
      let tipo = tipoDoEnvio(mimetype);
      let notaDeVoz = false;

      if (voz) {
        const convertido = await audioConverter.paraNotaDeVoz({ buffer, mimetype });
        if (convertido.ok) {
          buffer = convertido.buffer;
          mimetype = convertido.mimetype;
          segundos = convertido.seconds || segundos;
          tipo = 'audio';
          notaDeVoz = true;
        }
        // Sem conversao, o audio segue pelo formato original: como arquivo de
        // audio se o celular toca, como documento se nao.
      }

      const extensao = (mimetype.split('/')[1] || 'bin').split(/[;+]/)[0].trim();
      const nome = notaDeVoz
        ? `audio-${Date.now()}.ogg`
        : nomeSeguro(query.nome, `arquivo.${extensao}`);

      // Audio nao tem legenda no WhatsApp: o texto, se houver, vai a parte.
      const conteudo =
        tipo === 'image'
          ? { image: buffer, mimetype, ...(legenda ? { caption: legenda } : {}) }
          : tipo === 'video'
            ? { video: buffer, mimetype, ...(legenda ? { caption: legenda } : {}) }
            : tipo === 'audio'
              ? { audio: buffer, mimetype, ptt: notaDeVoz, ...(segundos ? { seconds: segundos } : {}) }
              : { document: buffer, mimetype, fileName: nome, ...(legenda ? { caption: legenda } : {}) };

      try {
        await manager.sendMedia(channelId, chatId, conteudo);
      } catch (error) {
        logger.error({ channelId, chatId, tipo, err: error.message }, 'Falha ao enviar arquivo pelo painel');
        return reply.code(502).send({ error: 'Nao foi possivel enviar o arquivo pelo WhatsApp' });
      }

      if (tipo === 'audio' && legenda) {
        await manager.sendText(channelId, chatId, legenda).catch((error) =>
          logger.warn({ channelId, chatId, err: error.message }, 'Audio enviado, texto que o acompanhava nao')
        );
      }

      const guardado = await mediaStore.salvar({
        buffer,
        mimetype,
        nome,
        channelId,
        chatId,
        origem: 'painel',
      });

      // O texto e o que o agente le quando volta a atender. Sem legenda, um
      // marcador diz que o escritorio mandou algo — melhor que um turno vazio.
      const texto = legenda || MARCADOR_ENVIO[tipo];

      const { mensagem, payload } = await registrarEnvioDoPainel({
        channelId,
        chatId,
        request,
        pauseAgent,
        doc: {
          type: tipo,
          text: texto,
          caption: legenda,
          mediaMimeType: mimetype,
          mediaBytes: buffer.length,
          mediaFileId: guardado?.fileId || null,
          mediaFileName: nome,
          mediaSeconds: segundos,
        },
        textoDaFicha: texto,
      });

      // O audio do advogado entra no historico tambem como texto: e o que o
      // agente e o resumo conseguem ler. Corre depois da resposta — o envio
      // ja aconteceu e ninguem precisa esperar o Whisper para ver a bolha.
      const agente = manager.agentFor(channelId);
      const transcrever =
        tipo === 'audio' && agente && curadoria.publicada(agente.id).audio?.habilitado !== false;

      if (transcrever) {
        multimodal
          .transcribeAudio({ buffer, mimetype, channelId, chatId })
          .then(async (resultado) => {
            if (!resultado.ok) return;
            const atualizada = await Message.findByIdAndUpdate(
              mensagem._id,
              {
                $set: {
                  transcription: resultado.text,
                  text: `[audio transcrito] ${resultado.text}`,
                },
              },
              { new: true }
            ).lean();
            if (atualizada) {
              // `atualizacao`: a bolha ja existe; a lista nao conta de novo.
              realtime.conversationMessage({
                channelId,
                chatId,
                mensagem: paraTela(atualizada),
                atualizacao: true,
              });
            }
          })
          .catch((error) =>
            logger.warn({ channelId, chatId, err: error.message }, 'Falha ao transcrever audio enviado')
          );
      }

      return { enviada: true, agentePausado: pauseAgent, mensagem: payload };
    }
  );

  /** Devolve a conversa ao agente depois da intervencao humana. */
  fastify.post('/api/conversations/:channelId/:chatId/resume', async (request, reply) => {
    const channelId = request.params.channelId;
    const chatId = decodeURIComponent(request.params.chatId);

    const conversation = await conversationService.resume(channelId, chatId);
    if (!conversation) return reply.code(404).send({ error: 'Conversa nao encontrada' });
    return conversation;
  });

  /** Liga/desliga o agente numa conversa especifica, sem afetar o canal. */
  fastify.post('/api/conversations/:channelId/:chatId/pause', async (request, reply) => {
    const channelId = request.params.channelId;
    const chatId = decodeURIComponent(request.params.chatId);

    const conversation = await conversationService.pause(
      channelId,
      chatId,
      request.body?.reason || 'pausada_no_painel'
    );
    if (!conversation) return reply.code(404).send({ error: 'Conversa nao encontrada' });
    return conversation;
  });

  /**
   * Informa o telefone real de um chat enderecado por LID.
   *
   * O WhatsApp revela o numero quando quer: `senderPn` nao vem em toda
   * mensagem, o evento de compartilhamento depende do contato e a agenda so
   * ajuda se a pessoa estiver nela. Quando nenhuma fonte entrega, quem esta no
   * painel consegue ver o numero no proprio aplicativo — e digitar aqui e
   * melhor do que a equipe conviver com um identificador que nao diz nada.
   *
   * O vinculo vale para o LID, nao para esta conversa: o mesmo contato falando
   * com outro numero do escritorio ja aparece identificado.
   */
  fastify.post('/api/conversations/:channelId/:chatId/numero', async (request, reply) => {
    const channelId = request.params.channelId;
    const chatId = decodeURIComponent(request.params.chatId);

    const conversation = await conversationService.get(channelId, chatId);
    if (!conversation) return reply.code(404).send({ error: 'Conversa nao encontrada' });

    const telefone = digitsOnly(request.body?.telefone);
    if (!telefone || telefone.length < 10) {
      return reply.code(400).send({
        error: 'Informe o numero com DDD, como aparece no WhatsApp. Ex.: (19) 99638-3884',
      });
    }

    // Sem DDI, assume Brasil: quem digita olhando o aplicativo copia
    // "(19) 99638-3884", nao "+55 19...".
    const completo = comDdiBrasil(telefone);
    const lid = conversation.lid || jidToIdentifier(chatId);

    lidResolver.aprender({ lid, phoneNumber: completo, origem: 'manual' });

    // Todas as conversas deste LID, em qualquer canal.
    await Conversation.updateMany({ chatId }, { $set: { phoneNumber: completo } });

    // A ficha operacional passa a existir (ou a encontrar) esta pessoa.
    await clienteService
      .garantirDoWhatsApp({
        telefone: completo,
        nome: conversation.pushName,
        channelId,
        chatId,
      })
      .catch((error) =>
        logger.warn({ err: error.message, chatId }, 'Falha ao vincular a ficha do cliente')
      );

    logger.info(
      { ev: EV.LID_DEFINIDO_A_MAO, lid, channelId, por: request.user?.email },
      'Telefone de um chat por LID informado no painel'
    );

    const atualizada = await conversationService.get(channelId, chatId);
    const contact = await Contact.findOne({ channelId, jid: chatId }).lean();
    return { conversa: resumo(atualizada, contact) };
  });
}

module.exports = conversationsRoutes;
