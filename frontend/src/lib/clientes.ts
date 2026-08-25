import { request } from './api';

/**
 * GESTAO DE CLIENTES — contrato com o servidor
 *
 * Os campos ja chegam resolvidos: `statusLabel` em vez de traduzir o id,
 * `proximaAcaoVencida` em vez de comparar datas na tela. Cada componente que
 * recalculasse "vencido" faria com um fuso diferente, e a lista discordaria do
 * painel sobre o mesmo cliente.
 */

export type Prioridade = 'baixa' | 'normal' | 'alta' | 'urgente';

export interface Responsavel {
  id: string;
  nome: string;
  email?: string;
}

export interface Pendencia {
  id: string;
  texto: string;
  resolvida?: boolean;
  criadaEm: string;
  resolvidaEm?: string | null;
}

export interface ClienteResumo {
  id: string;
  nome: string | null;
  telefone: string;
  telefoneFormatado: string | null;
  email: string | null;
  responsavel: Responsavel | null;

  status: string;
  statusLabel: string;
  statusCor: string;
  coluna: string | null;

  etapa: string | null;
  etapaLabel: string | null;

  aguardando: string | null;
  pendencias: Pendencia[];
  totalPendencias: number;

  proximaAcao: string | null;
  proximaAcaoEm: string | null;
  proximaAcaoVencida: boolean;

  ultimoContatoEm: string | null;
  diasSemContato: number | null;

  prioridade: Prioridade;
  tags: string[];

  entradaEm: string;
  atualizadoEm: string;
  origem: 'whatsapp' | 'manual' | 'importacao';
  arquivado: boolean;

  conversas: Array<{ channelId: string; chatId: string }>;

  tarefasAbertas: number;
  tarefasVencidas: number;

  temResumo: boolean;
  resumoEm: string | null;
}

export interface CampoExtra {
  rotulo: string;
  valor: string;
}

export interface ClienteDetalhe extends ClienteResumo {
  observacoesInternas: string;
  /** Colunas da planilha que o produto nao modela. Internas por natureza. */
  camposExtras: CampoExtra[];
  todasPendencias: Pendencia[];
  resumo: {
    interno: string | null;
    cliente: string | null;
    geradoEm: string;
    geradoPor: string | null;
  } | null;
}

export interface Evento {
  id: string;
  tipo: string;
  titulo: string;
  descricao: string | null;
  autor: { tipo: 'usuario' | 'sistema' | 'cliente' | 'agente'; id?: string; nome?: string };
  dados: Record<string, unknown> | null;
  relevante: boolean;
  em: string;
}

export interface Tarefa {
  id: string;
  clienteId: string;
  clienteNome: string | null;
  clienteTelefone: string | null;
  titulo: string;
  descricao: string;
  responsavel: Responsavel | null;
  prazo: string | null;
  prioridade: Prioridade;
  status: 'aberta' | 'concluida' | 'cancelada';
  vencida: boolean;
  venceHoje: boolean;
  concluidaEm: string | null;
  concluidaPor: string | null;
  criadaPor: string | null;
  sugeridaPorIA: boolean;
  criadaEm: string;
}

export interface ItemPipeline {
  id: string;
  label: string;
  cor: string;
  ordem: number;
  conclusivo?: boolean;
}

export interface ColunaPipeline {
  id: string;
  label: string;
  cor: string;
  ordem: number;
  status: string[];
  statusAoSoltar: string | null;
}

export interface Pipeline {
  status: ItemPipeline[];
  etapas: ItemPipeline[];
  colunas: ColunaPipeline[];
  tags: string[];
  prioridades: Prioridade[];
  podeConfigurar: boolean;
}

export interface Indicador {
  id: string;
  label: string;
  valor: number;
  filtro: Record<string, string>;
  tom: 'neutro' | 'atencao' | 'alerta';
}

export interface Painel {
  indicadores: Indicador[];
  porStatus: Array<{ id: string; label: string; cor: string; total: number }>;
  porEtapa: Array<{ id: string; label: string; total: number }>;
  porResponsavel: Array<{ id: string | null; nome: string; total: number }>;
  geradoEm: string;
}

export interface Sugestao {
  campo: string;
  rotulo: string;
  valor: string;
  exibicao: string;
}

export interface Filtros {
  q?: string;
  status?: string;
  etapa?: string;
  prioridade?: string;
  responsavel?: string;
  tag?: string;
  comPendencias?: string;
  acaoVencida?: string;
  paradoHaDias?: string;
  de?: string;
  ate?: string;
  arquivados?: string;
  ordem?: string;
  limite?: string;
  pular?: string;
}

// ------------------------------------------------------------- importacao

export interface DestinoColuna {
  id: string;
  label: string;
  descricao?: string;
}

export interface AnaliseCsv {
  codificacao: string;
  separador: string;
  linhaDoCabecalho: number;
  colunas: string[];
  colunasDescartadas: number;
  total: number;
  amostra: Array<Record<string, string>>;
  mapeamentoSugerido: Record<string, string>;
  destinos: DestinoColuna[];
}

