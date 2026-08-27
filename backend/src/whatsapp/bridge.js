const manager = require('./baileys.manager');
const normalizer = require('./message.normalizer');
const buffer = require('../conversation/buffer.service');
const conversationService = require('../conversation/conversation.service');
const antiloop = require('../guardrails/antiloop.service');
const businessHours = require('../conversation/business-hours');
const agentService = require('../agent/agent.service');
const { getChannel } = require('../config/channels');
const { FALLBACK_AGENT_ID, jidToNumber } = require('../config/agents.config');
const lidResolver = require('./lid.resolver');
const { env } = require('../config/env');
const curadoria = require('../curadoria/config.service');
const clienteService = require('../clientes/cliente.service');
const { Channel, Conversation, ProcessedMessage } = require('../models');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');
const realtime = require('../utils/realtime');

/**
 * PONTE WHATSAPP <-> AGENTE
 * -------------------------
 * Orquestra o pipeline sem que nenhuma das pontas conheca a outra:
 * o Baileys nao sabe o que e OpenAI, e o agente nao sabe o que e WhatsApp.
 *
 *   evento -> sessao -> agente -> ativo? -> fromMe -> duplicidade -> anti-loop
 *          -> normalizar (texto/Whisper/visao) -> buffer 8s -> consolidar
 *          -> historico -> agente -> anti-loop de saida -> enviar -> persistir
 *
 * O que sai do numero tem caminho proprio: resposta digitada no aplicativo do
 * celular entra no historico como mensagem do escritorio (`onOwnMessage`), e o
 * eco das mensagens que o proprio sistema enviou e descartado antes disso.
 */

/**
 * Motivo da pausa quando uma pessoa do escritorio assume a conversa. Mesmo
 * valor gravado pelo envio via painel — o painel e o celular tem de aparecer
 * como a mesma coisa na tela e no log.
 */
const MOTIVO_ATENDIMENTO_HUMANO = 'atendimento_humano';

/** Idempotencia: o indice unico garante que o segundo insert falhe. */
async function claimMessage({ channelId, waMessageId, chatId }) {
  if (!waMessageId) return true; // sem id nao da para deduplicar; segue o fluxo
  try {
    await ProcessedMessage.create({ channelId, waMessageId, chatId, status: 'received' });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false; // ja visto
    logger.warn({ err: error.message, channelId }, 'Falha no controle de idempotencia');
    return true; // na duvida, atende - perder lead e pior que responder duas vezes
  }
}

const markProcessed = (channelId, waMessageIds, status, reason) =>
  ProcessedMessage.updateMany(
    { channelId, waMessageId: { $in: waMessageIds.filter(Boolean) } },
    { $set: { status, reason, processedAt: new Date() } }
  ).catch(() => {});

