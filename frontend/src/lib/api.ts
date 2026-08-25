import { authHeader, setToken } from './auth';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type ChannelRole = 'leads' | 'clients';

export type ChannelStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'logged_out'
  | 'error';

export interface BoundAgent {
  id: string;
  label: string;
  status: 'active' | 'standby' | 'disabled';
  matchedByNumber: boolean;
  source?: 'painel' | 'config' | 'fallback' | null;
}

export interface AgentRegistration {
  id: string;
  label: string;
  description: string;
  status: 'active' | 'standby' | 'disabled';
  role: ChannelRole;
  tier: string;
  numbers: string[];
}

export interface ChannelState {
  id: string;
  role: ChannelRole;
  label: string;
  agentTier: string;
  status: ChannelStatus;
  qr: string | null;
  qrExpiresAt: number | null;
  phoneNumber: string | null;
  pushName: string | null;
  phoneFormatted: string | null;
  lastError: string | null;
  hasCredentials: boolean;
  agent?: BoundAgent | null;
  agentId?: string | null;
  agentLabel?: string | null;
  agentStatus?: string | null;
  agentMatchedByNumber?: boolean;
  agentSource?: 'painel' | 'config' | 'fallback' | null;
  agentEnabled?: boolean;
  stats?: { messagesIn: number; messagesOut: number; tokensUsed: number };
  lastConnectedAt?: string | null;
}

export interface AgentTier {
  key: string;
  label: string;
  model: string;
  description: string;
  userFacing: boolean;
}

export interface UsageReport {
  window: string;
  byTier: Array<{
    _id: string;
    runs: number;
    tokens: number;
    saved: number;
    avgLatency: number;
  }>;
  guardrails: Array<{ _id: { stage: string; rule: string }; count: number }>;
  handoffs: number;
  // `limit: null` = sem teto. Nao existe mais teto de tokens no sistema.
  global: { day: string; tokens: number; limit: number | null };
}

