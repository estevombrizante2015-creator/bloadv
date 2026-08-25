const manager = require('../whatsapp/baileys.manager');
const buffer = require('../conversation/buffer.service');
const conversationService = require('../conversation/conversation.service');
const knowledgeRepository = require('../domain/knowledge.repository');
const { CHANNELS, isValidChannel } = require('../config/channels');
const { listAgents, getAgent, registeredNumbers } = require('../config/agents.config');
const agentResolver = require('../config/agent.resolver');
const { Channel, Contact, Conversation, AgentRun, GuardrailEvent } = require('../models');
const { listTiers } = require('../agent/models.registry');
const inputGuard = require('../guardrails/input.guard');
const { env } = require('../config/env');
const businessHours = require('../conversation/business-hours');
const { CANAL_TESTE } = require('../curadoria/sandbox.service');
const curadoria = require('../curadoria/config.service');
const saude = require('../whatsapp/saude.service');
const billing = require('../agent/billing.service');

/**
 * Ativo/standby vem da curadoria, nao do arquivo de cadastro: o painel pode ter
 * mudado o status sem deploy. Servir o valor do arquivo faria a tela de
 * Conexoes dizer "ativo" sobre um agente que parou de responder.
 */
const comStatusEfetivo = () =>
  listAgents().map((a) => ({ ...a, status: curadoria.statusEfetivo(a.id) }));

