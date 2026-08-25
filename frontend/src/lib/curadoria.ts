import { request } from './api';

/**
 * CURADORIA — contrato com o servidor
 *
 * Os nomes sao os mesmos do backend, em portugues, de proposito: quando um
 * campo da tela nao bate com o campo do prompt, a equipe passa a curar uma
 * coisa achando que esta curando outra. Um vocabulario so, ponta a ponta.
 */

export interface Regra {
  id: string;
  texto: string;
  ativa: boolean;
}

export interface PerguntaFrequente {
  pergunta: string;
  resposta: string;
}

export interface Empresa {
  descricao: string;
  servicos: string;
  produtos: string;
  diferenciais: string;
  politicas: string;
  horarios: string;
  informacoesComerciais: string;
  instrucoesOperacionais: string;
  restricoes: string;
  faq: PerguntaFrequente[];
}

export type ChaveMensagem =
  | 'primeira_abordagem'
  | 'sem_entendimento'
  | 'erro_interno'
  | 'transferencia_humano'
  | 'encerramento'
  | 'lead_qualificado'
  | 'fora_do_horario'
  | 'midia_nao_compreendida';

export interface ConfiguracaoAgente {
  promptPrincipal: string;
  tomDeVoz: { preset: string; descricao: string };
  regras: Regra[];
  mensagens: Record<ChaveMensagem, string>;
  audio: { habilitado: boolean; instrucoes: string; responderSempreEmTexto: boolean };
  imagem: { habilitado: boolean; instrucoes: string };
  web: { habilitado: boolean; instrucoes: string };
  tempoDeEspera: { segundos: number };
  empresa: Empresa;
}

export interface Alteracao {
  campo: string;
  rotulo: string;
  tipo: 'adicionado' | 'removido' | 'alterado';
  antes: string;
  depois: string;
}

export interface Problema {
  nivel: 'erro' | 'aviso';
  campo: string;
  titulo: string;
  mensagem: string;
  comoCorrigir: string;
}

export interface Validacao {
  ok: boolean;
  erros: Problema[];
  avisos: Problema[];
}

export interface Permissoes {
  papel: 'admin' | 'curador' | 'visualizador';
  ver: boolean;
  editar: boolean;
  testar: boolean;
  publicar: boolean;
  restaurar: boolean;
  alterarStatus: boolean;
  gerenciarUsuarios: boolean;
}

export interface Opcoes {
  tons: Array<{ id: string; label: string; descricao: string }>;
  mensagens: Array<{
    id: ChaveMensagem;
    label: string;
    descricao: string;
    usoReal: string;
    comoModelo: boolean;
  }>;
  camposEmpresa: Array<{ id: keyof Empresa; label: string; dica: string; obrigatorio: boolean }>;
  // `promptPrincipal: null` = campo sem teto. Os demais continuam limitados.
  limites: Record<string, number> & { promptPrincipal: number | null };
  regrasInviolaveis: string[];
  papeis: Array<{ id: string; label: string; descricao: string }>;
  permissoes: Permissoes;
}

export interface AgenteResumo {
  id: string;
  label: string;
  descricao: string;
  numeros: string[];
  status: 'active' | 'standby' | 'disabled';
  versao: number;
  nuncaPublicada: boolean;
  temRascunho: boolean;
  rascunhoEm: string | null;
  rascunhoPor: string | null;
  publicadaEm: string | null;
  publicadaPor: string | null;
}

export interface EstadoAgente {
  agente: {
    id: string;
    label: string;
    descricao: string;
    numeros: string[];
    status: 'active' | 'standby' | 'disabled';
    statusOrigem: 'painel' | 'config';
  };
  publicada: ConfiguracaoAgente;
  nuncaPublicada: boolean;
  versao: number;
  publicadaEm: string | null;
  publicadaPor: { nome?: string; email?: string } | null;
  rascunho: ConfiguracaoAgente | null;
  temRascunho: boolean;
  rascunhoEm: string | null;
  rascunhoPor: { nome?: string; email?: string } | null;
  alteracoes: Alteracao[];
}

export interface VersaoResumo {
  versao: number;
  nota: string;
  alteracoes: Alteracao[];
  publicadaEm: string;
  publicadaPor: string;
  restauradaDe: number | null;
}