/** Sinaliza sessao expirada para o hook de auth redirecionar ao login. */
export class UnauthorizedError extends Error {
  constructor(message = 'Sessao expirada') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    cache: 'no-store',
    ...init,
    headers: {
      // Content-Type SO quando existe corpo. Um POST vazio anunciando
      // application/json faz o Fastify responder 400 FST_ERR_CTP_EMPTY_JSON_BODY -
      // era a origem do "Bad Request" em conectar, cancelar e desparear.
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeader(),
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 401) {
    setToken(null);
    throw new UnauthorizedError();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Erro ${response.status} em ${path}`);
  }

  return response.json() as Promise<T>;
}

export interface PipelineConfig {
  agents: AgentRegistration[];
  buffer: { windowMs: number; maxWaitMs: number; maxMessages: number };
  antiloop: {
    maxAutoInteractions: number;
    maxRepeats: number;
    minHumanGapMs: number;
    fastReplyStreak: number;
  };
  media: { enabled: boolean; whisperModel: string; visionModel: string };
  knowledgeBackend: string;
  expediente?: {
    enabled: boolean;
    inicio: string;
    fim: string;
    dias: string[];
    descricao: string;
    agora: { dentro: boolean; motivo: string; hora: string };
  };
}

export interface PausedConversation {
  _id: string;
  chatId: string;
  sessionId: string;
  phoneNumber?: string;
  status: string;
  pausedReason?: string;
  pausedAt?: string;
  botSignals?: string[];
  loopCounter?: number;
}

/**
 * SAUDE DOS NUMEROS
 * -----------------
 * O cartao de conexao responde "conectou?". Isto responde "esta atendendo?" —
 * que e a pergunta que importa, porque um numero conectado sem agente
 * atribuido fica verde e nao responde ninguem. Ver backend/whatsapp/saude.service.
 */
export type NivelSaude = 'critico' | 'atencao' | 'saudavel' | 'inativo';

export interface SinalSaude {
  nivel: NivelSaude;
  titulo: string;
  detalhe: string;
  comoResolver: string | null;
}

export interface SaudeCanal {
  id: string;
  label: string;
  role: ChannelRole;
  status: ChannelStatus;
  phoneNumber: string | null;
  phoneFormatted: string | null;
  pushName: string | null;
  nivel: NivelSaude;
  nivelLabel: string;
  sinais: SinalSaude[];
  agente: (BoundAgent & { ligado: boolean }) | null;
  conexao: {
    temCredenciais: boolean;
    conectadoDesde: string | null;
    desconectadoEm: string | null;
    tempoConectadoMs: number | null;
    ultimoErro: string | null;
  };
  volume24h: {
    recebidas24h: number;
    enviadas24h: number;
    enviadasPorPessoa24h: number;
    ultimaRecebidaEm: string | null;
    ultimaRespondidaEm: string | null;
    execucoes: number;
    falhas: number;
    tokens: number;
    latenciaMediaMs: number | null;
  };
  /**
   * Risco de PERDER o numero — pergunta diferente de "esta atendendo?".
   * O WhatsApp nao avisa antes de bloquear; isto e estimativa a partir dos
   * padroes que precedem bloqueio. Ver backend/whatsapp/saude.service.
   */
  risco: {
    nivel: 'baixo' | 'medio' | 'alto';
    label: string;
    pontos: number;
    fatores: Array<{ peso: number; texto: string }>;
  };
  conversasPausadas: number;
  respostasBloqueadas24h: number;
  caladasPorLimite24h?: number;
  /** motivo -> quantas mensagens ficaram sem resposta por ele nas ultimas 24h */
  semRespostaPorMotivo24h?: Record<string, number>;
}

export interface RelatorioSaude {
  janela: string;
  verificadoEm: string;
  resumo: Record<NivelSaude, number>;
  canais: SaudeCanal[];
}

/**
 * CUSTO DA CONTA OPENAI
 * ---------------------
 * `ok: false` nunca vem sem `motivo`: dinheiro e o unico numero do painel em
 * que um traco sem explicacao vira desconfianca do sistema inteiro.
 */
export interface SaldoOpenAI {
  disponivel: boolean;
  restante?: number;
  concedido?: number;
  usado?: number;
  motivo?: string;
}

export interface CustoOpenAI {
  ok: boolean;
  motivo?: string;
  aviso?: string;
  doCache?: boolean;
  moeda?: string;
  custoHoje?: number;
  custoMes?: number;
  observacao?: string;
  atualizadoEm?: string;
  saldo?: SaldoOpenAI;
}

export const api = {
  channels: () => request<{ channels: ChannelState[] }>('/api/channels'),
  health: () => request<RelatorioSaude>('/api/channels/health'),
  billing: (forcar = false) =>
    request<CustoOpenAI>(`/api/agent/billing${forcar ? '?forcar=1' : ''}`),
  connect: (id: string) => request<ChannelState>(`/api/channels/${id}/connect`, { method: 'POST' }),
  disconnect: (id: string) =>
    request<ChannelState>(`/api/channels/${id}/disconnect`, { method: 'POST' }),
  logout: (id: string) => request<ChannelState>(`/api/channels/${id}/logout`, { method: 'POST' }),
  toggleAgent: (id: string, enabled: boolean) =>
    request<{ channelId: string; agentEnabled: boolean }>(`/api/channels/${id}/agent`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  tiers: () => request<{ tiers: AgentTier[] }>('/api/agent/tiers'),
  usage: () => request<UsageReport>('/api/agent/usage'),
  config: () => request<PipelineConfig>('/api/config'),
  rename: (id: string, label: string) =>
    request<ChannelState>(`/api/channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    }),
  assignAgent: (id: string, agentId: string) =>
    request<ChannelState>(`/api/channels/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),
  agents: () => request<{ agents: AgentRegistration[] }>('/api/agents'),
  pausedConversations: () =>
    request<{ conversations: PausedConversation[] }>('/api/conversations/paused'),
  resumeConversation: (channelId: string, chatId: string) =>
    request<PausedConversation>(
      `/api/conversations/${channelId}/${encodeURIComponent(chatId)}/resume`,
      { method: 'POST' }
    ),
};

// ---------------------------------------------------------- conversas

export interface ConversationSummary {
  id: string;
  chatId: string;
  channelId: string;
  channelLabel: string;
  nome: string | null;
  numero: string | null;
  numeroBruto: string | null;
  isLid: boolean;
  identificador: string | null;
  agentId: string | null;
  agentType: string | null;
  status: string;
  pausedReason: string | null;
  possibleBot: boolean;
  botSignals: string[];
  interactions: number;
  mensagens: number;
  tokens: number;
  handoff: string | null;
  optedOut: boolean;
  tipoCaso: string | null;
  estagio: string | null;
  lastUserMessageAt: string | null;
  lastAgentMessageAt: string | null;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  direcao: 'in' | 'out';
  tipo: string;
  texto: string | null;
  transcricao: string | null;
  descricaoImagem: string | null;
  legenda: string | null;
  erroMidia: string | null;
  tier: string | null;
  autor?: 'agent' | 'human';
  operador?: string | null;
  tokens: number;
  bloqueadoPor: string | null;
  lote: string | null;
  em: string;
}

export interface ConversationDetail {
  conversa: ConversationSummary | null;
  ontologia: { slots?: Record<string, unknown>; stage?: string; intent?: string } | null;
  resumoRolante: string | null;
  mensagens: ConversationMessage[];
}

export const conversationsApi = {
  list: (params: { channelId?: string; status?: string; q?: string; limit?: number } = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][]
    );
    return request<{ conversations: ConversationSummary[]; total: number }>(
      `/api/conversations?${query}`
    );
  },
  detail: (channelId: string, chatId: string) =>
    request<ConversationDetail>(
      `/api/conversations/${channelId}/${encodeURIComponent(chatId)}`
    ),
  remove: (channelId: string, chatId: string) =>
    request<{ excluida: boolean; mensagens: number }>(
      `/api/conversations/${channelId}/${encodeURIComponent(chatId)}`,
      { method: 'DELETE' }
    ),
  send: (channelId: string, chatId: string, text: string, pauseAgent = true) =>
    request<{
      enviada: boolean;
      agentePausado: boolean;
      mensagem: ConversationMessage;
    }>(`/api/conversations/${channelId}/${encodeURIComponent(chatId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ text, pauseAgent }),
    }),
  resume: (channelId: string, chatId: string) =>
    request<ConversationSummary>(
      `/api/conversations/${channelId}/${encodeURIComponent(chatId)}/resume`,
      { method: 'POST' }
    ),
  pause: (channelId: string, chatId: string) =>
    request<ConversationSummary>(
      `/api/conversations/${channelId}/${encodeURIComponent(chatId)}/pause`,
      { method: 'POST', body: JSON.stringify({ reason: 'pausada_no_painel' }) }
    ),

  /**
   * Informa o telefone de um chat que o WhatsApp enderecou por LID e sobre o
   * qual nunca revelou o numero. Vale para o contato, nao so para esta conversa.
   */
  definirNumero: (channelId: string, chatId: string, telefone: string) =>
    request<{ conversa: ConversationSummary }>(
      `/api/conversations/${channelId}/${encodeURIComponent(chatId)}/numero`,
      { method: 'POST', body: JSON.stringify({ telefone }) }
    ),
};