async function channelsRoutes(fastify) {
  /** Os 3 canais com estado ao vivo. */
  fastify.get('/api/channels', async () => {
    const docs = await Channel.find().lean();
    const byId = Object.fromEntries(docs.map((d) => [d.channelId, d]));

    return {
      channels: manager.listPublicStates().map((state) => ({
        ...state,
        agentEnabled: byId[state.id]?.agentEnabled !== false,
        agent: state.agentId ? getAgent(state.agentId) && {
          id: state.agentId,
          label: state.agentLabel,
          status: curadoria.statusEfetivo(state.agentId),
          matchedByNumber: state.agentMatchedByNumber,
        } : null,
        stats: byId[state.id]?.stats || { messagesIn: 0, messagesOut: 0, tokensUsed: 0 },
        lastConnectedAt: byId[state.id]?.lastConnectedAt || null,
      })),
    };
  });

  /**
   * Saude dos numeros: o cartao responde "conectou?", isto responde "esta
   * atendendo?". Rota estatica declarada antes de /api/channels/:id — o
   * roteador do Fastify ja da prioridade a ela, mas a ordem aqui deixa a
   * intencao visivel para quem for mexer.
   */
  fastify.get('/api/channels/health', async () => saude.avaliar(manager.listPublicStates()));

  fastify.get('/api/channels/:id', async (request, reply) => {
    if (!isValidChannel(request.params.id)) {
      return reply.code(404).send({ error: 'Canal nao encontrado' });
    }
    return manager.publicState(request.params.id);
  });

  /** Inicia o pareamento: emite QR via socket assim que o Baileys gerar. */
  fastify.post('/api/channels/:id/connect', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });
    try {
      return await manager.connect(id);
    } catch (error) {
      return reply.code(500).send({ error: error.message });
    }
  });

  /** Para o socket mas mantem as credenciais (reconecta sem novo QR). */
  fastify.post('/api/channels/:id/disconnect', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });
    return manager.disconnect(id);
  });

  /** Logout real: derruba no aparelho e apaga credenciais. Exige novo QR. */
  fastify.post('/api/channels/:id/logout', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });
    return manager.logout(id);
  });

  /** Liga/desliga o agente naquele numero sem derrubar a conexao. */
  fastify.post('/api/channels/:id/agent', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });

    const enabled = request.body?.enabled !== false;
    await Channel.updateOne(
      { channelId: id },
      { $set: { agentEnabled: enabled }, $setOnInsert: { channelId: id } },
      { upsert: true }
    );
    return { channelId: id, agentEnabled: enabled };
  });

  /** Tiers disponiveis e para qual modelo OpenAI cada um aponta. */
  fastify.get('/api/agent/tiers', async () => ({ tiers: listTiers() }));

  /**
   * Custo da conta OpenAI. Token e uma grandeza que ninguem transforma em
   * decisao; o que o escritorio precisa saber e quanto ja gastou no mes.
   * `?forcar=1` pula o cache — e o que o botao de atualizar do painel usa.
   */
  fastify.get('/api/agent/billing', async (request) =>
    billing.resumo({ forcar: request.query?.forcar === '1' })
  );

  /** Painel: consumo, economia de tokens e guardrails disparados. */
  fastify.get('/api/agent/usage', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [byTier, guardrails, contacts] = await Promise.all([
      AgentRun.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: '$tier',
            runs: { $sum: 1 },
            tokens: { $sum: '$totalTokens' },
            saved: { $sum: '$contextTokensSaved' },
            avgLatency: { $avg: '$latencyMs' },
          },
        },
        { $sort: { tokens: -1 } },
      ]),
      GuardrailEvent.aggregate([
        // O canal ficticio da curadoria fica de fora: uma conversa de teste
        // que dispara guardrail e o sistema funcionando, nao uma violacao do
        // atendimento. Contar as duas juntas faria a metrica piorar
        // exatamente quando a equipe testa mais antes de publicar.
        { $match: { createdAt: { $gte: since }, channelId: { $ne: CANAL_TESTE } } },
        { $group: { _id: { stage: '$stage', rule: '$rule' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
      Contact.countDocuments({ humanHandoff: true }),
    ]);

    return {
      window: '24h',
      byTier,
      guardrails,
      handoffs: contacts,
      global: inputGuard.getGlobalUsage(),
    };
  });

  /** Contatos de um canal com o snapshot da ontologia. */
  fastify.get('/api/channels/:id/contacts', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });

    const contacts = await Contact.find({ channelId: id })
      .sort({ lastMessageAt: -1 })
      .limit(50)
      .lean();

    return { contacts };
  });

  // --------------------------------------------------------- agentes

  /** Registro de agentes e quais numeros cada um atende (config + painel). */
  fastify.get('/api/agents', async () => ({
    agents: comStatusEfetivo(),
    numbers: registeredNumbers(),
    assignments: await agentResolver.list(),
  }));

  /**
   * Atribui o numero JA PAREADO de um canal a um agente.
   * Sem isto, cada numero novo exigiria editar o codigo e reiniciar - e ate
   * la o canal fica conectado sem responder, sem explicacao visivel.
   */
  fastify.post('/api/channels/:id/assign', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });

    const { agentId } = request.body || {};
    const state = manager.publicState(id);

    if (!state.phoneNumber) {
      return reply.code(409).send({ error: 'Conecte o numero antes de atribui-lo a um agente' });
    }

    try {
      await agentResolver.assign({
        number: state.phoneNumber,
        agentId,
        assignedBy: request.user?.email,
      });
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }

    // Vale na hora, sem reconectar o WhatsApp.
    return manager.rebindAgent(id);
  });

  /** Desfaz a atribuicao feita pelo painel; o numero volta a valer pela config. */
  fastify.delete('/api/channels/:id/assign', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });

    const state = manager.publicState(id);
    if (state.phoneNumber) await agentResolver.unassign(state.phoneNumber);

    return manager.rebindAgent(id);
  });

  /** Renomeia o canal: "Novos Casos 01" vira o nome que o escritorio usa. */
  fastify.patch('/api/channels/:id', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });

    const label = String(request.body?.label ?? '').trim().slice(0, 60);
    if (!label) return reply.code(400).send({ error: 'Informe um nome' });

    await Channel.updateOne(
      { channelId: id },
      { $set: { label }, $setOnInsert: { channelId: id } },
      { upsert: true }
    );

    manager.getState(id).label = label;
    return manager.publicState(id);
  });

  /** Estado das conversas de um canal: buffer aberto, pausas, suspeita de bot. */
  fastify.get('/api/channels/:id/conversations', async (request, reply) => {
    const { id } = request.params;
    if (!isValidChannel(id)) return reply.code(404).send({ error: 'Canal nao encontrado' });

    const conversations = await Conversation.find({ sessionId: id })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

    return {
      conversations: conversations.map((c) => ({
        ...c,
        buffer: buffer.inspect(id, c.chatId),
      })),
    };
  });

  /** Conversas pausadas (loop, handoff) de todos os canais ou de um so. */
  fastify.get('/api/conversations/paused', async (request) => ({
    conversations: await conversationService.listPaused(request.query?.channelId),
  }));

  /** Backend da base de conhecimento (local ou busca semantica no Atlas). */
  fastify.get('/api/knowledge/status', async () => knowledgeRepository.status());

  fastify.get('/api/config', async () => ({
    channels: CHANNELS.map(({ id, role, label, agentTier }) => ({ id, role, label, agentTier })),
    agents: comStatusEfetivo(),
    tiers: listTiers(),
    buffer: {
      windowMs: env.buffer.windowMs,
      typingWindowMs: env.buffer.typingWindowMs,
      incompleteWindowMs: env.buffer.incompleteWindowMs,
      maxWaitMs: env.buffer.maxWaitMs,
      maxMessages: env.buffer.maxMessages,
    },
    antiloop: env.antiloop,
    media: {
      enabled: env.media.enabled,
      whisperModel: env.media.whisperModel,
      visionModel: env.media.visionModel,
    },
    knowledgeBackend: env.knowledge.backend,
    expediente: {
      ...env.expediente,
      descricao: businessHours.descricao(),
      agora: businessHours.estaNoExpediente(),
    },
  }));
}

module.exports = channelsRoutes;
