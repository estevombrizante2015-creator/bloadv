'use client';

import React from 'react';
import { ChevronRight, Users } from 'lucide-react';
import { Alertas, Avatar, MarcaPrioridade, SeloStatus, nomeExibido } from './comuns';
import { haQuantoTempo, prazoRelativo, type ClienteResumo } from '@/lib/clientes';

/**
 * A CARTEIRA EM LISTA
 * -------------------
 * Uma linha por cliente, respondendo na horizontal a pergunta do enunciado:
 * quem e → onde esta → o que aguardamos → qual o proximo passo → quem responde.
 *
 * Nao e uma tabela. Tabela obriga toda linha a ter a mesma altura e o mesmo
 * peso visual, e aqui o que importa e justamente o contrario: o cliente com
 * acao vencida precisa saltar aos olhos ao lado do que esta em dia.
 */
export default function Lista({
  clientes,
  aoAbrir,
  carregando,
  total,
  aoCarregarMais,
}: {
  clientes: ClienteResumo[];
  aoAbrir: (id: string) => void;
  carregando?: boolean;
  total: number;
  aoCarregarMais?: () => void;
}) {
  if (!carregando && !clientes.length) {
    return (
      <div className="rounded-2xl border border-navy-800 bg-navy-900/40 p-10 text-center">
        <Users size={22} className="mx-auto mb-3 text-navy-600" />
        <p className="text-sm text-muted">
          Nenhum cliente com esses filtros. Ajuste a busca ou cadastre um cliente novo.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {clientes.map((cliente) => (
        <button
          key={cliente.id}
          onClick={() => aoAbrir(cliente.id)}
          className={`group flex w-full items-start gap-4 rounded-xl border bg-navy-900/40 p-4 text-left transition-colors hover:border-gold-500/40 ${
            // Uma borda, nao um fundo vermelho: a lista inteira pintada vira
            // ruido e a pessoa para de reparar no que e urgente.
            cliente.proximaAcaoVencida || cliente.tarefasVencidas > 0
              ? 'border-red-500/25'
              : 'border-navy-800'
          }`}
        >
          <Avatar cliente={cliente} />

          <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-12">
            {/* quem e */}
            <div className="min-w-0 sm:col-span-4">
              <div className="flex items-center gap-2">
                <h3 className="min-w-0 truncate font-display text-sm tracking-wide text-cream">
                  {nomeExibido(cliente)}
                </h3>
                <MarcaPrioridade prioridade={cliente.prioridade} />
              </div>
              {cliente.nome && cliente.telefoneFormatado && (
                <p className="mt-0.5 truncate text-xs tabular-nums text-muted">
                  {cliente.telefoneFormatado}
                </p>
              )}
              <div className="mt-1.5">
                <SeloStatus label={cliente.statusLabel} cor={cliente.statusCor} />
              </div>
            </div>

            {/* o que aguardamos */}
            <div className="min-w-0 sm:col-span-4">
              {cliente.aguardando ? (
                <p className="text-xs leading-relaxed text-parchment/80">
                  <span className="text-muted">Aguardando: </span>
                  {cliente.aguardando}
                </p>
              ) : (
                <p className="text-xs text-navy-600">sem espera registrada</p>
              )}

              {cliente.etapaLabel && (
                <p className="mt-1 text-xs text-muted">Etapa: {cliente.etapaLabel}</p>
              )}

              <div className="mt-1.5">
                <Alertas cliente={cliente} />
              </div>
            </div>

            {/* proximo passo e responsavel */}
            <div className="min-w-0 sm:col-span-4">
              {cliente.proximaAcao ? (
                <p className="text-xs leading-relaxed text-parchment/80">
                  <span className="text-muted">Proximo passo: </span>
                  {cliente.proximaAcao}
                  {cliente.proximaAcaoEm && (
                    <span
                      className={
                        cliente.proximaAcaoVencida ? ' text-red-300' : ' text-gold-300/80'
                      }
                    >
                      {' '}
                      ({prazoRelativo(cliente.proximaAcaoEm)})
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-xs text-navy-600">sem proximo passo definido</p>
              )}

              <p className="mt-1.5 truncate text-xs text-muted">
                {cliente.responsavel?.nome || 'Sem responsavel'} · ultimo contato{' '}
                {haQuantoTempo(cliente.ultimoContatoEm)}
              </p>
            </div>
          </div>

          <ChevronRight
            size={16}
            className="mt-1 shrink-0 text-navy-600 transition-colors group-hover:text-gold-400"
          />
        </button>
      ))}

      {clientes.length < total && aoCarregarMais && (
        <button
          onClick={aoCarregarMais}
          disabled={carregando}
          className="w-full rounded-xl border border-navy-800 py-3 text-sm text-muted transition-colors hover:border-gold-500/30 hover:text-gold-300 disabled:opacity-50"
        >
          {carregando ? 'Carregando…' : `Ver mais (${total - clientes.length} restantes)`}
        </button>
      )}
    </div>
  );
}