export interface VersaoDetalhe extends VersaoResumo {
  config: ConfiguracaoAgente;
  alteracoesEmRelacaoAoAtual: Alteracao[];
}

export interface MensagemTeste {
  role: 'user' | 'assistant';
  text: string;
}

export interface RespostaTeste {
  ok: boolean;
  bloqueado?: boolean;
  resposta: string | null;
  motivoBloqueio?: string[];
  ontologia: Record<string, unknown>;
  diagnostico: {
    explicacao?: string;
    sinais?: string[];
    cuidadoRedobrado?: boolean;
    motivoDoCuidado?: string | null;
    faltaDescobrir?: string[];
    baseConsultada?: string[];
    reescrita?: boolean;
    violacoes?: string[];
    encaminhado?: string | null;
    latenciaMs?: number;
  };
  instrucoes?: string;
}

export interface UsuarioPainel {
  id: string;
  email: string;
  nome: string | null;
  papel: string;
  ativo: boolean;
  ultimoAcesso: string | null;
}

const base = '/api/curadoria';

export const curadoriaApi = {
  opcoes: () => request<Opcoes>(`${base}/opcoes`),
  agentes: () => request<{ agentes: AgenteResumo[] }>(`${base}/agentes`),
  agente: (id: string) => request<EstadoAgente>(`${base}/agentes/${id}`),
  padrao: (id: string) => request<{ config: ConfiguracaoAgente }>(`${base}/agentes/${id}/padrao`),

  salvarRascunho: (id: string, config: ConfiguracaoAgente) =>
    request<{ rascunho: ConfiguracaoAgente; alteracoes: Alteracao[]; validacao: Validacao }>(
      `${base}/agentes/${id}/rascunho`,
      { method: 'PUT', body: JSON.stringify({ config }) }
    ),

  validar: (id: string, config: ConfiguracaoAgente) =>
    request<{ validacao: Validacao; alteracoes: Alteracao[] }>(`${base}/agentes/${id}/validar`, {
      method: 'POST',
      body: JSON.stringify({ config }),
    }),

  publicar: (id: string, nota?: string) =>
    request<{ ok: boolean; versao: number; alteracoes: Alteracao[] }>(
      `${base}/agentes/${id}/publicar`,
      { method: 'POST', body: JSON.stringify({ nota: nota ?? '' }) }
    ),

  descartar: (id: string) =>
    request<EstadoAgente>(`${base}/agentes/${id}/descartar`, { method: 'POST' }),

  versoes: (id: string) => request<{ versoes: VersaoResumo[] }>(`${base}/agentes/${id}/versoes`),
  versao: (id: string, numero: number) =>
    request<VersaoDetalhe>(`${base}/agentes/${id}/versoes/${numero}`),
  restaurar: (id: string, numero: number) =>
    request<{ ok: boolean; versao: number; restauradaDe: number }>(
      `${base}/agentes/${id}/versoes/${numero}/restaurar`,
      { method: 'POST' }
    ),

  status: (id: string, status: 'active' | 'standby') =>
    request<{ agentId: string; status: string }>(`${base}/agentes/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  testar: (
    id: string,
    payload: {
      config: ConfiguracaoAgente;
      mensagem: string;
      historico: MensagemTeste[];
      ontologia: Record<string, unknown> | null;
    }
  ) => request<RespostaTeste>(`${base}/agentes/${id}/testar`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  usuarios: () => request<{ usuarios: UsuarioPainel[] }>(`${base}/usuarios`),
  criarUsuario: (dados: { email: string; senha: string; nome?: string; papel: string }) =>
    request<{ usuario: unknown }>(`${base}/usuarios`, {
      method: 'POST',
      body: JSON.stringify(dados),
    }),
  alterarUsuario: (id: string, dados: { papel?: string; ativo?: boolean; nome?: string }) =>
    request<{ usuario: unknown }>(`${base}/usuarios/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dados),
    }),
};

/** Copia profunda o bastante para o estado do formulario nao alterar o original. */
export const clonar = <T,>(valor: T): T => JSON.parse(JSON.stringify(valor)) as T;

/** Duas configuracoes sao iguais? Usado para saber se ha algo a salvar. */
export const iguais = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function formatarData(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
