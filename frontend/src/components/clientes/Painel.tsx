'use client';

import React, { useEffect, useState } from 'react';
import { CalendarClock, CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import { Selo } from '@/components/ui/base';
import {
  CORES_SOLIDAS,
  clientesApi,
  prazoRelativo,
  type Filtros,
  type Painel as TipoPainel,
  type Tarefa,
} from '@/lib/clientes';

/**
 * PAINEL OPERACIONAL
 * ------------------
 * Cada indicador e um BOTAO que abre a lista com aquele recorte. E o que
 * separa um painel util de um cartaz: descobrir que ha "7 clientes parados" so
 * ajuda se descobrir QUEM sao esses sete custar um clique.
 */
export default function PainelOperacional({
  aoFiltrar,
  aoAbrirCliente,
}: {
  aoFiltrar: (filtros: Filtros) => void;
  aoAbrirCliente: (id: string) => void;
}) {
  const [painel, setPainel] = useState<TipoPainel | null>(null);
  const [agenda, setAgenda] = useState<{ vencidas: Tarefa[]; hoje: Tarefa[]; proximas: Tarefa[] } | null>(
    null
  );
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;

    Promise.all([clientesApi.painel(), clientesApi.agenda(7)])
      .then(([dadosPainel, dadosAgenda]) => {
        if (!vivo) return;
        setPainel(dadosPainel);
        setAgenda(dadosAgenda);
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Falha ao carregar o painel'));

    return () => {
      vivo = false;
    };
  }, []);

  if (erro) {
    return (
      <p className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
        {erro}
      </p>
    );
  }

  if (!painel) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted">
        <Loader2 size={16} className="animate-spin text-gold-400" />
        Carregando o painel…
      </div>
    );
  }

  const tons = {
    neutro: 'border-navy-800 hover:border-gold-500/40',
    atencao: 'border-amber-400/25 hover:border-amber-400/50',
    alerta: 'border-red-500/25 hover:border-red-500/50',
  };

  const cores = {
    neutro: 'text-cream',
    atencao: 'text-amber-200',
    alerta: 'text-red-200',
  };

  return (
    <div className="space-y-8">
      {/* ---------------------------------------------------- indicadores */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {painel.indicadores.map((indicador) => (
          <button
            key={indicador.id}
            onClick={() => aoFiltrar(indicador.filtro as Filtros)}
            disabled={indicador.valor === 0}
            className={`rounded-2xl border bg-navy-900/40 p-4 text-left transition-colors disabled:cursor-default disabled:opacity-50 ${
              tons[indicador.tom]
            }`}
          >
            <p className={`font-display text-2xl tabular-nums ${cores[indicador.tom]}`}>
              {indicador.valor}
            </p>
            <p className="mt-1 text-xs leading-snug text-muted">{indicador.label}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* --------------------------------------------------- distribuicao */}
        <section className="space-y-5 rounded-2xl border border-navy-800 p-5">
          <h2 className="font-display text-lg tracking-wide text-cream">Distribuicao da carteira</h2>

          <Distribuicao
            titulo="Por status"
            itens={painel.porStatus}
            aoClicar={(id) => aoFiltrar({ status: id })}
          />

          {painel.porEtapa.some((e) => e.total > 0) && (
            <Distribuicao
              titulo="Por etapa"
              itens={painel.porEtapa}
              aoClicar={(id) => aoFiltrar({ etapa: id })}
            />
          )}

          <div>
            <h3 className="mb-2 text-xs uppercase tracking-[0.2em] text-muted">Por responsavel</h3>
            <ul className="space-y-1.5">
              {painel.porResponsavel.map((r) => (
                <li key={r.id || 'sem'}>
                  <button
                    onClick={() => r.id && aoFiltrar({ responsavel: r.id })}
                    disabled={!r.id}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-navy-900/60 disabled:hover:bg-transparent"
                  >
                    <span className={r.id ? 'text-parchment/85' : 'text-amber-200/80'}>{r.nome}</span>
                    <span className="tabular-nums text-muted">{r.total}</span>
                  </button>
                </li>
              ))}
              {!painel.porResponsavel.length && (
                <li className="text-sm text-navy-600">Nenhum cliente em andamento.</li>
              )}
            </ul>
          </div>
        </section>

        {/* -------------------------------------------------------- agenda */}
        <section className="space-y-4 rounded-2xl border border-navy-800 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-lg tracking-wide text-cream">Agenda</h2>
            <span className="text-xs text-muted">proximos 7 dias</span>
          </div>

          {!agenda ? (
            <Loader2 size={16} className="animate-spin text-gold-400" />
          ) : !agenda.vencidas.length && !agenda.hoje.length && !agenda.proximas.length ? (
            <div className="flex items-center gap-3 py-6">
              <CheckCircle2 size={18} className="shrink-0 text-emerald-300" />
              <p className="text-sm text-muted">Nenhuma tarefa com prazo nos proximos dias.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <GrupoTarefas
                titulo="Vencidas"
                tarefas={agenda.vencidas}
                tom="alerta"
                aoAbrir={aoAbrirCliente}
              />
              <GrupoTarefas titulo="Hoje" tarefas={agenda.hoje} tom="atencao" aoAbrir={aoAbrirCliente} />
              <GrupoTarefas
                titulo="Proximos dias"
                tarefas={agenda.proximas}
                tom="neutro"
                aoAbrir={aoAbrirCliente}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Distribuicao({
  titulo,
  itens,
  aoClicar,
}: {
  titulo: string;
  itens: Array<{ id: string; label: string; total: number; cor?: string }>;
  aoClicar: (id: string) => void;
}) {
  const maior = Math.max(1, ...itens.map((i) => i.total));

  return (
    <div>
      <h3 className="mb-2 text-xs uppercase tracking-[0.2em] text-muted">{titulo}</h3>
      <ul className="space-y-1.5">
        {itens.map((item) => (
          <li key={item.id}>
            <button
              onClick={() => aoClicar(item.id)}
              disabled={item.total === 0}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-1 text-sm transition-colors hover:bg-navy-900/60 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <span className="w-40 shrink-0 truncate text-left text-parchment/85">{item.label}</span>
              {/* Barra proporcional: a proporcao entre etapas e mais legivel
                  que a leitura de sete numeros soltos. */}
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-navy-850">
                <span
                  className={`block h-full rounded-full ${
                    CORES_SOLIDAS[item.cor || 'neutro'] || CORES_SOLIDAS.neutro
                  }`}
                  style={{ width: `${(item.total / maior) * 100}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right tabular-nums text-muted">{item.total}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GrupoTarefas({
  titulo,
  tarefas,
  tom,
  aoAbrir,
}: {
  titulo: string;
  tarefas: Tarefa[];
  tom: 'alerta' | 'atencao' | 'neutro';
  aoAbrir: (clienteId: string) => void;
}) {
  if (!tarefas.length) return null;

  const cores = {
    alerta: 'text-red-300',
    atencao: 'text-amber-300',
    neutro: 'text-muted',
  };

  return (
    <div>
      <h3 className={`mb-2 flex items-center gap-1.5 text-xs uppercase tracking-[0.2em] ${cores[tom]}`}>
        {tom === 'alerta' ? <TriangleAlert size={12} /> : <CalendarClock size={12} />}
        {titulo} ({tarefas.length})
      </h3>
      <ul className="space-y-1.5">
        {tarefas.slice(0, 6).map((tarefa) => (
          <li key={tarefa.id}>
            <button
              onClick={() => aoAbrir(tarefa.clienteId)}
              className="flex w-full items-start justify-between gap-3 rounded-lg border border-navy-800 px-3 py-2 text-left transition-colors hover:border-gold-500/30"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-parchment/85">{tarefa.titulo}</span>
                <span className="block truncate text-xs text-muted">
                  {tarefa.clienteNome || tarefa.clienteTelefone || 'cliente sem nome'}
                  {tarefa.responsavel?.nome ? ` · ${tarefa.responsavel.nome}` : ''}
                </span>
              </span>
              <Selo cor={tom === 'alerta' ? 'atencao' : 'neutro'}>{prazoRelativo(tarefa.prazo)}</Selo>
            </button>
          </li>
        ))}
        {tarefas.length > 6 && (
          <li className="px-3 text-xs text-muted">+ {tarefas.length - 6} outras</li>
        )}
      </ul>
    </div>
  );
}