function registerBridge(io) {
  // ------------------------------------------------ eventos para o painel

  manager.on('channel:update', (state) => io?.emit('channel:update', state));

  buffer.on('buffer:update', ({ channelId, chatId, size }) => {
    io?.emit('buffer:update', { channelId, chatId, size });
  });

  // Contato digitando estende a janela; parou de digitar, encurta.
  manager.on('presence', ({ channelId, jid, presence }) => {
    if (presence === 'composing' || presence === 'recording') {
      buffer.onTyping(channelId, jid);
    } else if (presence === 'paused' || presence === 'available') {
      buffer.onTypingStopped(channelId, jid);
    }
  });

  // ------------------------------------------------ entrada de mensagens

  /**
   * Por que o agente NAO vai responder — ou null, se vai.
   *
   * A decisao esta separada do registro de proposito. Quando o agente esta
   * calado (standby, canal desligado, atendente no comando, fora do
   * expediente) o que para e a RESPOSTA automatica; a mensagem do contato
   * continua sendo gravada e pintada no painel. Sem essa separacao, assumir
   * uma conversa cega o atendente: ele escreve, o cliente responde no
   * WhatsApp e a tela nao mostra nada.
   */
  function motivoParaCalar({ agentId, channelDoc, conversation, expediente }) {
    if (!curadoria.estaAtivo(agentId)) return 'agente_em_standby';
    if (channelDoc && channelDoc.agentEnabled === false) return 'agente_desligado_no_canal';
    if (conversationService.isPaused(conversation)) {
      return conversation.status === Conversation.STATUS.BOT_LOOP_DETECTED
        ? 'loop_de_bot'
        : conversation.pausedReason || 'atendimento_humano';
    }
    if (!expediente.dentro) return `fora_expediente:${expediente.motivo}`;
    return null;
  }

  /** O painel precisa da mensagem inteira para pintar a bolha na hora. */
  function emitirEntrada({ channelId, jid, pushName, part, waMessageId }) {
    realtime.conversationMessage({
      channelId,
      chatId: jid,
      pushName,
      mensagem: {
        id: `wa-${waMessageId || part.timestamp}`,
        direcao: 'in',
        tipo: part.type,
        texto: part.content || null,
        transcricao: part.transcription || null,
        descricaoImagem: part.description || null,
        legenda: part.caption || null,
        erroMidia: part.error || null,
        autor: 'contact',
        tokens: 0,
        em: new Date(part.timestamp).toISOString(),
      },
    });
  }

  /** Alimenta a ficha operacional com o que acabou de chegar. */
  function alimentarFicha({ phoneNumber, pushName, channelId, jid, texto }) {
    // Sem telefone nao ha ficha. Um chat por LID cujo numero ainda nao
    // apareceu criaria um cliente sem identidade, que duplicaria assim que o
    // telefone surgisse — melhor esperar a proxima mensagem.
    if (!phoneNumber) return;
    clienteService
      .registrarInteracao({
        telefone: phoneNumber,
        nome: pushName,
        channelId,
        chatId: jid,
        direcao: 'in',
        texto,
      })
      .catch((error) =>
        logger.warn({ err: error.message, channelId }, 'Falha ao atualizar a ficha do cliente')
      );
  }

  /**
   * Grava e mostra a mensagem que chegou, SEM acionar o agente.
   *
   * Grava pelo mesmo `persistParts` do agente: e o que garante que a conversa
   * conduzida a mao fique com o mesmo formato no banco — e portanto no
   * historico, no resumo por IA e no contexto de quando o agente voltar.
   */
  async function registrarSemResponder({ channelId, jid, msg, pushName, phoneNumber, agent, curada, motivo, waMessageId }) {
    // Em loop de bot ninguem esta lendo e a outra ponta e suspeita de ser
    // automatica: registra o que chegou, mas nao paga Whisper nem visao.
    const interpretar = motivo !== 'loop_de_bot';

    const part = await normalizer.normalize({
      msg,
      channelId,
      chatId: jid,
      sock: manager.socketFor(channelId),
      conversationHint: await conversationService.recentHint(channelId, jid),
      midia: {
        audio: interpretar && curada.audio?.habilitado,
        imagem: interpretar && curada.imagem?.habilitado,
      },
    });

    if (!part) return null;

    const contact = await agentService.getOrCreateContact({
      channelId,
      jid,
      role: agent.role,
      pushName,
    });
    await agentService.persistParts({
      channelId,
      jid,
      parts: [part],
      batchId: agentService.newBatchId(),
      startSeq: contact.messageCount + 1,
    });
    contact.messageCount += 1;
    contact.lastMessageAt = new Date();
    await contact.save();

    await conversationService.patch(channelId, jid, { lastUserMessageAt: new Date() });

    emitirEntrada({ channelId, jid, pushName, part, waMessageId });

    // Numero nao cadastrado cai no agente `unassigned`: registrar a conversa
    // ajuda a equipe a ver o que chegou, abrir ficha de cliente nao.
    if (agent.id !== FALLBACK_AGENT_ID) {
      alimentarFicha({
        phoneNumber,
        pushName,
        channelId,
        jid,
        texto: part.content || part.transcription || part.caption || null,
      });
    }

    return part;
  }

  /**
   * Grava um lote que ficou no buffer e nao vai ser respondido.
   *
   * As partes ja estao normalizadas e ja apareceram no painel; o que faltava
   * era o banco. No caminho normal quem persiste e o `handleBatch`, entao tudo
   * o que era descartado antes dele sumia do historico — e sumia justamente
   * quando alguem assumia a conversa no meio de uma rajada, que e quando o
   * historico completo mais importa.
   */
  async function registrarLoteSemResponder({ channelId, chatId, parts, agent }) {
    if (!parts?.length) return;

    const contact = await agentService.getOrCreateContact({
      channelId,
      jid: chatId,
      role: agent.role,
    });

    await agentService.persistParts({
      channelId,
      jid: chatId,
      parts,
      batchId: agentService.newBatchId(),
      startSeq: contact.messageCount + 1,
    });

    contact.messageCount += parts.length;
    contact.lastMessageAt = new Date();
    await contact.save();
  }

  // ------------------------------------------------ saida pelo aparelho

  /**
   * Resposta digitada no aplicativo do celular, nao no painel.
   *
   * O WhatsApp entrega em `messages.upsert` tudo o que sai do numero. O que
   * este sistema mandou e descartado no manager; o que sobra foi uma pessoa do
   * escritorio respondendo pelo aparelho — tipicamente com o agente pausado,
   * que e exatamente quando o painel mais precisa mostrar a conversa inteira.
   *
   * Grava como mensagem de saida escrita por pessoa (`sentBy: 'human'`), do
   * mesmo jeito que o envio pelo painel. Assim o historico, o resumo rolante e
   * o contexto que o agente le ao voltar enxergam os dois lados da conversa.
   */
  async function registrarRespostaManual({ channelId, jid, msg, waMessageId, timestamp }) {
    const agent = manager.agentFor(channelId);
    if (!agent) return;

    // Idempotencia: cobre a reentrega da fila e, depois de um restart, o eco de
    // uma mensagem que o proprio sistema enviou (a lista em memoria se perde,
    // o registro no banco nao).
    if (!(await claimMessage({ channelId, waMessageId, chatId: jid }))) return;

    const curada = curadoria.publicada(agent.id);

    const part = await normalizer.normalize({
      msg,
      channelId,
      chatId: jid,
      sock: manager.socketFor(channelId),
      conversationHint: await conversationService.recentHint(channelId, jid),
      midia: {
        audio: curada.audio?.habilitado,
        imagem: curada.imagem?.habilitado,
      },
    });

    if (!part) {
      await markProcessed(channelId, [waMessageId], 'ignored', 'sem_conteudo');
      return;
    }

    // O escritorio pode ter comecado a conversa pelo celular: sem isto, ela nao
    // existiria na lista do painel ate o contato responder.
    const conversation = await conversationService.ensure({
      channelId,
      chatId: jid,
      agent,
      channelNumber: manager.getState(channelId).phoneNumber,
    });

    const contact = await agentService.getOrCreateContact({ channelId, jid, role: agent.role });

    await agentService.persistParts({
      channelId,
      jid,
      parts: [part],
      batchId: agentService.newBatchId(),
      startSeq: contact.messageCount + 1,
      direction: 'out',
      role: 'assistant',
      sentBy: 'human',
      // Hora em que foi enviada, nao hora em que este processo soube dela: a
      // mensagem recuperada apos uma queda tem de cair no lugar certo da
      // conversa.
      createdAt: new Date(timestamp),
    });

    contact.messageCount += 1;
    await contact.save();

    await conversationService.patch(channelId, jid, { lastAgentMessageAt: new Date(timestamp) });

    /**
     * Quem responde assume o atendimento — pelo celular tambem.
     *
     * Escrever pelo painel ja pausava o agente nesta conversa; pelo aparelho,
     * nao. O advogado respondia do celular e o agente continuava atuando em
     * paralelo, os dois falando com a mesma pessoa ao mesmo tempo — que e
     * justamente o que a pausa do painel existe para evitar.
     *
     * Uma conversa ja pausada nao e tocada: sobrescrever trocaria o motivo
     * (loop de bot, pedido do contato) por "atendimento_humano" e apagaria a
     * razao real do silencio.
     */
    if (!conversationService.isPaused(conversation)) {
      await conversationService.pause(channelId, jid, MOTIVO_ATENDIMENTO_HUMANO);
      realtime.conversationUpdate({
        channelId,
        chatId: jid,
        status: Conversation.STATUS.PAUSED,
        pausedReason: MOTIVO_ATENDIMENTO_HUMANO,
      });
    }

    realtime.conversationMessage({
      channelId,
      chatId: jid,
      mensagem: {
        id: `wa-${waMessageId || timestamp}`,
        direcao: 'out',
        tipo: part.type,
        texto: part.content || null,
        transcricao: part.transcription || null,
        descricaoImagem: part.description || null,
        legenda: part.caption || null,
        erroMidia: part.error || null,
        autor: 'human',
        operador: null,
        tokens: 0,
        em: new Date(timestamp).toISOString(),
      },
    });

    // A ficha do cliente ja recebe o que o agente e o painel respondem; o que
    // sai do celular tem de entrar pela mesma porta, senao a timeline mostra so
    // metade da conversa.
    const telefone = jidToNumber(jid) || lidResolver.resolver(jid);
    if (telefone && agent.id !== FALLBACK_AGENT_ID) {
      clienteService
        .registrarInteracao({
          telefone,
          channelId,
          chatId: jid,
          direcao: 'out',
          texto: part.content || part.transcription || part.caption || null,
        })
        .catch((error) =>
          logger.warn({ err: error.message, channelId }, 'Falha ao atualizar a ficha do cliente')
        );
    }

    await markProcessed(channelId, [waMessageId], 'processed', 'resposta_manual_no_aparelho');
  }

  manager.onOwnMessage = async (payload) => {
    try {
      await registrarRespostaManual(payload);
    } catch (error) {
      logger.error(
        { channelId: payload.channelId, chatId: payload.jid, err: error.message },
        'Falha ao registrar resposta enviada pelo aparelho'
      );
    }
  };

  /**
   * Tudo o que sai por este sistema fica registrado com o id que o WhatsApp
   * devolveu. E o que impede o eco de virar uma segunda bolha quando a lista em
   * memoria do manager nao existe mais — depois de um restart, por exemplo.
   */
  manager.on('message:out', ({ channelId, jid, waMessageId }) => {
    if (!waMessageId) return;
    ProcessedMessage.create({
      channelId,
      waMessageId,
      chatId: jid,
      status: 'processed',
      reason: 'enviada_pelo_sistema',
      processedAt: new Date(),
    }).catch(() => {});
  });

  // ------------------------------------------------ entrada de mensagens (cont.)

  manager.onMessage = async (payload) => {
    const { channelId, jid, msg, pushName, waMessageId, verifiedBizName, phoneNumber } = payload;
    const channel = getChannel(channelId);
    if (!channel) return;

    // --- agente responsavel, resolvido pelo numero conectado ---
    const agent = manager.agentFor(channelId);
    if (!agent) return;

    const curada = curadoria.publicada(agent.id);
    const channelDoc = await Channel.findOne({ channelId }).lean();

    // --- idempotencia ---
    if (!(await claimMessage({ channelId, waMessageId, chatId: jid }))) {
      logger.info(
        { ev: EV.DUPLICATE_MESSAGE_IGNORED, channelId, chatId: jid, waMessageId },
        'Evento duplicado ignorado'
      );
      return;
    }

    // --- estado da conversa ---
    const conversation = await conversationService.ensure({
      channelId,
      chatId: jid,
      agent,
      channelNumber: manager.getState(channelId).phoneNumber,
      verifiedBizName,
      pushName,
      phoneNumber,
    });

    const expediente = businessHours.estaNoExpediente();
    const calado = motivoParaCalar({ agentId: agent.id, channelDoc, conversation, expediente });

    if (calado) {
      // Fora do expediente o contato ainda recebe um aviso — o que nao
      // acontece e o agente conduzir atendimento de madrugada.
      if (calado.startsWith('fora_expediente')) {
        const horas = env.expediente.avisoACadaHoras;
        const ultimo = conversation.lastAwayNoticeAt?.getTime?.() || 0;
        const jaAvisou = Date.now() - ultimo < horas * 60 * 60 * 1000;

        if (!jaAvisou) {
          await manager
            .sendText(
              channelId,
              jid,
              businessHours.mensagemAusencia(expediente, curada.mensagens?.fora_do_horario)
            )
            .catch((error) => logger.warn({ err: error.message }, 'Falha ao avisar ausencia'));
          await conversationService.patch(channelId, jid, { lastAwayNoticeAt: new Date() });
        }
      }

      logger.info(
        {
          ev:
            calado === 'agente_em_standby'
              ? EV.AGENT_STANDBY_SKIPPED
              : calado.startsWith('fora_expediente')
                ? EV.FORA_DO_EXPEDIENTE
                : EV.AGENT_PAUSED,
          channelId,
          chatId: jid,
          agentId: agent.id,
          motivo: calado,
        },
        'Agente calado; mensagem registrada e exibida no painel'
      );

      await registrarSemResponder({
        channelId,
        jid,
        msg,
        pushName,
        phoneNumber,
        agent,
        curada,
        motivo: calado,
        waMessageId,
      });
      await markProcessed(channelId, [waMessageId], 'ignored', calado);
      return;
    }

    // --- normalizacao: texto / Whisper / visao ---
    const hint = await conversationService.recentHint(channelId, jid);
    const part = await normalizer.normalize({
      msg,
      channelId,
      chatId: jid,
      sock: manager.socketFor(channelId),
      conversationHint: hint,
      midia: { audio: curada.audio?.habilitado, imagem: curada.imagem?.habilitado },
    });

    if (!part) {
      await markProcessed(channelId, [waMessageId], 'ignored', 'sem_conteudo');
      return;
    }

    // --- anti-loop na entrada ---
    const verdict = antiloop.evaluateInbound({
      conversation,
      text: part.content || part.transcription || part.caption || '',
    });
    antiloop.logSignals({
      channelId,
      chatId: jid,
      signals: verdict.signals,
      loopCounter: verdict.patch.loopCounter,
      blocked: verdict.block,
      reason: verdict.reason,
    });

    await conversationService.patch(channelId, jid, {
      ...verdict.patch,
      lastUserMessageAt: new Date(),
    });

    if (verdict.block) {
      io?.emit('conversation:paused', { channelId, chatId: jid, reason: verdict.reason });
      await markProcessed(channelId, [waMessageId], 'ignored', verdict.reason);
      buffer.drop(channelId, jid);
      return;
    }

    emitirEntrada({ channelId, jid, pushName, part, waMessageId });

    // --- buffer: espera o contato terminar de falar ---
    buffer.add({
      channelId,
      chatId: jid,
      part,
      meta: {
        pushName,
        agentId: agent.id,
        esperaSegundos: curada.tempoDeEspera?.segundos,
        // O telefone segue junto ate o agente: e por ele que a ficha do
        // cliente e encontrada quando o contato pergunta pelo andamento.
        phoneNumber,
      },
    });

    await conversationService.patch(channelId, jid, {
      status: Conversation.STATUS.WAITING_MESSAGES,
      bufferStatus: 'open',
      bufferSize: buffer.inspect(channelId, jid).size,
    });

    await markProcessed(channelId, [waMessageId], 'buffered');

    // A ficha operacional se alimenta sozinha: quem escreve entra na carteira
    // e a mensagem vira linha da timeline, sem ninguem digitar nada.
    alimentarFicha({
      phoneNumber,
      pushName,
      channelId,
      jid,
      texto: part.content || part.transcription || part.caption || null,
    });
  };

  // ------------------------------------------------ saida: lote consolidado

  buffer.onFlush = async ({ channelId, chatId, parts, meta }) => {
    const channel = getChannel(channelId);
    const agent = manager.agentFor(channelId);
    if (!channel || !agent || !curadoria.estaAtivo(agent.id)) return;

    const waIds = parts.map((p) => p.waMessageId);

    /**
     * A pausa e conferida ANTES de marcar PROCESSING.
     *
     * `patch` devolve o documento ja alterado, entao a checagem que existia
     * aqui olhava para o status que ela mesma acabara de escrever e nunca era
     * verdadeira. Na pratica: o contato mandava a mensagem, o advogado assumia
     * dentro da janela do buffer e o agente respondia assim mesmo, alguns
     * segundos depois — e o `finally` ainda devolvia a conversa para
     * WAITING_USER, apagando a pausa.
     */
    const antes = await conversationService.get(channelId, chatId);

    if (conversationService.isPaused(antes)) {
      // O estado do buffer e limpo primeiro: se a gravacao abaixo falhar, o
      // painel nao pode ficar mostrando "buffer aberto" para sempre.
      await conversationService.patch(channelId, chatId, {
        processing: false,
        bufferStatus: 'idle',
        bufferSize: 0,
      });
      await markProcessed(channelId, waIds, 'ignored', antes.pausedReason || antes.status);

      // O que o contato disse continua valendo. Sem gravar aqui, assumir o
      // atendimento no meio de uma rajada apagaria as mensagens que ainda
      // estavam no buffer: elas nunca chegaram ao banco.
      await registrarLoteSemResponder({ channelId, chatId, parts, agent });
      return;
    }

    await conversationService.patch(channelId, chatId, {
      status: Conversation.STATUS.PROCESSING,
      bufferStatus: 'flushing',
      processing: true,
      processingSince: new Date(),
    });

    try {
      const result = await agentService.handleBatch({
        channel,
        agent,
        jid: chatId,
        parts,
        pushName: meta?.pushName,
        phoneNumber: meta?.phoneNumber,
      });

      if (result.meta?.handoff) {
        io?.emit('handoff', { channelId, chatId, reason: result.meta.handoff });
        await conversationService.pause(channelId, chatId, result.meta.handoff);
      }

      if (!result.reply) {
        await markProcessed(channelId, waIds, 'processed', 'sem_resposta');
        return;
      }

      // --- segunda checagem anti-loop, agora sobre o que vamos enviar ---
      const outbound = antiloop.evaluateOutbound({
        conversation: await conversationService.get(channelId, chatId),
        text: result.reply,
      });

      await conversationService.patch(channelId, chatId, outbound.patch);

      if (outbound.block) {
        logger.warn(
          { ev: EV.BOT_LOOP_DETECTED, channelId, chatId, reason: outbound.reason },
          'Resposta repetida; pausando o agente nesta conversa'
        );
        io?.emit('conversation:paused', { channelId, chatId, reason: outbound.reason });
        await markProcessed(channelId, waIds, 'processed', outbound.reason);
        return;
      }

      await manager.sendText(channelId, chatId, result.reply, {
        elapsedMs: result.meta?.latencyMs,
      });

      logger.info(
        {
          ev: EV.AGENT_RESPONSE_SENT,
          channelId,
          chatId,
          agentId: agent.id,
          tier: result.tier,
          batchId: result.meta?.batchId,
          parts: parts.length,
          tokens: result.meta?.usage?.total,
        },
        'Resposta enviada'
      );

      await conversationService.patch(channelId, chatId, {
        lastAgentMessageAt: new Date(),
        $inc: { interactions: 1 },
      });

      await markProcessed(channelId, waIds, 'processed');

      if (meta?.phoneNumber) {
        clienteService
          .registrarInteracao({
            telefone: meta.phoneNumber,
            channelId,
            chatId,
            direcao: 'out',
            texto: result.reply,
          })
          .catch(() => {});
      }

      realtime.conversationMessage({
        channelId,
        chatId,
        mensagem: {
          id: result.meta?.batchId ? `out-${result.meta.batchId}` : `out-${Date.now()}`,
          direcao: 'out',
          tipo: 'text',
          texto: result.reply,
          autor: 'agent',
          tier: result.tier,
          tokens: result.meta?.usage?.total || 0,
          em: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error(
        { ev: EV.AGENT_EXECUTION_FAILED, channelId, chatId, err: error.message, stack: error.stack },
        'Falha ao processar o lote'
      );
      await markProcessed(channelId, waIds, 'failed', error.message);
    } finally {
      /**
       * Se alguem assumiu o atendimento enquanto o modelo respondia — pelo
       * painel ou pelo celular —, a pausa vale mais que o fim do
       * processamento. Devolver o status para WAITING_USER aqui apagaria a
       * pausa que acabara de ser pedida, e o agente voltaria a responder na
       * mensagem seguinte como se nada tivesse acontecido.
       */
      const agora = await conversationService.get(channelId, chatId);
      const pausada = conversationService.isPaused(agora);

      await conversationService.patch(channelId, chatId, {
        ...(pausada ? {} : { status: Conversation.STATUS.WAITING_USER }),
        bufferStatus: 'idle',
        bufferSize: 0,
        processing: false,
        processingSince: null,
      });
    }
  };
}

module.exports = { registerBridge, claimMessage };
