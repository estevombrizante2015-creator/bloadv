const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const QRCode = require('qrcode');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');

const { env } = require('../config/env');
const { CHANNELS, getChannel } = require('../config/channels');
const { jidToNumber, formatNumber } = require('../config/agents.config');
const agentResolver = require('../config/agent.resolver');
const lidResolver = require('./lid.resolver');
const authStore = require('./auth.store');
const { Channel } = require('../models');
const logger = require('../utils/logger');
const { EV } = require('../utils/events');

const makeWASocket = baileys.makeWASocket || baileys.default;
const {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
} = baileys;

const waLogger = pino({ level: 'silent' });

/**
 * GERENCIADOR MULTI-SESSAO
 * ------------------------
 * Uma instancia Baileys por canal (leads-1, leads-2, clients-1).
 *
 * As credenciais ficam no BANCO (ver whatsapp/auth.store). Elas moravam em
 * `backend/sessions/`, e em container isso significava perder o pareamento a
 * cada deploy — o escritorio tinha de ler o QR de novo em cada numero. O banco
 * ja e obrigatorio e duravel; guardar la elimina a dependencia de um volume em
 * vez de documenta-la.
 *
 * Eventos emitidos: 'channel:update', 'message:in', 'message:out'.
 */
class BaileysManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} estado em memoria por canal */
    this.sessions = new Map();
    this.onMessage = null; // injetado pelo bootstrap (evita dependencia circular)
  }

  // ---------------------------------------------------------------- estado

  initState(channelId) {
    const channel = getChannel(channelId);
    const state = {
      id: channelId,
      role: channel.role,
      label: channel.label,
      agentTier: channel.agentTier,
      status: 'disconnected',
      qr: null,
      qrExpiresAt: null,
      phoneNumber: null,
      pushName: null,
      // Resolvido automaticamente quando o QR e lido e o numero e conhecido.
      agentId: null,
      agentLabel: null,
      agentStatus: null,
      agentMatchedByNumber: false,
      lastError: null,
      sock: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      closing: false,
      opening: false,
    };
    this.sessions.set(channelId, state);
    return state;
  }

  getState(channelId) {
    return this.sessions.get(channelId) || this.initState(channelId);
  }

  /** Projecao segura para o front (nunca expoe o socket nem credenciais). */
  publicState(channelId) {
    const s = this.getState(channelId);
    return {
      id: s.id,
      role: s.role,
      label: s.label,
      agentTier: s.agentTier,
      status: s.status,
      qr: s.qr,
      qrExpiresAt: s.qrExpiresAt,
      phoneNumber: s.phoneNumber,
      phoneFormatted: formatNumber(s.phoneNumber),
      pushName: s.pushName,
      agentId: s.agentId,
      agentLabel: s.agentLabel,
      agentStatus: s.agentStatus,
      agentMatchedByNumber: s.agentMatchedByNumber,
      agentSource: s.agentSource || null,
      // O objeto completo tambem vai pelo socket: sem ele, o cartao perdia a
      // identificacao do agente a cada `channel:update` e so voltava no F5.
      agent: s.agentId
        ? {
            id: s.agentId,
            label: s.agentLabel,
            status: s.agentStatus,
            matchedByNumber: s.agentMatchedByNumber,
            source: s.agentSource || null,
          }
        : null,
      lastError: s.lastError,
      hasCredentials: this.hasCredentials(channelId),
    };
  }

  listPublicStates() {
    return CHANNELS.map((c) => this.publicState(c.id));
  }

  sessionDir(channelId) {
    return path.join(env.wa.sessionsDir, channelId);
  }

  /**
   * As credenciais vivem no banco (ver whatsapp/auth.store). O conjunto e
   * mantido em memoria porque esta funcao roda dentro de `publicState`, que e
   * sincrona e e chamada a cada atualizacao enviada ao painel.
   */
  hasCredentials(channelId) {
    return authStore.temCredenciais(channelId);
  }

  async patch(channelId, changes) {
    const state = this.getState(channelId);
    Object.assign(state, changes);

    const persistable = {
      status: state.status,
      lastError: state.lastError,
      label: state.label,
      role: state.role,
    };

    /**
     * O numero so e gravado quando existe — ou quando quem chamou pediu
     * explicitamente para limpa-lo (logout, sessao encerrada no aparelho).
     *
     * Guarda, nao correcao: hoje o `autoStart` restaura `state.phoneNumber` do
     * banco antes de qualquer `patch`, entao o caminho conhecido nao apaga
     * nada. Mas `patch` sobre um estado recem-criado gravaria nulo por cima de
     * um numero valido, e o preco disso seria alto — o vinculo numero ->
     * agente sai do mesmo campo, e sem ele o canal volta como "nao atribuido"
     * e para de responder. Escrever so o que se sabe custa uma linha.
     */
    if (state.phoneNumber || 'phoneNumber' in changes) persistable.phoneNumber = state.phoneNumber;
    if (state.pushName || 'pushName' in changes) persistable.pushName = state.pushName;
    if (state.agentId) {
      persistable.agentId = state.agentId;
      persistable.agentLabel = state.agentLabel;
      persistable.agentStatus = state.agentStatus;
      persistable.agentMatchedByNumber = state.agentMatchedByNumber;
      persistable.role = state.role;
    }
    if (changes.status === 'connected') persistable.lastConnectedAt = new Date();
    if (changes.status === 'disconnected' || changes.status === 'logged_out') {
      persistable.lastDisconnectedAt = new Date();
    }

    try {
      await Channel.updateOne(
        { channelId },
        { $set: persistable, $setOnInsert: { channelId } },
        { upsert: true }
      );
    } catch (error) {
      logger.warn({ err: error.message, channelId }, 'Falha ao persistir estado do canal');
    }

    this.emit('channel:update', this.publicState(channelId));
  }

  // ------------------------------------------------------------- conexao

  async connect(channelId) {
    const channel = getChannel(channelId);
    if (!channel) throw new Error(`Canal desconhecido: ${channelId}`);

    const state = this.getState(channelId);

    // Ja conectado: nada a fazer.
    if (state.sock && state.status === 'connected') return this.publicState(channelId);

    // Clique duplo ou duas abas pedindo QR ao mesmo tempo abririam dois
    // sockets sobre o mesmo diretorio de credenciais, e eles se atrapalham.
    if (state.opening) {
      logger.debug({ channelId }, 'Pedido de conexao ignorado: ja existe um em andamento');
      return this.publicState(channelId);
    }
    state.opening = true;

    // Qualquer socket meio-aberto (tipicamente um QR que expirou) precisa
    // morrer ANTES do novo: dois sockets na mesma sessao travam o pareamento.
    await this.teardown(channelId);

    state.closing = false;
    await this.patch(channelId, {
      status: 'connecting',
      lastError: null,
      qr: null,
      qrExpiresAt: null,
    });

    let authState;
    let saveCreds;
    let version;
    try {
      ({ state: authState, saveCreds } = await authStore.useMongoAuthState(channelId));
      ({ version } = await fetchLatestBaileysVersion());
    } catch (error) {
      // Sem liberar a flag, o canal ficaria permanentemente recusando conexao.
      state.opening = false;
      await this.patch(channelId, { status: 'error', lastError: error.message });
      throw error;
    }

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, waLogger),
      },
      logger: waLogger,
      browser: Browsers.ubuntu('whatsAgent'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) => (env.wa.allowGroups ? false : String(jid).endsWith('@g.us')),
    });

    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    // Descoberta do telefone real por tras do LID. Nenhuma fonte e garantida
    // sozinha - o WhatsApp revela o numero quando quer - entao escutamos todas
    // e gravamos o que cada uma entregar.
    //
    // A sincronizacao inicial e a mais rica: ela traz a agenda inteira da conta
    // com os DOIS enderecos de cada contato (`lid` e `jid`). E o que resolve
    // conversas que ja existiam antes deste codigo, sem esperar mensagem nova.
    sock.ev.on('messaging-history.set', ({ contacts }) => {
      const aprendidos = lidResolver.observarContatos(contacts);
      if (aprendidos) {
        logger.info({ channelId, aprendidos }, 'Telefones descobertos na sincronizacao inicial');
      }
    });

    sock.ev.on('chats.phoneNumberShare', (dados) => lidResolver.observarCompartilhamento(dados));
    sock.ev.on('contacts.upsert', (contatos) => lidResolver.observarContatos(contatos));
    sock.ev.on('contacts.update', (contatos) => lidResolver.observarContatos(contatos));
    sock.ev.on('connection.update', (update) => this.onConnectionUpdate(channelId, update));
    sock.ev.on('messages.upsert', (payload) => this.onMessagesUpsert(channelId, payload));

    // "digitando" e o unico sinal confiavel de que vem mais mensagem.
    // Com ele o buffer pode ser curto para todo mundo e so esperar quem
    // esta de fato escrevendo.
    sock.ev.on('presence.update', ({ id, presences }) => {
      const estado = Object.values(presences || {})[0]?.lastKnownPresence;
      if (!estado) return;
      this.emit('presence', { channelId, jid: id, presence: estado });
    });

    state.opening = false;
    return this.publicState(channelId);
  }

  /**
   * Encerra o socket atual sem mexer no status nem apagar credenciais.
   * Usado antes de abrir uma conexao nova e no cancelamento.
   */
  async teardown(channelId) {
    const state = this.getState(channelId);
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;

    if (!state.sock) return;

    try {
      state.sock.ev.removeAllListeners?.('connection.update');
      state.sock.ev.removeAllListeners?.('messages.upsert');
      state.sock.end?.(undefined);
    } catch (error) {
      logger.debug({ channelId, err: error.message }, 'Socket ja estava encerrado');
    }

    state.sock = null;
  }

  async onConnectionUpdate(channelId, update) {
    const { connection, lastDisconnect, qr } = update;
    const state = this.getState(channelId);

    // QR emitido depois do cancelamento faria o codigo reaparecer na tela,
    // dando a impressao de que o botao de cancelar nao funcionou.
    if (qr && state.closing) {
      logger.debug({ channelId }, 'QR descartado: canal em processo de encerramento');
      return;
    }

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        await this.patch(channelId, {
          status: 'qr',
          qr: dataUrl,
          qrExpiresAt: Date.now() + 60_000,
        });
        logger.info({ channelId }, 'QR code gerado');
      } catch (error) {
        logger.error({ err: error.message, channelId }, 'Falha ao renderizar QR');
      }
    }

    if (connection === 'open') {
      const me = state.sock?.user;
      state.reconnectAttempts = 0;

      const phoneNumber = me?.id ? jidToNumber(jidNormalizedUser(me.id)) : null;
      const binding = this.bindAgent(channelId, phoneNumber);

      await this.patch(channelId, {
        status: 'connected',
        qr: null,
        qrExpiresAt: null,
        lastError: null,
        phoneNumber,
        pushName: me?.name || null,
        ...binding,
      });

      logger.info(
        {
          ev: EV.AGENT_BOUND,
          channelId,
          phone: formatNumber(phoneNumber),
          agentId: binding.agentId,
          agentStatus: binding.agentStatus,
          matchedByNumber: binding.agentMatchedByNumber,
        },
        binding.agentMatchedByNumber
          ? 'Canal conectado; agente identificado pelo numero'
          : 'Canal conectado; numero nao cadastrado, usando agente padrao'
      );
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.status;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      state.sock = null;

      if (state.closing) {
        await this.patch(channelId, { status: 'disconnected', qr: null });
        return;
      }

      if (loggedOut) {
        await this.clearCredentials(channelId);
        await this.patch(channelId, {
          status: 'logged_out',
          qr: null,
          phoneNumber: null,
          lastError: 'Sessao encerrada no celular. Leia o QR novamente.',
        });
        logger.warn({ channelId }, 'Canal deslogado no aparelho');
        return;
      }

      state.reconnectAttempts += 1;
      if (state.reconnectAttempts > 8) {
        await this.patch(channelId, {
          status: 'error',
          lastError: 'Falhou ao reconectar apos varias tentativas.',
        });
        return;
      }

      // backoff exponencial com teto de 30s
      const delay = Math.min(30_000, 2_000 * 2 ** (state.reconnectAttempts - 1));
      await this.patch(channelId, {
        status: 'connecting',
        lastError: lastDisconnect?.error?.message || null,
      });
      logger.info({ channelId, delay, attempt: state.reconnectAttempts }, 'Reconectando');

      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => {
        if (state.closing || state.opening) return;
        this.connect(channelId).catch((error) =>
          logger.error({ err: error.message, channelId }, 'Falha na reconexao')
        );
      }, delay);
    }
  }

  /**
   * Descobre qual agente atende o numero pareado.
   * Nao ha selecao manual: o vinculo sai da configuracao central
   * (agents.config.js) e e persistido, sobrevivendo a restart e reconexao.
   */
  bindAgent(channelId, phoneNumber) {
    const { agent, matched, source } = agentResolver.resolve(phoneNumber);

    // O `label` NAO entra aqui de proposito: ele e nome dado pelo escritorio e
    // vive no banco. Devolve-lo a partir da config estatica desfazia o rename
    // toda vez que o vinculo do agente era reavaliado.
    return {
      agentId: agent.id,
      agentLabel: agent.label,
      agentStatus: agent.status,
      agentMatchedByNumber: matched,
      agentSource: source,
      role: agent.role,
      agentTier: agent.tier,
    };
  }

  /** Reavalia o vinculo sem derrubar a conexao. Usado apos atribuir o numero. */
  async rebindAgent(channelId) {
    const state = this.getState(channelId);
    if (!state.phoneNumber) return this.publicState(channelId);
    await this.patch(channelId, this.bindAgent(channelId, state.phoneNumber));
    return this.publicState(channelId);
  }

  /** Agente atual do canal, ja resolvido. Usado pelo bridge a cada mensagem. */
  agentFor(channelId) {
    return agentResolver.resolve(this.getState(channelId).phoneNumber).agent;
  }

  /** Socket vivo do canal - necessario para baixar midia. */
  socketFor(channelId) {
    return this.getState(channelId).sock || null;
  }

  // ------------------------------------------------------------ mensagens

  static extractText(message) {
    if (!message) return null;
    return (
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      message.documentMessage?.caption ||
      message.buttonsResponseMessage?.selectedDisplayText ||
      message.listResponseMessage?.title ||
      message.templateButtonReplyMessage?.selectedDisplayText ||
      null
    );
  }

  static messageType(message) {
    if (!message) return 'unknown';
    if (message.conversation || message.extendedTextMessage) return 'text';
    if (message.imageMessage) return 'image';
    if (message.audioMessage) return 'audio';
    if (message.videoMessage) return 'video';
    if (message.documentMessage) return 'document';
    if (message.stickerMessage) return 'sticker';
    if (message.locationMessage) return 'location';
    if (message.contactMessage) return 'contact';
    return 'unknown';
  }

  /**
   * Entrega mensagens recebidas ao pipeline.
   *
   * Aqui ficam apenas os descartes que dependem do protocolo do WhatsApp.
   * Normalizacao, buffer, anti-loop e agente vivem fora do manager, para que
   * o Baileys nao conheca nada de OpenAI nem de regras de negocio.
   */
  async onMessagesUpsert(channelId, { messages, type }) {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;

        // Camada 1 do anti-loop: o que sai daqui nunca pode voltar como entrada.
        if (msg.key.fromMe) {
          logger.debug(
            { ev: EV.FROM_ME_IGNORED, channelId, chatId: jid, waMessageId: msg.key.id },
            'Mensagem propria ignorada'
          );
          continue;
        }

        if (jid === 'status@broadcast') continue;
        if (jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue;
        if (!env.wa.allowGroups && jid.endsWith('@g.us')) continue;
        if (!msg.message) continue;

        logger.info(
          {
            ev: EV.WHATSAPP_MESSAGE_RECEIVED,
            channelId,
            chatId: jid,
            waMessageId: msg.key.id,
            isBusiness: Boolean(msg.verifiedBizName),
          },
          'Mensagem recebida'
        );

        // Marca como lida com a chave real da mensagem.
        this.getState(channelId).sock?.readMessages?.([msg.key]).catch(() => {});
        // Sem assinar, o WhatsApp nao envia os eventos de "digitando".
        this.getState(channelId).sock?.presenceSubscribe?.(jid).catch(() => {});

        // O telefone real vem no proprio stanza (`key.senderPn`) quando o chat
        // e enderecado por LID. Sem ler isto aqui, o painel so tem o
        // identificador opaco - e era isso que aparecia como se fosse numero.
        const { phoneNumber, lid } = lidResolver.observarMensagem(msg);

        const payload = {
          channelId,
          jid,
          msg,
          phoneNumber,
          lid,
          pushName: msg.pushName,
          waMessageId: msg.key.id,
          // Nome verificado de conta Business. E so um dado - NAO bloqueia nada:
          // muita empresa legitima usa Business e perder esses leads seria pior.
          verifiedBizName: msg.verifiedBizName || null,
          timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
        };

        this.emit('message:in', payload);

        if (typeof this.onMessage === 'function') {
          await this.onMessage(payload);
        }
      } catch (error) {
        logger.error(
          { channelId, err: error.message, stack: error.stack },
          'Erro ao processar mensagem recebida'
        );
      }
    }
  }

  /** Envia texto com presenca humanizada (lido -> digitando -> envia). */
  async sendText(channelId, jid, text, { elapsedMs = 0 } = {}) {
    const state = this.getState(channelId);
    if (!state.sock || state.status !== 'connected') {
      throw new Error(`Canal ${channelId} nao esta conectado`);
    }

    try {
      await state.sock.presenceSubscribe(jid);
      await state.sock.sendPresenceUpdate('composing', jid);

      // A pausa e so para nao parecer robo instantaneo, e desconta o tempo que
      // o modelo ja levou: somar os dois cheios era latencia pura.
      const { minTypingMs, maxTypingMs } = env.wa;
      const desejado = Math.min(maxTypingMs, minTypingMs + text.length * 4);
      const restante = Math.max(0, desejado - (elapsedMs || 0));
      if (restante > 0) await new Promise((resolve) => setTimeout(resolve, restante));

      await state.sock.sendPresenceUpdate('paused', jid);
    } catch (error) {
      logger.debug({ err: error.message }, 'Presenca falhou; enviando mesmo assim');
    }

    const sent = await state.sock.sendMessage(jid, { text });
    this.emit('message:out', { channelId, jid, text, waMessageId: sent?.key?.id });
    return sent;
  }

  // ------------------------------------------------------------ ciclo de vida

  /**
   * Cancela o pareamento em andamento ou desconecta um canal ativo.
   * Nao apaga credenciais: reconectar depois nao exige novo QR.
   */
  async disconnect(channelId) {
    const state = this.getState(channelId);
    state.closing = true;
    state.opening = false;

    await this.teardown(channelId);
    state.reconnectAttempts = 0;

    await this.patch(channelId, {
      status: 'disconnected',
      qr: null,
      qrExpiresAt: null,
      lastError: null,
    });
    return this.publicState(channelId);
  }

  /** Logout de verdade: derruba a sessao no aparelho e apaga as credenciais. */
  async logout(channelId) {
    const state = this.getState(channelId);
    state.closing = true;
    state.opening = false;

    try {
      await state.sock?.logout();
    } catch (error) {
      logger.debug({ err: error.message, channelId }, 'Logout remoto falhou');
    }

    await this.teardown(channelId);
    await this.clearCredentials(channelId);
    await this.patch(channelId, {
      status: 'disconnected',
      qr: null,
      phoneNumber: null,
      pushName: null,
      lastError: null,
    });
    return this.publicState(channelId);
  }

  async clearCredentials(channelId) {
    try {
      await authStore.apagar(channelId);
    } catch (error) {
      logger.warn({ err: error.message, channelId }, 'Falha ao apagar credenciais');
    }

    // A pasta antiga pode ter sobrado de antes da mudanca para o banco. Deixa-la
    // para tras faria a migracao ressuscitar a sessao que acabou de ser
    // encerrada, no proximo boot.
    await fs.promises
      .rm(this.sessionDir(channelId), { recursive: true, force: true })
      .catch(() => {});
  }

  /**
   * Sobe automaticamente os canais que ja tem credenciais salvas.
   * O vinculo numero -> agente e restaurado do banco ANTES de reconectar,
   * para que uma mensagem que chegue nos primeiros milissegundos ja saiba
   * qual agente atende aquele numero.
   */
  async autoStart() {
    const persisted = await Channel.find().lean().catch(() => []);
    const byId = Object.fromEntries(persisted.map((d) => [d.channelId, d]));

    for (const channel of CHANNELS) {
      const state = this.initState(channel.id);
      const doc = byId[channel.id];

      if (doc?.label) state.label = doc.label; // nome dado no painel

      if (doc?.phoneNumber) {
        Object.assign(state, {
          phoneNumber: doc.phoneNumber,
          pushName: doc.pushName || null,
          ...this.bindAgent(channel.id, doc.phoneNumber),
        });
        logger.info(
          {
            ev: EV.AGENT_BOUND,
            channelId: channel.id,
            phone: formatNumber(doc.phoneNumber),
            agentId: state.agentId,
            restored: true,
          },
          'Vinculo numero -> agente restaurado do banco'
        );
      }

      if (this.hasCredentials(channel.id)) {
        logger.info({ channelId: channel.id }, 'Credenciais encontradas, reconectando');
        this.connect(channel.id).catch((error) =>
          logger.error({ err: error.message, channelId: channel.id }, 'Auto-start falhou')
        );
      } else {
        /**
         * O canal ja esteve pareado (o banco guarda o numero) mas nao ha
         * credencial nenhuma. Isso NAO deveria acontecer com as credenciais no
         * banco — se acontecer, alguem apagou a colecao, trocou de banco ou
         * restaurou um dump antigo.
         *
         * O aviso existe porque o sintoma sozinho ("preciso ler o QR de novo")
         * nao diz nada sobre a causa, e foi assim que o problema passou
         * despercebido enquanto as credenciais viviam em disco efemero.
         */
        if (doc?.phoneNumber) {
          logger.error(
            {
              ev: EV.WA_CREDENCIAIS_PERDIDAS,
              channelId: channel.id,
              phone: formatNumber(doc.phoneNumber),
              pareadoEm: doc.lastConnectedAt,
            },
            'Canal ja pareado esta sem credenciais: sera preciso ler o QR de novo. ' +
              'Verifique se o banco e o mesmo de antes e se a colecao wasessions existe.'
          );
        }

        await this.patch(channel.id, { status: 'disconnected' });
      }
    }
  }

  async shutdown() {
    for (const [channelId, state] of this.sessions) {
      state.closing = true;
      clearTimeout(state.reconnectTimer);
      try {
        state.sock?.end?.(undefined);
      } catch {
        logger.debug({ channelId }, 'Socket ja encerrado no shutdown');
      }
    }
  }
}

module.exports = new BaileysManager();
module.exports.BaileysManager = BaileysManager;