export interface PreviaImportacao {
  codificacao: string;
  resumo: {
    totalNoArquivo: number;
    novos: number;
    jaExistem: number;
    seraoAtualizados: number;
    semNome: number;
    duplicadosNoArquivo: number;
    comAviso: number;
  };
  exemplos: Array<{
    linha: number;
    nome: string;
    telefone: string | null;
    status: string;
    etapa: string | null;
    responsavel: string | null;
    tags: string[];
    pendencias: string[];
    camposExtras: CampoExtra[];
  }>;
  problemas: {
    semNome: Array<{ linha: number; motivo: string }>;
    duplicadosNoArquivo: Array<{ linha: number; nome: string }>;
    avisos: Array<{ linha: number; nome: string; aviso: string }>;
  };
}

export interface ResultadoImportacao {
  criados: number;
  atualizados: number;
  ignorados: number;
  total: number;
  erros: Array<{ linha: number; erro: string }>;
}

const base = '/api/clientes';

const query = (filtros: Filtros = {}) => {
  const params = new URLSearchParams(
    Object.entries(filtros).filter(([, v]) => v !== undefined && v !== '') as [string, string][]
  );
  const texto = params.toString();
  return texto ? `?${texto}` : '';
};

export const clientesApi = {
  pipeline: () => request<Pipeline>(`${base}/pipeline`),
  salvarPipeline: (dados: Partial<Pipeline>) =>
    request<Pipeline>(`${base}/pipeline`, { method: 'PUT', body: JSON.stringify(dados) }),
  restaurarPipeline: () => request<Pipeline>(`${base}/pipeline/restaurar`, { method: 'POST' }),

  listar: (filtros: Filtros = {}) =>
    request<{ clientes: ClienteResumo[]; total: number; limite: number; pular: number }>(
      `${base}${query(filtros)}`
    ),

  kanban: (filtros: Filtros = {}) =>
    request<{
      colunas: Array<{
        id: string;
        label: string;
        cor: string;
        total: number;
        clientes: ClienteResumo[];
      }>;
    }>(`${base}/kanban${query(filtros)}`),

  painel: () => request<Painel>(`${base}/painel`),

  agenda: (dias = 7) =>
    request<{ vencidas: Tarefa[]; hoje: Tarefa[]; proximas: Tarefa[] }>(`${base}/agenda?dias=${dias}`),

  responsaveis: () => request<{ responsaveis: Responsavel[] }>(`${base}/responsaveis`),

  criar: (dados: Partial<ClienteDetalhe>) =>
    request<{ cliente: ClienteDetalhe }>(base, { method: 'POST', body: JSON.stringify(dados) }),

  obter: (id: string) =>
    request<{
      cliente: ClienteDetalhe;
      tarefas: Tarefa[];
      timeline: Evento[];
      resumoDesatualizado: boolean;
      perguntasSugeridas: string[];
    }>(`${base}/${id}`),

  atualizar: (id: string, mudancas: Record<string, unknown>) =>
    request<{ cliente: ClienteDetalhe }>(`${base}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(mudancas),
    }),

  remover: (id: string) => request<{ removido: boolean }>(`${base}/${id}`, { method: 'DELETE' }),

  mover: (id: string, coluna: string) =>
    request<{ cliente: ClienteResumo }>(`${base}/${id}/mover`, {
      method: 'POST',
      body: JSON.stringify({ coluna }),
    }),

  timeline: (id: string, limite = 80) =>
    request<{ eventos: Evento[] }>(`${base}/${id}/timeline?limite=${limite}`),

  observacao: (id: string, texto: string) =>
    request<{ evento: { id: string; em: string } | null }>(`${base}/${id}/observacao`, {
      method: 'POST',
      body: JSON.stringify({ texto }),
    }),

  adicionarPendencia: (id: string, texto: string) =>
    request<{ cliente: ClienteDetalhe }>(`${base}/${id}/pendencias`, {
      method: 'POST',
      body: JSON.stringify({ texto }),
    }),

  resolverPendencia: (id: string, pendenciaId: string) =>
    request<{ cliente: ClienteDetalhe }>(`${base}/${id}/pendencias/${pendenciaId}/resolver`, {
      method: 'POST',
    }),

  criarTarefa: (id: string, dados: Partial<Tarefa>) =>
    request<{ tarefa: Tarefa }>(`${base}/${id}/tarefas`, {
      method: 'POST',
      body: JSON.stringify(dados),
    }),

  atualizarTarefa: (tarefaId: string, mudancas: Partial<Tarefa>) =>
    request<{ tarefa: Tarefa }>(`${base}/tarefas/${tarefaId}`, {
      method: 'PATCH',
      body: JSON.stringify(mudancas),
    }),

  removerTarefa: (tarefaId: string) =>
    request<{ removida: boolean }>(`${base}/tarefas/${tarefaId}`, { method: 'DELETE' }),

  resumo: (id: string, forcar = false) =>
    request<{
      interno: string | null;
      cliente: string | null;
      bloqueado?: string | null;
      geradoEm: string;
      geradoPor: string;
      semMaterial?: boolean;
      reaproveitado?: boolean;
    }>(`${base}/${id}/resumo`, { method: 'POST', body: JSON.stringify({ forcar }) }),

  assistente: (id: string, pergunta: string) =>
    request<{ resposta: string; aviso: string | null; tokens: number }>(`${base}/${id}/assistente`, {
      method: 'POST',
      body: JSON.stringify({ pergunta }),
    }),

  sugestoes: (id: string) =>
    request<{ sugestoes: Sugestao[]; justificativa: string | null; motivo?: string }>(
      `${base}/${id}/sugestoes`,
      { method: 'POST' }
    ),

  analisarCsv: (conteudoBase64: string) =>
    request<AnaliseCsv>(`${base}/importar/analisar`, {
      method: 'POST',
      body: JSON.stringify({ conteudoBase64 }),
    }),

  preverImportacao: (
    conteudoBase64: string,
    mapeamento: Record<string, string>,
    atualizarExistentes: boolean
  ) =>
    request<PreviaImportacao>(`${base}/importar/prever`, {
      method: 'POST',
      body: JSON.stringify({ conteudoBase64, mapeamento, atualizarExistentes }),
    }),

  importar: (
    conteudoBase64: string,
    mapeamento: Record<string, string>,
    atualizarExistentes: boolean
  ) =>
    request<ResultadoImportacao>(`${base}/importar`, {
      method: 'POST',
      body: JSON.stringify({ conteudoBase64, mapeamento, atualizarExistentes }),
    }),

  aplicarSugestoes: (id: string, sugestoes: Sugestao[]) =>
    request<{ cliente: ClienteDetalhe }>(`${base}/${id}/sugestoes/aplicar`, {
      method: 'POST',
      body: JSON.stringify({ sugestoes }),
    }),
};

// ------------------------------------------------------------------ formato

export function dataCurta(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function dataHora(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "ha 3 dias", "hoje". Distancia comunica urgencia melhor que uma data. */
export function haQuantoTempo(iso: string | null | undefined) {
  if (!iso) return 'sem registro';

  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (dias <= 0) return 'hoje';
  if (dias === 1) return 'ontem';
  if (dias < 30) return `ha ${dias} dias`;
  if (dias < 60) return 'ha mais de um mes';
  return `ha ${Math.floor(dias / 30)} meses`;
}

/** Prazo em linguagem de quem esta com a agenda aberta. */
export function prazoRelativo(iso: string | null | undefined) {
  if (!iso) return null;

  const dias = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (dias < -1) return `vencida ha ${Math.abs(dias)} dias`;
  if (dias === -1 || dias === 0) return 'hoje';
  if (dias === 1) return 'amanha';
  if (dias <= 7) return `em ${dias} dias`;
  return dataCurta(iso);
}

/**
 * Cor SOLIDA de cada tom, para pontos e barras.
 *
 * Separada de `CORES` de proposito. O fundo de um selo e translucido (`/10`)
 * porque ele preenche uma area grande atras de texto; um ponto de 8px com esse
 * mesmo fundo simplesmente desaparece no escuro — foi o que aconteceu na
 * primeira versao do seletor, e so uma conferencia visual mostrou.
 *
 * Regra: `CORES` pinta area, `CORES_SOLIDAS` pinta forma.
 */
export const CORES_SOLIDAS: Record<string, string> = {
  azul: 'bg-sky-400',
  dourado: 'bg-gold-400',
  ambar: 'bg-amber-400',
  roxo: 'bg-violet-400',
  vermelho: 'bg-red-400',
  verde: 'bg-emerald-400',
  neutro: 'bg-navy-600',
};

/** Tons do pipeline traduzidos para a paleta do painel. Preenchem AREA. */
export const CORES: Record<string, string> = {
  azul: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
  dourado: 'border-gold-500/30 bg-gold-500/10 text-gold-200',
  ambar: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  roxo: 'border-violet-400/30 bg-violet-400/10 text-violet-200',
  vermelho: 'border-red-500/30 bg-red-500/10 text-red-200',
  verde: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  neutro: 'border-navy-700 bg-navy-800/60 text-parchment/70',
};

export const CORES_PRIORIDADE: Record<Prioridade, string> = {
  baixa: 'text-muted',
  normal: 'text-parchment/70',
  alta: 'text-amber-300',
  urgente: 'text-red-300',
};

/**
 * O id da prioridade e minusculo porque vive no banco; na tela ele vira frase.
 * Um seletor listando "baixa / normal / alta / urgente" em caixa baixa parece
 * um dump de valores, nao uma escolha.
 */
export const PRIORIDADE_LABEL: Record<Prioridade, string> = {
  baixa: 'Baixa',
  normal: 'Normal',
  alta: 'Alta',
  urgente: 'Urgente',
};

/** Tom do pipeline correspondente a cada prioridade, para o ponto do seletor. */
export const PRIORIDADE_COR: Record<Prioridade, string> = {
  baixa: 'neutro',
  normal: 'azul',
  alta: 'ambar',
  urgente: 'vermelho',
};
