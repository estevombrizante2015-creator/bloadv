const crypto = require('crypto');
const { env } = require('../config/env');
const { Contact, Message, AgentRun, Channel } = require('../models');
const openaiService = require('./openai.service');
const { getTier } = require('./models.registry');
const { buildInstructions } = require('./prompt.builder');
const curadoria = require('../curadoria/config.service');
const consultaCliente = require('../clientes/consulta.service');
const router = require('./router');
const ontologyService = require('../ontology/ontology.service');
const knowledgeRepository = require('../domain/knowledge.repository');
const knowledgeService = require('../domain/knowledge.service');
const websearch = require('./websearch.service');
const normalizer = require('../whatsapp/message.normalizer');
const inputGuard = require('../guardrails/input.guard');
const outputGuard = require('../guardrails/output.guard');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * PIPELINE DO AGENTE
 * ------------------
 * Entrada: um LOTE ja consolidado pelo buffer (texto + audio transcrito +
 * imagem descrita, em ordem cronologica). Nunca uma mensagem solta.
 *
 *  1. guardrail de entrada        (sem custo de token)
 *  2. extracao de ontologia       (tier mini, barato)
 *  3. roteamento de tier          (sem custo)
 *  4. contexto compacto + base    <- economia de tokens acontece aqui
 *  5. geracao da resposta         (sol / luna / terra)
 *  6. guardrail de saida          (reescreve ou aplica fallback)
 *  7. persistencia + contabilidade de tokens
 */

const sumUsage = (...usages) =>
  usages.filter(Boolean).reduce(
    (acc, u) => ({
      prompt: acc.prompt + (u.prompt || 0),
      completion: acc.completion + (u.completion || 0),
      total: acc.total + (u.total || 0),
    }),
    { prompt: 0, completion: 0, total: 0 }
  );

const newBatchId = () => crypto.randomBytes(8).toString('hex');

