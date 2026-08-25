'use client';

import React from 'react';
import { AlertTriangle, CalendarClock, CircleDot, Clock, Flag, ListTodo } from 'lucide-react';
import {
  CORES,
  CORES_PRIORIDADE,
  CORES_SOLIDAS,
  haQuantoTempo,
  prazoRelativo,
  type ClienteResumo,
  type Prioridade,
} from '@/lib/clientes';

/**
 * PECAS COMPARTILHADAS DA CARTEIRA
 * --------------------------------
 * Lista, kanban e ficha mostram o mesmo cliente. Se cada tela desenhasse o
 * proprio cartao, o colaborador teria de reaprender onde fica a pendencia a
 * cada aba — e, pior, "atrasado" acabaria significando coisas diferentes em
 * cada lugar.
 */

/**
 * Ponto colorido do status/etapa, para o seletor.
 *
 * A cor no seletor nao e enfeite: com oito status, a lista vira um paredao de
 * texto e o olho perde o lugar. O ponto devolve a leitura por posicao — o
 * vermelho da pendencia e o verde do concluido se acham antes de serem lidos.
 */
export function PontoDeCor({ cor }: { cor?: string }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${CORES_SOLIDAS[cor || 'neutro'] || CORES_SOLIDAS.neutro}`}
    />
  );
}

export function SeloStatus({ label, cor }: { label: string; cor: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-xs font-medium ${
        CORES[cor] || CORES.neutro
      }`}
    >
      <CircleDot size={10} />
      {label}
    </span>
  );
}

/** Prioridade so aparece quando sai do normal — senao vira ruido em toda linha. */
export function MarcaPrioridade({ prioridade }: { prioridade: Prioridade }) {
  if (prioridade === 'normal' || prioridade === 'baixa') return null;

  return (
    <span className={`inline-flex items-center gap-1 text-xs ${CORES_PRIORIDADE[prioridade]}`}>
      <Flag size={11} />
      {prioridade}
    </span>
  );
}

/**
 * Os alertas de um cliente, em ordem de urgencia.
 *
 * Um cliente pode estar atrasado, com pendencia e com tarefa vencida ao mesmo
 * tempo. Mostrar os tres com o mesmo peso faz a pessoa nao ver nenhum, entao a
 * ordem aqui e deliberada: o que ja falhou vem antes do que vai falhar.
 */
export function Alertas({ cliente, compacto }: { cliente: ClienteResumo; compacto?: boolean }) {
  const alertas: Array<{ icone: React.ReactNode; texto: string; tom: string }> = [];

  if (cliente.tarefasVencidas > 0) {
    alertas.push({
      icone: <AlertTriangle size={11} />,
      texto: `${cliente.tarefasVencidas} ${cliente.tarefasVencidas === 1 ? 'tarefa vencida' : 'tarefas vencidas'}`,
      tom: 'text-red-300',
    });
  }

  if (cliente.proximaAcaoVencida) {
    alertas.push({
      icone: <CalendarClock size={11} />,
      texto: `acao vencida ${prazoRelativo(cliente.proximaAcaoEm)}`,
      tom: 'text-red-300',
    });
  }

  if (cliente.totalPendencias > 0) {
    alertas.push({
      icone: <ListTodo size={11} />,
      texto: `${cliente.totalPendencias} ${cliente.totalPendencias === 1 ? 'pendencia' : 'pendencias'}`,
      tom: 'text-amber-300',
    });
  }

  if (cliente.diasSemContato !== null && cliente.diasSemContato >= 7) {
    alertas.push({
      icone: <Clock size={11} />,
      texto: `sem contato ${haQuantoTempo(cliente.ultimoContatoEm)}`,
      tom: 'text-amber-300/80',
    });
  }

  if (!alertas.length) return null;

  const visiveis = compacto ? alertas.slice(0, 2) : alertas;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {visiveis.map((alerta) => (
        <span key={alerta.texto} className={`inline-flex items-center gap-1 text-xs ${alerta.tom}`}>
          {alerta.icone}
          {alerta.texto}
        </span>
      ))}
      {compacto && alertas.length > visiveis.length && (
        <span className="text-xs text-muted">+{alertas.length - visiveis.length}</span>
      )}
    </div>
  );
}

/** Iniciais para o avatar. Contato sem nome cai no telefone. */
export function Avatar({ cliente }: { cliente: ClienteResumo }) {
  const base = cliente.nome || cliente.telefoneFormatado || '?';
  const iniciais = cliente.nome
    ? cliente.nome
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase()
    : '#';

  return (
    <span
      title={base}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-navy-700 bg-navy-850 font-display text-xs tracking-wide text-gold-300"
    >
      {iniciais}
    </span>
  );
}

export const nomeExibido = (cliente: ClienteResumo) =>
  cliente.nome || cliente.telefoneFormatado || 'Sem identificacao';

/**
 * Cartao do kanban. Mostra so o que decide se vale abrir: quem e, o que trava,
 * o que precisa acontecer.
 */
export function CartaoCliente({
  cliente,
  aoAbrir,
  arrastavel,
  aoArrastar,
}: {
  cliente: ClienteResumo;
  aoAbrir: () => void;
  arrastavel?: boolean;
  aoArrastar?: (e: React.DragEvent) => void;
}) {
  return (
    <article
      draggable={arrastavel}
      onDragStart={aoArrastar}
      onClick={aoAbrir}
      className={`cursor-pointer rounded-xl border border-navy-800 bg-navy-900/60 p-3.5 transition-colors hover:border-gold-500/40 ${
        arrastavel ? 'active:cursor-grabbing' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="min-w-0 truncate font-display text-sm tracking-wide text-cream">
          {nomeExibido(cliente)}
        </h4>
        <MarcaPrioridade prioridade={cliente.prioridade} />
      </div>

      {cliente.aguardando && (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">
          <span className="text-parchment/60">Aguardando:</span> {cliente.aguardando}
        </p>
      )}

      {cliente.proximaAcao && (
        <p className="mt-1.5 line-clamp-1 text-xs text-parchment/70">→ {cliente.proximaAcao}</p>
      )}

      <div className="mt-3 space-y-1.5">
        <Alertas cliente={cliente} compacto />
        {cliente.responsavel && (
          <p className="truncate text-xs text-muted">{cliente.responsavel.nome}</p>
        )}
      </div>
    </article>
  );
}
