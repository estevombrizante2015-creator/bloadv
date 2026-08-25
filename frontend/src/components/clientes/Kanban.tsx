'use client';

import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CartaoCliente } from './comuns';
import { CORES_SOLIDAS, type ClienteResumo } from '@/lib/clientes';

/**
 * QUADRO KANBAN
 * -------------
 * Arrastar move o cliente de etapa. A coluna decide qual status aplicar, entao
 * a tela nunca precisa saber a regra — ela pede "mover para a coluna X" e o
 * servidor resolve.
 *
 * A MUDANCA APARECE ANTES DA CONFIRMACAO. Arrastar e um gesto fisico: se o
 * cartao so pulasse depois da resposta do servidor, a pessoa arrastaria de
 * novo achando que falhou. Se der erro, o cartao volta sozinho para a coluna
 * de origem e o motivo aparece.
 */

interface Coluna {
  id: string;
  label: string;
  cor: string;
  total: number;
  clientes: ClienteResumo[];
}

export default function Kanban({
  colunas,
  aoAbrir,
  aoMover,
  podeEditar,
  carregando,
}: {
  colunas: Coluna[];
  aoAbrir: (id: string) => void;
  aoMover: (clienteId: string, colunaId: string) => Promise<void>;
  podeEditar: boolean;
  carregando?: boolean;
}) {
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [alvo, setAlvo] = useState<string | null>(null);
  const [movendo, setMovendo] = useState<string | null>(null);

  /** Move local imediato; o estado real volta do servidor no recarregamento. */
  const [otimista, setOtimista] = useState<Record<string, string>>({});

  const soltar = async (colunaId: string) => {
    const clienteId = arrastando;
    setAlvo(null);
    setArrastando(null);
    if (!clienteId || !podeEditar) return;

    const origem = colunas.find((c) => c.clientes.some((cl) => cl.id === clienteId))?.id;
    if (origem === colunaId) return;

    setOtimista((atual) => ({ ...atual, [clienteId]: colunaId }));
    setMovendo(clienteId);

    try {
      await aoMover(clienteId, colunaId);
    } catch {
      // Volta para onde estava: um cartao parado na coluna errada faria a
      // pessoa acreditar numa mudanca que nao aconteceu.
      setOtimista((atual) => {
        const copia = { ...atual };
        delete copia[clienteId];
        return copia;
      });
    } finally {
      setMovendo(null);
    }
  };

  const clientesDa = (coluna: Coluna) => {
    const movidosPraCa = colunas
      .flatMap((c) => c.clientes)
      .filter((cl) => otimista[cl.id] === coluna.id);

    const originais = coluna.clientes.filter(
      (cl) => !otimista[cl.id] || otimista[cl.id] === coluna.id
    );

    // Set por id: um cartao movido de volta para a origem apareceria duas vezes.
    const vistos = new Set<string>();
    return [...movidosPraCa, ...originais].filter((cl) => {
      if (vistos.has(cl.id)) return false;
      vistos.add(cl.id);
      return true;
    });
  };

  return (
    <div className="scrollbar-thin flex gap-4 overflow-x-auto pb-4">
      {colunas.map((coluna) => {
        const lista = clientesDa(coluna);
        const recebendo = alvo === coluna.id;

        return (
          <section
            key={coluna.id}
            onDragOver={(e) => {
              if (!podeEditar) return;
              e.preventDefault();
              setAlvo(coluna.id);
            }}
            onDragLeave={() => setAlvo((atual) => (atual === coluna.id ? null : atual))}
            onDrop={(e) => {
              e.preventDefault();
              soltar(coluna.id);
            }}
            className={`flex w-72 shrink-0 flex-col rounded-2xl border transition-colors ${
              recebendo ? 'border-gold-500/50 bg-gold-500/5' : 'border-navy-800 bg-navy-900/20'
            }`}
          >
            <header className="flex items-center justify-between gap-2 border-b border-navy-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${CORES_SOLIDAS[coluna.cor] || CORES_SOLIDAS.neutro}`}
                />
                <h3 className="font-display text-sm tracking-wide text-cream">{coluna.label}</h3>
              </div>
              <span className="rounded-md bg-navy-850 px-2 py-0.5 text-xs tabular-nums text-muted">
                {coluna.total}
              </span>
            </header>

            <div className="scrollbar-thin max-h-[calc(100vh-22rem)] flex-1 space-y-2 overflow-y-auto p-3">
              {carregando && !lista.length && (
                <div className="flex justify-center py-6">
                  <Loader2 size={16} className="animate-spin text-gold-400" />
                </div>
              )}

              {!carregando && !lista.length && (
                <p className="py-6 text-center text-xs text-navy-600">Nenhum cliente aqui</p>
              )}

              {lista.map((cliente) => (
                <div key={cliente.id} className={movendo === cliente.id ? 'opacity-50' : ''}>
                  <CartaoCliente
                    cliente={cliente}
                    aoAbrir={() => aoAbrir(cliente.id)}
                    arrastavel={podeEditar}
                    aoArrastar={() => setArrastando(cliente.id)}
                  />
                </div>
              ))}

              {coluna.total > lista.length && (
                <p className="pt-2 text-center text-xs text-muted">
                  + {coluna.total - lista.length} nao exibidos. Use a lista para ver todos.
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
