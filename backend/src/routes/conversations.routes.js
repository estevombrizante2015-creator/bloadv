const { Conversation, Contact, Message, AgentRun, GuardrailEvent } = require('../models');
const manager = require('../whatsapp/baileys.manager');
const conversationService = require('../conversation/conversation.service');
const buffer = require('../conversation/buffer.service');
const {
  formatNumber,
  digitsOnly,
  jidToIdentifier,
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

async function conversationsRoutes(fastify) {
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
      mensagens: mensagens.map((m) => ({
        id: m._id.toString(),
        direcao: m.direction,
        tipo: m.type,
        texto: m.text,
        transcricao: m.transcription || null,
        descricaoImagem: m.imageDescription || null,
        legenda: m.caption || null,
        erroMidia: m.mediaError || null,
        tier: m.tier || null,
        autor: m.sentBy || 'agent',
        operador: m.operatorEmail || null,
        tokens: m.tokens?.total || 0,
        bloqueadoPor: m.blockedBy || null,
        lote: m.batchId || null,
        em: m.createdAt,
      })),
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

    const contact = await Contact.findOneAndUpdate(
      { channelId, jid: chatId },
      { $inc: { messageCount: 1 } },
      { new: true }
    );

    const mensagem = await Message.create({
      channelId,
      jid: chatId,
      direction: 'out',
      role: 'assistant',
      type: 'text',
      text: texto,
      sentBy: 'human',
      operatorEmail: request.user?.email,
      seq: contact?.messageCount || 0,
    });

    if (pauseAgent) {
      await conversationService.pause(channelId, chatId, 'atendimento_humano');
    }
    await conversationService.patch(channelId, chatId, { lastAgentMessageAt: new Date() });

    logger.info(
      { channelId, chatId, por: request.user?.email, pausouAgente: pauseAgent },
      'Mensagem enviada pelo painel'
    );

    const payload = {
      id: mensagem._id.toString(),
      direcao: 'out',
      tipo: 'text',
      texto: texto,
      autor: 'human',
      operador: request.user?.email || null,
      tokens: 0,
      em: mensagem.createdAt,
    };

    // Outros atendentes com o painel aberto veem a mensagem na hora.
    realtime.conversationMessage({ channelId, chatId, mensagem: payload });
    if (pauseAgent) {
      realtime.conversationUpdate({ channelId, chatId, status: 'PAUSED', pausedReason: 'atendimento_humano' });
    }

    return {
      enviada: true,
      agentePausado: pauseAgent,
      mensagem: {
        id: mensagem._id.toString(),
        direcao: 'out',
        tipo: 'text',
        texto,
        autor: 'human',
        operador: request.user?.email || null,
        tokens: 0,
        em: mensagem.createdAt,
      },
    };
  });

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
