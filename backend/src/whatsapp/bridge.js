const manager = require('./baileys.manager');
const normalizer = require('./message.normalizer');
const buffer = require('../conversation/buffer.service');
const conversationService = require('../conversation/conversation.service');
const antiloop = require('../guardrails/antiloop.service');
const businessHours = require('../conversation/business-hours');
const agentService = require('../agent/agent.service');
const { getChannel } = require('../config/channels');
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
 */

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

  manager.onMessage = async (payload) => {
    const { channelId, jid, msg, pushName, waMessageId, verifiedBizName, phoneNumber } = payload;
    const channel = getChannel(channelId);
    if (!channel) return;

    // --- agente responsavel, resolvido pelo numero conectado ---
    const agent = manager.agentFor(channelId);
    if (!agent) return;

    // Ativo/standby vem da curadoria: e uma decisao operacional, e a equipe
    // precisa poder tomar sem deploy. O agents.config segue como cadastro base.
    if (!curadoria.estaAtivo(agent.id)) {
      logger.info(
        {
          ev: EV.AGENT_STANDBY_SKIPPED,
          channelId,
          chatId: jid,
          agentId: agent.id,
          status: curadoria.statusEfetivo(agent.id),
        },
        'Agente em standby; mensagem registrada mas nao respondida'
      );
      return;
    }

    const curada = curadoria.publicada(agent.id);

    // --- interruptor manual do canal ---
    const channelDoc = await Channel.findOne({ channelId }).lean();
    if (channelDoc && channelDoc.agentEnabled === false) {
      logger.info({ channelId, chatId: jid }, 'Agente desligado neste canal; ignorando');
      return;
    }

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

    if (conversationService.isPaused(conversation)) {
      logger.info(
        { ev: EV.AGENT_PAUSED, channelId, chatId: jid, reason: conversation.pausedReason },
        'Conversa pausada; nao processando'
      );
      await markProcessed(channelId, [waMessageId], 'ignored', conversation.pausedReason);
      return;
    }

    // --- horario de atendimento ---
    // A mensagem NAO se perde: ela e recebida, registrada e o contato recebe
    // um aviso. O que nao acontece e o agente conduzir atendimento de madrugada.
    const expediente = businessHours.estaNoExpediente();
    if (!expediente.dentro) {
      const horas = env.expediente.avisoACadaHoras;
      const ultimo = conversation.lastAwayNoticeAt?.getTime?.() || 0;
      const jaAvisou = Date.now() - ultimo < horas * 60 * 60 * 1000;

      logger.info(
        {
          ev: EV.FORA_DO_EXPEDIENTE,
          channelId,
          chatId: jid,
          hora: expediente.hora,
          motivo: expediente.motivo,
          avisoEnviado: !jaAvisou,
        },
        'Mensagem recebida fora do expediente'
      );

      if (!jaAvisou) {
        await manager
          .sendText(channelId, jid, businessHours.mensagemAusencia(expediente, curada.mensagens?.fora_do_horario))
          .catch((error) => logger.warn({ err: error.message }, 'Falha ao avisar ausencia'));
        await conversationService.patch(channelId, jid, { lastAwayNoticeAt: new Date() });
      }

      await markProcessed(channelId, [waMessageId], 'ignored', `fora_expediente:${expediente.motivo}`);
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

    // O painel precisa da mensagem inteira para pintar a bolha na hora.
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
    //
    // Sem telefone nao ha ficha. Um chat por LID cujo numero ainda nao
    // apareceu criaria um cliente sem identidade, que duplicaria assim que o
    // telefone surgisse — melhor esperar a proxima mensagem.
    if (phoneNumber) {
      clienteService
        .registrarInteracao({
          telefone: phoneNumber,
          nome: pushName,
          channelId,
          chatId: jid,
          direcao: 'in',
          texto: part.content || part.transcription || part.caption || null,
        })
        .catch((error) =>
          logger.warn({ err: error.message, channelId }, 'Falha ao atualizar a ficha do cliente')
        );
    }
  };

  // ------------------------------------------------ saida: lote consolidado

  buffer.onFlush = async ({ channelId, chatId, parts, meta }) => {
    const channel = getChannel(channelId);
    const agent = manager.agentFor(channelId);
    if (!channel || !agent || !curadoria.estaAtivo(agent.id)) return;

    const waIds = parts.map((p) => p.waMessageId);

    const conversation = await conversationService.patch(channelId, chatId, {
      status: Conversation.STATUS.PROCESSING,
      bufferStatus: 'flushing',
      processing: true,
      processingSince: new Date(),
    });

    if (conversationService.isPaused(conversation)) {
      await conversationService.patch(channelId, chatId, {
        processing: false,
        bufferStatus: 'idle',
      });
      return;
    }

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
      await conversationService.patch(channelId, chatId, {
        status: Conversation.STATUS.WAITING_USER,
        bufferStatus: 'idle',
        bufferSize: 0,
        processing: false,
        processingSince: null,
      });
    }
  };
}

module.exports = { registerBridge, claimMessage };