async function getOrCreateContact({ channelId, jid, role, pushName }) {
  return Contact.findOneAndUpdate(
    { channelId, jid },
    {
      $setOnInsert: { channelId, jid, role, ontology: { version: 1, slots: {}, facts: [] } },
      ...(pushName ? { $set: { pushName } } : {}),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function recentMessages(channelId, jid, limit) {
  const docs = await Message.find({ channelId, jid }).sort({ createdAt: -1 }).limit(limit).lean();
  return docs.reverse().map((d) => ({ role: d.role, text: d.text }));
}

async function addTokens(contact, tokens) {
  const day = inputGuard.todayKey();
  const current = contact.tokenUsage?.day === day ? contact.tokenUsage.tokens : 0;
  contact.tokenUsage = { day, tokens: current + tokens };
  inputGuard.addGlobalTokens(tokens);
}

/** Grava cada parte do lote preservando o conteudo original e o derivado. */
async function persistParts({ channelId, jid, parts, batchId, startSeq }) {
  const docs = parts.map((part, i) => ({
    channelId,
    jid,
    waMessageId: part.waMessageId,
    direction: 'in',
    role: 'user',
    type: part.type,
    text: part.content || part.transcription || part.caption || null,
    transcription: part.transcription || null,
    imageDescription: part.description || null,
    caption: part.caption || null,
    mediaMimeType: part.mediaMimeType || null,
    mediaBytes: part.mediaBytes || null,
    mediaError: part.error || null,
    batchId,
    batchSize: parts.length,
    seq: startSeq + i,
  }));

  if (docs.length) await Message.insertMany(docs, { ordered: false }).catch(() => {});
}

/**
 * Processa um lote consolidado e devolve o que deve ser enviado de volta.
 *
 * @param {object} args
 * @param {object} args.channel   canal/sessao (id, label)
 * @param {object} args.agent     agente resolvido pelo numero (id, role, tier)
 * @param {Array}  args.parts     partes normalizadas, em ordem cronologica
 * @returns {{reply: string|null, tier: string|null, meta: object}}
 */
async function handleBatch({ channel, agent, jid, parts, pushName, phoneNumber, batchId = newBatchId() }) {
  const startedAt = Date.now();
  const channelId = channel.id;
  const role = agent.role;

  const consolidated = normalizer.renderBatch(parts);
  const plain = normalizer.plainText(parts);
  const types = normalizer.batchTypes(parts);

  const contact = await getOrCreateContact({ channelId, jid, role, pushName });

  logger.info(
    {
      ev: EV.AGENT_EXECUTION_STARTED,
      channelId,
      chatId: jid,
      agentId: agent.id,
      batchId,
      parts: parts.length,
      types,
    },
    'Executando agente sobre o lote'
  );

  // ---------- 1. guardrail de entrada ----------
  const guard = await inputGuard.check({
    channelId,
    jid,
    text: consolidated,
    type: consolidated ? 'text' : 'unknown',
    contact,
  });

  await persistParts({
    channelId,
    jid,
    parts,
    batchId,
    startSeq: contact.messageCount + 1,
  });
  contact.messageCount += parts.length;
  contact.lastMessageAt = new Date();

  if (!guard.allow) {
    if (guard.optOut) contact.optedOut = true;
    if (guard.handoff) {
      contact.humanHandoff = true;
      contact.handoffReason = guard.handoff;
    }
    await contact.save();

    return {
      reply: guard.silent ? null : guard.reply,
      tier: null,
      meta: { blocked: true, flags: guard.flags, handoff: guard.handoff || null, batchId },
    };
  }

  const safeText = guard.text;
  const history = await recentMessages(channelId, jid, env.ontology.recentTurns + 2);

  // ---------- 2. extracao de ontologia (mini), EM PARALELO ----------
  // Antes esta chamada rodava em serie antes de gerar, somando ~1,5s a cada
  // resposta. O agente ja recebe o texto cru da mensagem nova, entao ele nao
  // depende do delta desta rodada: a ontologia e memoria ENTRE turnos.
  // O delta e aplicado logo apos a geracao, a tempo do proximo turno.
  //
  // ...e so quando ha o que extrair. Uma saudacao pura ("Bom dia!!") custava
  // ~900 tokens de extracao para concluir, com certeza, que nao havia nada a
  // extrair — mais de um terco do custo daquela resposta.
  const extracao = ontologyService.valeExtrair(safeText)
    ? ontologyService
        .extract({
          openaiService,
          role,
          currentOntology: contact.ontology,
          recentMessages: history,
          userText: safeText,
        })
        .catch(() => ({ delta: null, usage: null }))
    : Promise.resolve({ delta: null, usage: null, pulada: true });

  // ---------- 3. roteamento ----------
  // Usa o estado acumulado ate o turno anterior; o texto novo entra em `text`.
  const decision = router.route({
    role,
    baseTier: agent.tier,
    ontology: contact.ontology,
    inputFlags: guard.flags,
    messageCount: contact.messageCount,
    text: safeText,
  });
  const tier = getTier(decision.tier);

  // ---------- 4. contexto compacto ----------
  const { contextBlock, turns, savedTokens, missing } = ontologyService.buildContext({
    ontology: contact.ontology,
    role,
    rollingSummary: contact.rollingSummary,
    recentMessages: history,
    allMessagesCount: contact.messageCount,
  });

  // Base de conhecimento: no maximo 2 verbetes. Local ou busca semantica no
  // Atlas, conforme KNOWLEDGE_BACKEND - o pipeline nao muda.
  const tipoCaso = contact.ontology?.slots?.tipo_caso;

  // Base local e busca na internet vao juntas: a segunda so dispara quando a
  // pergunta depende de dado que muda, e roda em paralelo com a primeira para
  // nao somar latencia.
  const decisaoWeb = websearch.deveBuscar(safeText);

  // Consulta a ficha do cliente APENAS quando ele pergunta sobre o andamento.
  // A deteccao e por padrao de texto e nao custa nada; ir ao banco em toda
  // mensagem para um dado que quase nunca e usado, custaria.
  const perguntouAndamento = consultaCliente.perguntaSobreAndamento(safeText);

  // A base so e consultada quando a mensagem tem sobre o que consultar. Com o
  // backend `memory` isso e apenas prompt poupado; com `mongo`, cada consulta
  // gera um embedding pago — e "Bom dia!!" pagaria por um verbete que nao
  // existe. Mesmo criterio da extracao: na duvida, consulta.
  const valeConsultar = ontologyService.valeExtrair(safeText);

  const [knowledge, web, situacaoDoCliente] = await Promise.all([
    valeConsultar
      ? knowledgeRepository.search({ query: safeText, tipoCaso })
      : Promise.resolve({ topics: [], block: '', backend: 'nao_consultada' }),
    decisaoWeb.buscar
      ? websearch.buscar({ pergunta: safeText, channelId, chatId: jid })
      : Promise.resolve({ ok: false, motivo: decisaoWeb.motivo }),
    perguntouAndamento
      ? consultaCliente.situacaoParaAgente(phoneNumber).catch(() => null)
      : Promise.resolve(null),
  ]);

  // O papel, o tom, as regras e o contexto da empresa vem da CURADORIA: o que
  // a equipe do escritorio edita no painel, sem deploy. Os limites da
  // advocacia continuam vindo do codigo e entram depois - ver prompt.builder.
  //
  // `messageCount` ja foi somado ao lote acima, entao igualdade com
  // parts.length significa que nao existe mais nada nesta conversa: e a
  // abertura de verdade.
  const curada = curadoria.publicada(agent.id);

  const instructions = buildInstructions({
    config: curada,
    primeiroContato: contact.messageCount === parts.length,
    contextBlock,
    missing,
    sugestaoPergunta: missing.length ? knowledgeRepository.suggestedQuestion(tipoCaso) : null,
    knowledge,
    web,
    unidadesBlock: knowledgeService.asksLocation(safeText) ? knowledgeService.locationBlock() : null,
    partsCount: parts.length,
    tipos: types,
    falhaMidia: normalizer.hasFailure(parts),
    injection: guard.injection,
    escalonado: decision.tier === 'terra' && agent.tier !== 'terra',
    situacaoDoCliente,
    textoDoContato: safeText,
  });

  const chatMessages = turns.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text,
  }));

  // ---------- 5. geracao ----------
  let generation;
  try {
    generation = await openaiService.complete({
      tier: decision.tier,
      purpose: 'reply',
      system: instructions.join('\n\n'),
      messages: chatMessages,
      user: safeText,
    });
  } catch (error) {
    logger.error(
      { ev: EV.AGENT_EXECUTION_FAILED, channelId, chatId: jid, batchId, err: error.message },
      'Falha na geracao da resposta'
    );
    contact.humanHandoff = true;
    contact.handoffReason = 'erro_openai';
    await contact.save();

    await AgentRun.create({
      channelId,
      jid,
      tier: decision.tier,
      model: tier.model,
      reason: decision.reason,
      ok: false,
      error: error.message,
      latencyMs: Date.now() - startedAt,
    });

    return {
      reply: curada.mensagens.erro_interno,
      tier: decision.tier,
      meta: { error: true, batchId },
    };
  }

  // ---------- 6. guardrail de saida ----------
  let retryUsage = null;
  const verdict = await outputGuard.check({
    channelId,
    jid,
    text: generation.text,
    regenerate: async (corrective) => {
      const second = await openaiService.complete({
        tier: decision.tier,
        purpose: 'reply_retry',
        system: `${instructions.join('\n\n')}\n\n[CORRECAO]\n${corrective}`,
        messages: chatMessages,
        user: safeText,
      });
      retryUsage = second.usage;
      return second.text;
    },
  });

  if (verdict.handoff) {
    contact.humanHandoff = true;
    contact.handoffReason = verdict.handoff;
  }

  // ---------- 7. persistencia ----------
  // O delta chega aqui: ja nao atrasa a resposta e vale a partir do proximo turno.
  const { delta, usage: extractUsage } = await extracao;
  if (delta) {
    contact.ontology = ontologyService.merge(contact.ontology, delta, role);
    // `ontology.slots` e Schema.Types.Mixed: o Mongoose nao detecta mutacao
    // sozinho, e sem markModified os slots nao sao gravados - toda a economia
    // de tokens para de funcionar em silencio.
    contact.markModified('ontology');
  }

  const visionUsage = parts
    .map((p) => p.visionUsage)
    .filter(Boolean)
    .reduce((acc, u) => sumUsage(acc, u), { prompt: 0, completion: 0, total: 0 });

  const usage = sumUsage(extractUsage, generation.usage, retryUsage, visionUsage, web.usage);
  await addTokens(contact, usage.total);

  contact.messageCount += 1;
  await Message.create({
    channelId,
    jid,
    direction: 'out',
    role: 'assistant',
    type: 'text',
    text: verdict.text,
    tier: decision.tier,
    batchId,
    seq: contact.messageCount,
    tokens: usage,
  });

  // resumo rolante: comprime o historico antigo a cada N mensagens
  if (
    env.ontology.summaryEvery > 0 &&
    contact.messageCount - contact.summaryUpToSeq >= env.ontology.summaryEvery
  ) {
    try {
      const toSummarize = await recentMessages(channelId, jid, env.ontology.summaryEvery + 4);
      const { summary, usage: summaryUsage } = await ontologyService.summarize({
        openaiService,
        previousSummary: contact.rollingSummary,
        messages: toSummarize,
      });
      contact.rollingSummary = summary;
      contact.summaryUpToSeq = contact.messageCount;
      await addTokens(contact, summaryUsage?.total || 0);
    } catch (error) {
      logger.warn({ err: error.message }, 'Falha ao gerar resumo rolante');
    }
  }

  await contact.save();

  await AgentRun.create({
    channelId,
    jid,
    tier: decision.tier,
    model: tier.model,
    reason: decision.reason,
    knowledgeTopics: knowledge.topics,
    webSearch: web.ok ? { fontes: web.fontes, latencyMs: web.latencyMs } : null,
    contextTokensSaved: savedTokens,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    totalTokens: usage.total,
    latencyMs: Date.now() - startedAt,
    ok: true,
    guardrails: { input: guard.flags, output: verdict.violations, retried: verdict.retried },
  });

  await Channel.updateOne(
    { channelId },
    {
      $inc: {
        'stats.messagesIn': parts.length,
        'stats.messagesOut': 1,
        'stats.tokensUsed': usage.total,
      },
    }
  );

  return {
    reply: verdict.text,
    tier: decision.tier,
    meta: {
      batchId,
      agentId: agent.id,
      reason: decision.reason,
      model: tier.model,
      usage,
      savedTokens,
      partsCount: parts.length,
      types,
      knowledgeTopics: knowledge.topics,
      knowledgeBackend: knowledge.backend,
      web: web.ok ? { fontes: web.fontes, latencyMs: web.latencyMs } : { usada: false, motivo: web.motivo },
      consultaDeStatus: situacaoDoCliente
        ? { clienteId: situacaoDoCliente.clienteId, temDados: situacaoDoCliente.temDados }
        : null,
      plainText: plain.slice(0, 200),
      handoff: contact.humanHandoff ? contact.handoffReason : null,
      guardrails: { input: guard.flags, output: verdict.violations },
      latencyMs: Date.now() - startedAt,
    },
  };
}

/** Atalho de uma mensagem so - usado por testes e por integracoes diretas. */
async function handleInbound({ channel, agent, jid, text, pushName, waMessageId }) {
  return handleBatch({
    channel,
    agent,
    jid,
    pushName,
    parts: [{ type: 'text', content: text, waMessageId, timestamp: Date.now() }],
  });
}

module.exports = {
  handleBatch,
  handleInbound,
  getOrCreateContact,
  recentMessages,
  newBatchId,
  // A ponte grava a entrada por conta propria quando o agente nao vai
  // responder. Reaproveitar esta funcao mantem UM formato de mensagem no
  // banco: se o painel entende o que o agente grava, entende o resto.
  persistParts,
};
