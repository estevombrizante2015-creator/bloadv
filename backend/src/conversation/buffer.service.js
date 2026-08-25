const { EventEmitter } = require('events');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

/**
 * BUFFER / DEBOUNCE POR CONVERSA
 * ------------------------------
 * Gente manda "Oi" / "vi o anuncio" / [audio] / [foto] em 6 segundos e espera
 * UMA resposta. Aqui cada conversa tem sua propria janela de silencio: cada
 * mensagem nova reinicia o relogio daquela conversa, e so daquela.
 *
 * Garantias:
 *  - chave por (channelId, chatId): a mensagem do Lead A nunca toca o timer do Lead B
 *  - ordem cronologica preservada; nunca reagrupado por tipo
 *  - teto absoluto (maxWaitMs): quem digita sem parar tambem recebe resposta
 *  - lock por conversa: nunca dois processamentos simultaneos do mesmo contato
 *  - mensagem que chega durante o processamento nao se perde: entra na proxima janela
 *  - timers com unref(): a fila nunca segura o processo de pe
 */
class ConversationBuffer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.windowMs = options.windowMs ?? env.buffer.windowMs;
    this.typingWindowMs = options.typingWindowMs ?? env.buffer.typingWindowMs;
    this.incompleteWindowMs = options.incompleteWindowMs ?? env.buffer.incompleteWindowMs;
    this.maxWaitMs = options.maxWaitMs ?? env.buffer.maxWaitMs;
    this.maxMessages = options.maxMessages ?? env.buffer.maxMessages;

    /** @type {Map<string, object>} estado por conversa */
    this.entries = new Map();

    /** Handler injetado pelo bridge: recebe o lote consolidado. */
    this.onFlush = null;
  }

  static key(channelId, chatId) {
    return `${channelId}:${chatId}`;
  }

  janelasPadrao() {
    return {
      windowMs: this.windowMs,
      typingWindowMs: this.typingWindowMs,
      incompleteWindowMs: this.incompleteWindowMs,
    };
  }

  /**
   * Traduz o "tempo de espera" da curadoria nas tres janelas do debounce.
   *
   * O curador pensa em UM numero: quanto esperar para agrupar mensagens
   * consecutivas. Aqui esse numero vira o TETO da espera normal - a janela
   * usada enquanto o contato aparece digitando, que e quando ha mesmo mais
   * mensagem vindo.
   *
   * As outras duas so encurtam. Frase terminada continua sendo respondida
   * rapido, porque esperar 8s alguem que ja disse tudo e latencia pura. Com o
   * padrao de 8 segundos, o comportamento e identico ao de hoje; baixar para 2
   * torna tudo imediato, e subir para 20 so alonga a espera de quem esta
   * visivelmente escrevendo.
   */
  janelasPara(segundos) {
    const teto = Math.max(1, Number(segundos) || 0) * 1000;
    if (!teto) return this.janelasPadrao();

    return {
      windowMs: Math.min(this.windowMs, teto),
      incompleteWindowMs: Math.min(this.incompleteWindowMs, teto),
      typingWindowMs: teto,
    };
  }

  entry(channelId, chatId) {
    const key = ConversationBuffer.key(channelId, chatId);
    if (!this.entries.has(key)) {
      this.entries.set(key, {
        key,
        channelId,
        chatId,
        parts: [],
        pending: [], // chegou durante o processamento
        timer: null,
        maxTimer: null,
        firstAt: null,
        currentWindowMs: this.windowMs,
        processing: false,
        // Janelas desta conversa. Comecam nas do processo e podem ser
        // estreitadas pelo agente que atende (curadoria), sem afetar as outras.
        janelas: this.janelasPadrao(),
      });
    }
    return this.entries.get(key);
  }

  /** Estado observavel, usado pelo painel e pelos testes. */
  inspect(channelId, chatId) {
    const entry = this.entries.get(ConversationBuffer.key(channelId, chatId));
    if (!entry) return { open: false, size: 0, processing: false, pending: 0 };
    return {
      open: entry.parts.length > 0,
      size: entry.parts.length,
      processing: entry.processing,
      pending: entry.pending.length,
      firstAt: entry.firstAt,
    };
  }

  get size() {
    return this.entries.size;
  }

  clearTimers(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);
    entry.timer = null;
    entry.maxTimer = null;
  }

  /**
   * Quanto esperar depois desta mensagem.
   *
   * Frase terminada em ponto, interrogacao ou exclamacao costuma ser o fim do
   * raciocinio: responde rapido. Frase cortada no meio, ou mensagem muito
   * curta ("oi", "entao"), quase sempre tem continuacao - vale esperar mais.
   */
  windowFor(part, janelas = this.janelasPadrao()) {
    const texto = (part?.content || part?.caption || '').trim();
    if (!texto) return janelas.windowMs;

    if (/[.!?…]$/.test(texto)) return janelas.windowMs;
    if (texto.length <= 12) return janelas.incompleteWindowMs;
    // A borda de palavra importa: sem ela "cidade" casaria com "de", e toda
    // frase terminada nessas letras viraria falso positivo de incompleta.
    if (/[,;:]$|\b(e|ou|mas|que|de|para|com|entao|ai|ja|nao)$/i.test(texto)) {
      return janelas.incompleteWindowMs;
    }
    return janelas.windowMs;
  }

  /** (Re)arma o timer de silencio desta conversa. */
  arm(entry, windowMs) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.currentWindowMs = windowMs;
    entry.timer = setTimeout(
      () => this.flush(entry.channelId, entry.chatId, 'silencio'),
      windowMs
    );
    entry.timer.unref?.();
  }

  /**
   * O contato aparece digitando no WhatsApp: da mais tempo, porque ha mesmo
   * mais mensagem vindo. Sem este sinal, a alternativa seria esperar muito
   * de todo mundo - inclusive de quem ja terminou.
   */
  onTyping(channelId, chatId) {
    const entry = this.entries.get(ConversationBuffer.key(channelId, chatId));
    if (!entry || entry.processing || !entry.parts.length) return false;
    if (entry.currentWindowMs >= entry.janelas.typingWindowMs) return false;

    this.arm(entry, entry.janelas.typingWindowMs);
    logger.debug(
      { ev: EV.BUFFER_UPDATED, channelId, chatId, windowMs: entry.janelas.typingWindowMs },
      'Contato digitando; janela estendida'
    );
    return true;
  }

  /**
   * O contato parou de digitar sem mandar nada novo: nao ha motivo para
   * segurar a janela inteira. Encurta para responder logo.
   */
  onTypingStopped(channelId, chatId) {
    const entry = this.entries.get(ConversationBuffer.key(channelId, chatId));
    if (!entry || entry.processing || !entry.parts.length) return false;

    this.arm(entry, Math.min(entry.janelas.windowMs, entry.currentWindowMs));
    return true;
  }

  /**
   * Adiciona uma parte normalizada e (re)arma a janela de silencio.
   * Se a conversa esta sendo processada, a parte fica em `pending`.
   */
  add({ channelId, chatId, part, meta = {} }) {
    const entry = this.entry(channelId, chatId);
    entry.meta = { ...entry.meta, ...meta };
    if (meta.esperaSegundos) entry.janelas = this.janelasPara(meta.esperaSegundos);

    if (entry.processing) {
      entry.pending.push(part);
      logger.info(
        { ev: EV.BUFFER_REQUEUED, channelId, chatId, pending: entry.pending.length },
        'Mensagem chegou durante o processamento; sera tratada no proximo ciclo'
      );
      return { buffered: true, requeued: true, size: entry.pending.length };
    }

    const first = entry.parts.length === 0;
    entry.parts.push(part);
    if (first) entry.firstAt = Date.now();

    // Debounce adaptativo: cada mensagem nova estende a janela desta conversa.
    this.arm(entry, this.windowFor(part, entry.janelas));

    // Teto absoluto, armado uma unica vez por lote.
    if (!entry.maxTimer) {
      entry.maxTimer = setTimeout(
        () => this.flush(channelId, chatId, 'teto_de_espera'),
        this.maxWaitMs
      );
      entry.maxTimer.unref?.();
    }

    logger.info(
      {
        ev: first ? EV.BUFFER_STARTED : EV.BUFFER_UPDATED,
        channelId,
        chatId,
        size: entry.parts.length,
        type: part.type,
        windowMs: entry.currentWindowMs,
      },
      first ? 'Buffer aberto' : 'Buffer atualizado'
    );

    this.emit('buffer:update', { channelId, chatId, size: entry.parts.length });

    // Lote muito grande: consolida sem esperar o silencio.
    if (entry.parts.length >= this.maxMessages) {
      this.flush(channelId, chatId, 'lote_cheio');
    }

    return { buffered: true, requeued: false, size: entry.parts.length };
  }

  /**
   * Fecha a janela, consolida e entrega o lote ao handler.
   * Reentrante por conversa: uma segunda chamada durante o processamento sai fora.
   */
  async flush(channelId, chatId, trigger = 'manual') {
    const key = ConversationBuffer.key(channelId, chatId);
    const entry = this.entries.get(key);
    if (!entry || entry.processing || entry.parts.length === 0) return null;

    this.clearTimers(entry);

    const parts = entry.parts;
    const meta = entry.meta || {};
    entry.parts = [];
    entry.processing = true; // lock logico por conversa

    const waitedMs = entry.firstAt ? Date.now() - entry.firstAt : 0;
    entry.firstAt = null;

    if (trigger === 'teto_de_espera') {
      logger.warn(
        { ev: EV.BUFFER_MAX_WAIT_FLUSH, channelId, chatId, size: parts.length, waitedMs },
        'Teto de espera atingido; consolidando mesmo sem silencio'
      );
    }

    logger.info(
      {
        ev: EV.BUFFER_PROCESSING,
        channelId,
        chatId,
        size: parts.length,
        types: parts.map((p) => p.type),
        trigger,
        waitedMs,
      },
      'Consolidando lote'
    );

    try {
      if (typeof this.onFlush === 'function') {
        await this.onFlush({ channelId, chatId, parts, meta, trigger, waitedMs });
      }
    } catch (error) {
      logger.error(
        { channelId, chatId, err: error.message, stack: error.stack },
        'Handler do buffer falhou'
      );
    } finally {
      entry.processing = false;

      // Nada se perde: o que chegou durante o processamento abre a proxima janela.
      if (entry.pending.length) {
        const requeued = entry.pending;
        entry.pending = [];
        for (const part of requeued) {
          this.add({ channelId, chatId, part, meta });
        }
      } else if (!entry.parts.length) {
        this.entries.delete(key);
      }
    }

    return { size: parts.length };
  }

  /** Descarta a conversa (opt-out, pausa, desconexao do canal). */
  drop(channelId, chatId) {
    const key = ConversationBuffer.key(channelId, chatId);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.clearTimers(entry);
    this.entries.delete(key);
    return true;
  }

  /** Descarta tudo de um canal (usado no logout/disconnect). */
  dropChannel(channelId) {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.channelId === channelId) {
        this.clearTimers(entry);
        this.entries.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear() {
    for (const entry of this.entries.values()) this.clearTimers(entry);
    this.entries.clear();
  }
}

module.exports = new ConversationBuffer();
module.exports.ConversationBuffer = ConversationBuffer;
