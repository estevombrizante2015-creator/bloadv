require('dotenv').config();

const path = require('path');

const bool = (v, def = false) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (v, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};
const list = (v, def = []) =>
  (v ? String(v).split(',') : def).map((s) => s.trim()).filter(Boolean);

/**
 * Normaliza origens de CORS.
 *
 * O navegador manda o header `Origin` sem barra final e com host em
 * minusculas, sempre. Mas quem preenche a variavel no painel do Railway cola a
 * URL da barra do navegador - que vem com barra - ou entre aspas. Comparar
 * cru reprova a origem certa, e o painel morre num "Failed to fetch" que nao
 * diz nada sobre a causa.
 */
const origins = (v, def = []) =>
  list(v, def).map((o) => {
    const semAspas = o.replace(/^['"]|['"]$/g, '').trim();
    if (semAspas === '*') return semAspas;
    const semBarra = semAspas.replace(/\/+$/, '');
    try {
      const { protocol, host } = new URL(semBarra);
      return `${protocol}//${host}`.toLowerCase();
    } catch {
      return semBarra;
    }
  });

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3001),
  // "::" abre IPv4 e IPv6 ao mesmo tempo. Com "0.0.0.0" o servidor fica so em
  // IPv4, e todo cliente que resolve localhost para ::1 leva ECONNREFUSED -
  // foi assim que o Socket.IO parou de conectar e o QR nunca chegava na tela.
  host: process.env.HOST || '::',
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigin: origins(process.env.CORS_ORIGIN, ['http://localhost:3000']),
  // Em desenvolvimento tambem valem localhost/127.0.0.1 em qualquer porta e a
  // rede local - abrir o painel pelo IP da maquina (para ler o QR do celular)
  // nao pode virar "Failed to fetch".
  corsAllowLocalNetwork: bool(process.env.CORS_ALLOW_LOCAL_NETWORK, process.env.NODE_ENV !== 'production'),

  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/whatsagent',

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: int(process.env.OPENAI_TIMEOUT_MS, 45000),
    maxRetries: int(process.env.OPENAI_MAX_RETRIES, 2),
  },

  // Tiers de agente -> ids de modelo OpenAI reais.
  models: {
    mini: process.env.MODEL_MINI || 'gpt-4o-mini',
    sol: process.env.MODEL_SOL || 'gpt-4o-mini',
    luna: process.env.MODEL_LUNA || 'gpt-4o-mini',
    terra: process.env.MODEL_TERRA || 'gpt-4o',
  },

  wa: {
    sessionsDir: path.resolve(
      __dirname,
      '../..',
      process.env.WA_SESSIONS_DIR || './sessions'
    ),
    allowGroups: bool(process.env.WA_ALLOW_GROUPS, false),
    autoStart: bool(process.env.WA_AUTO_START, true),
    // Pausa antes de enviar, so para nao parecer robo instantaneo. Era ate
    // 2,6s de latencia pura somada a resposta; agora e simbolica e ainda
    // desconta o tempo que o modelo ja levou.
    minTypingMs: int(process.env.WA_MIN_TYPING_MS, 250),
    maxTypingMs: int(process.env.WA_MAX_TYPING_MS, 900),
    /**
     * Idade maxima de uma mensagem recuperada na reconexao.
     *
     * Quando a aplicacao cai ou reinicia, o WhatsApp guarda o que chegou e
     * entrega tudo junto assim que o socket volta. Responder tem valor: quem
     * escreveu ha vinte minutos ainda esta esperando. Responder a mensagem de
     * anteontem, depois de uma queda longa, e pior que o silencio — a pessoa ja
     * seguiu a vida e recebe um "pode me contar o que aconteceu?" do nada.
     *
     * Doze horas cobrem qualquer queda real de operacao e param antes disso.
     */
    maxOfflineAgeMs: int(process.env.WA_MAX_OFFLINE_AGE_MS, 12 * 60 * 60 * 1000),
  },

  guard: {
    maxInboundChars: int(process.env.GUARD_MAX_INBOUND_CHARS, 4000),
    maxOutboundChars: int(process.env.GUARD_MAX_OUTBOUND_CHARS, 900),
    rateLimitMsgs: int(process.env.GUARD_RATE_LIMIT_MSGS, 12),
    rateLimitWindowMs: int(process.env.GUARD_RATE_LIMIT_WINDOW_MS, 60000),
    /**
     * NAO EXISTE TETO DE TOKENS, e nao ha variavel para religa-lo.
     *
     * GUARD_DAILY_TOKEN_BUDGET e GUARD_GLOBAL_DAILY_TOKEN_BUDGET foram
     * REMOVIDOS do codigo, nao zerados. Zerar deixava a alavanca no lugar: uma
     * variavel esquecida em qualquer ambiente bastava para o agente parar de
     * responder no meio de uma triagem, sem erro em lugar nenhum. Foi
     * exatamente o que aconteceu em producao — um print de conversa custou 58
     * mil tokens de leitura de imagem, derrubou o limite diario de uma pessoa
     * em um unico turno, e as oito mensagens seguintes dela nao tiveram
     * resposta nenhuma.
     *
     * O gasto se acompanha pelo painel de custo da OpenAI (billing.service),
     * em dinheiro. O que protege comportamento — rajada, loop de bot — e o
     * rate limit por minuto, logo acima, e ele nao mede consumo.
     */
    allowedLinkDomains: list(process.env.GUARD_ALLOWED_LINK_DOMAINS, ['bloadv.com.br', 'wa.me']),
  },

  ontology: {
    recentTurns: int(process.env.ONTOLOGY_RECENT_TURNS, 6),
    summaryEvery: int(process.env.ONTOLOGY_SUMMARY_EVERY, 12),
  },

  media: {
    enabled: bool(process.env.MEDIA_ENABLED, true),
    whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
    audioMaxBytes: int(process.env.AUDIO_MAX_BYTES, 16 * 1024 * 1024),
    audioMaxSeconds: int(process.env.AUDIO_MAX_SECONDS, 300),
    visionModel: process.env.VISION_MODEL || 'gpt-4o-mini',
    // 'high' le a imagem em resolucao cheia: necessario para transcrever
    // holerite, termo de rescisao e print de conversa. 'low' reduz a 512px
    // e perde o texto. 'auto' deixa a OpenAI decidir.
    visionDetail: ['low', 'high', 'auto'].includes(process.env.VISION_DETAIL)
      ? process.env.VISION_DETAIL
      : 'high',
    visionMaxTokens: int(process.env.VISION_MAX_TOKENS, 700),
    imageMaxBytes: int(process.env.IMAGE_MAX_BYTES, 8 * 1024 * 1024),
    // Video, documento e figurinha recebidos, e qualquer arquivo enviado pelo
    // painel. 16 MB e o teto de midia do proprio WhatsApp.
    fileMaxBytes: int(process.env.MEDIA_FILE_MAX_BYTES, 16 * 1024 * 1024),
  },

  buffer: {
    // Janela curta por padrao: quem manda UMA mensagem e para nao pode esperar
    // o tempo de quem escreve em varias partes.
    windowMs: int(process.env.BUFFER_WINDOW_MS, 2000),
    // Enquanto o contato aparece digitando, a janela vira esta - so ai vale
    // a pena esperar, porque ha mesmo mais mensagem vindo.
    typingWindowMs: int(process.env.BUFFER_TYPING_WINDOW_MS, 6000),
    // Frase cortada no meio sugere continuacao; espera um pouco mais.
    incompleteWindowMs: int(process.env.BUFFER_INCOMPLETE_WINDOW_MS, 3500),
    maxWaitMs: int(process.env.BUFFER_MAX_WAIT_MS, 30000),
    maxMessages: int(process.env.BUFFER_MAX_MESSAGES, 20),
  },

  antiloop: {
    maxAutoInteractions: int(process.env.ANTILOOP_MAX_AUTO_INTERACTIONS, 6),
    maxRepeats: int(process.env.ANTILOOP_MAX_REPEATS, 3),
    minHumanGapMs: int(process.env.ANTILOOP_MIN_HUMAN_GAP_MS, 1500),
    fastReplyStreak: int(process.env.ANTILOOP_FAST_REPLY_STREAK, 4),
  },

  expediente: {
    enabled: bool(process.env.EXPEDIENTE_ENABLED, true),
    inicio: process.env.EXPEDIENTE_INICIO || '08:00',
    fim: process.env.EXPEDIENTE_FIM || '18:30',
    dias: list(process.env.EXPEDIENTE_DIAS, ['segunda', 'terca', 'quarta', 'quinta', 'sexta']),
    // Fora do expediente a mensagem de ausencia sai uma vez a cada N horas
    // para o mesmo contato; sem isso viraria spam a cada mensagem.
    avisoACadaHoras: int(process.env.EXPEDIENTE_AVISO_HORAS, 12),
  },

  /**
   * CONSULTA DE CUSTO NA OPENAI
   * ---------------------------
   * Chave SEPARADA da que gera as respostas, e nao por organizacao de codigo:
   * a API de custos (`/v1/organization/costs`) so aceita chave de ADMIN da
   * organizacao, e uma chave de admin no mesmo lugar que a chave de uso
   * ampliaria o estrago de um vazamento sem necessidade.
   *
   * Ausente, o painel diz que a leitura nao esta configurada. Nunca estima
   * custo por conta propria: numero de dinheiro inventado e pior que numero
   * nenhum.
   */
  billing: {
    // `billing_openai` tambem e aceito: e o nome que o escritorio usou no .env.
    key: process.env.BILLING_OPENAI || process.env.billing_openai || '',
    // A OpenAI consolida custo com atraso e limita a frequencia da consulta.
    // Cinco minutos deixam o painel util sem transformar F5 em rate limit.
    cacheMs: int(process.env.BILLING_CACHE_MS, 5 * 60 * 1000),
    timeoutMs: int(process.env.BILLING_TIMEOUT_MS, 8000),
  },

  websearch: {
    // Busca na internet e um EXTRA seletivo: entra no tempo de resposta e,
    // num escritorio, repetir "o que a internet diz" e pior que nao responder.
    enabled: bool(process.env.WEBSEARCH_ENABLED, true),
    model: process.env.WEBSEARCH_MODEL || 'gpt-4o-mini',
    timeoutMs: int(process.env.WEBSEARCH_TIMEOUT_MS, 6000),
  },

  knowledge: {
    backend: (process.env.KNOWLEDGE_BACKEND || 'memory').toLowerCase(),
    embeddingModel: process.env.KNOWLEDGE_EMBEDDING_MODEL || 'text-embedding-3-small',
    vectorIndex: process.env.KNOWLEDGE_VECTOR_INDEX || 'knowledge_vector_index',
    topK: int(process.env.KNOWLEDGE_TOP_K, 2),
    minScore: Number.parseFloat(process.env.KNOWLEDGE_MIN_SCORE || '0.55'),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET,
    // Sessao normal: expira no fim do expediente.
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    // "Manter conectado": vale ate o proximo mes.
    jwtRememberExpiresIn: process.env.JWT_REMEMBER_EXPIRES_IN || '30d',
  },

  labels: {
    'leads-1': process.env.CHANNEL_LEADS_1_LABEL || 'Novos Casos 01',
    'leads-2': process.env.CHANNEL_LEADS_2_LABEL || 'Novos Casos 02',
    'clients-1': process.env.CHANNEL_CLIENTS_1_LABEL || 'Clientes',
  },
};

function assertEnv() {
  const missing = [];
  if (!env.openai.apiKey) missing.push('OPENAI_API_KEY');
  if (!env.mongoUri) missing.push('MONGO_URI');
  // Sem segredo nao ha painel: ele expoe o pareamento das contas de WhatsApp.
  if (!env.auth.jwtSecret) missing.push('JWT_SECRET');
  if (missing.length) {
    throw new Error(
      `Variaveis de ambiente ausentes: ${missing.join(', ')}. Copie backend/.env.example para backend/.env.`
    );
  }
}

module.exports = { env, assertEnv };
