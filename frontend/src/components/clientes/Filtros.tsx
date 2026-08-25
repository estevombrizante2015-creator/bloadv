'use client';

import React from 'react';
import { Search, X } from 'lucide-react';
import { Seletor } from '@/components/ui/base';
import { PontoDeCor } from './comuns';
import {
  PRIORIDADE_COR,
  PRIORIDADE_LABEL,
  type Filtros as TipoFiltros,
  type Pipeline,
  type Responsavel,
} from '@/lib/clientes';

/**
 * PESQUISA E FILTROS
 * ------------------
 * A carteira cresce e a lista deixa de ser navegavel por rolagem. O que
 * substitui a varredura visual da planilha sao os tres atalhos da direita —
 * "com pendencias", "acao vencida", "parados" — que respondem de uma vez as
 * perguntas que levavam alguem a conferir linha por linha.
 *
 * Filtro aplicado aparece como etiqueta removivel. Sem isso a pessoa esquece
 * que filtrou e conclui que o cliente sumiu do sistema.
 */

export default function Filtros({
  filtros,
  aoMudar,
  pipeline,
  responsaveis,
  total,
}: {
  filtros: TipoFiltros;
  aoMudar: (novos: TipoFiltros) => void;
  pipeline: Pipeline;
  responsaveis: Responsavel[];
  total?: number;
}) {
  const definir = (chave: keyof TipoFiltros, valor: string) =>
    aoMudar({ ...filtros, [chave]: valor || undefined, pular: undefined });

  const alternar = (chave: keyof TipoFiltros) =>
    definir(chave, filtros[chave] === 'true' ? '' : 'true');

  const ativos = Object.entries(filtros).filter(
    ([chave, valor]) => valor && !['ordem', 'limite', 'pular'].includes(chave)
  );

  const rotulo = (chave: string, valor: string) => {
    if (chave === 'q') return `busca: ${valor}`;
    if (chave === 'status') {
      return valor
        .split(',')
        .map((id) => pipeline.status.find((s) => s.id === id)?.label || id)
        .join(', ');
    }
    if (chave === 'etapa') {
      return valor
        .split(',')
        .map((id) => pipeline.etapas.find((e) => e.id === id)?.label || id)
        .join(', ');
    }
    if (chave === 'responsavel') {
      return responsaveis.find((r) => r.id === valor)?.nome || 'responsavel';
    }
    if (chave === 'comPendencias') return 'com pendencias';
    if (chave === 'acaoVencida') return 'acao vencida';
    if (chave === 'paradoHaDias') return `parados ha ${valor}+ dias`;
    if (chave === 'arquivados') return 'arquivados';
    if (chave === 'prioridade') return `prioridade: ${valor}`;
    if (chave === 'tag') return `etiqueta: ${valor}`;
    if (chave === 'de') return `desde ${valor}`;
    if (chave === 'ate') return `ate ${valor}`;
    return `${chave}: ${valor}`;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={filtros.q || ''}
            onChange={(e) => definir('q', e.target.value)}
            placeholder="Nome, telefone ou e-mail"
            className="w-full rounded-xl border border-navy-800 bg-navy-900/60 py-2 pl-9 pr-3 text-sm text-cream placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none"
          />
        </div>

        {/* Cada filtro tem largura propria: uma barra de seletores todos do
            mesmo tamanho esconde qual deles esta preenchido. */}
        <div className="w-48">
          <Seletor
            valor={filtros.status || ''}
            aoMudar={(v) => definir('status', v)}
            placeholder="Todos os status"
            opcoes={[
              { valor: '', label: 'Todos os status' },
              ...pipeline.status.map((s) => ({
                valor: s.id,
                label: s.label,
                enfeite: <PontoDeCor cor={s.cor} />,
              })),
            ]}
          />
        </div>

        <div className="w-48">
          <Seletor
            valor={filtros.etapa || ''}
            aoMudar={(v) => definir('etapa', v)}
            placeholder="Todas as etapas"
            opcoes={[
              { valor: '', label: 'Todas as etapas' },
              ...pipeline.etapas.map((e) => ({ valor: e.id, label: e.label })),
            ]}
          />
        </div>

        <div className="w-48">
          <Seletor
            valor={filtros.responsavel || ''}
            aoMudar={(v) => definir('responsavel', v)}
            placeholder="Qualquer responsavel"
            opcoes={[
              { valor: '', label: 'Qualquer responsavel' },
              ...responsaveis.map((r) => ({ valor: r.id, label: r.nome, descricao: r.email })),
            ]}
          />
        </div>

        <div className="w-44">
          <Seletor
            valor={filtros.prioridade || ''}
            aoMudar={(v) => definir('prioridade', v)}
            placeholder="Qualquer prioridade"
            opcoes={[
              { valor: '', label: 'Qualquer prioridade' },
              ...pipeline.prioridades.map((p) => ({
                valor: p,
                label: PRIORIDADE_LABEL[p],
                enfeite: <PontoDeCor cor={PRIORIDADE_COR[p]} />,
              })),
            ]}
          />
        </div>
      </div>

      {/* Os atalhos que substituem a varredura da planilha. */}
      <div className="flex flex-wrap items-center gap-2">
        <Atalho ativo={filtros.comPendencias === 'true'} aoClicar={() => alternar('comPendencias')}>
          Com pendencias
        </Atalho>
        <Atalho ativo={filtros.acaoVencida === 'true'} aoClicar={() => alternar('acaoVencida')}>
          Acao vencida
        </Atalho>
        <Atalho
          ativo={filtros.paradoHaDias === '7'}
          aoClicar={() => definir('paradoHaDias', filtros.paradoHaDias === '7' ? '' : '7')}
        >
          Parados ha 7+ dias
        </Atalho>
        <Atalho
          ativo={filtros.paradoHaDias === '15'}
          aoClicar={() => definir('paradoHaDias', filtros.paradoHaDias === '15' ? '' : '15')}
        >
          15+ dias
        </Atalho>
        <Atalho ativo={filtros.arquivados === 'true'} aoClicar={() => alternar('arquivados')}>
          Arquivados
        </Atalho>

        <div className="ml-auto flex items-center gap-2">
          {typeof total === 'number' && (
            <span className="text-xs tabular-nums text-muted">
              {total} {total === 1 ? 'cliente' : 'clientes'}
            </span>
          )}
          <div className="w-56">
            <Seletor
              valor={filtros.ordem || 'recentes'}
              aoMudar={(v) => definir('ordem', v)}
              opcoes={[
                { valor: 'recentes', label: 'Atualizados recentemente' },
                { valor: 'proxima_acao', label: 'Proxima acao' },
                { valor: 'sem_contato', label: 'Parados ha mais tempo' },
                { valor: 'prioridade', label: 'Prioridade' },
                { valor: 'nome', label: 'Nome' },
              ]}
            />
          </div>
        </div>
      </div>

      {ativos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-navy-800 pt-3">
          <span className="text-xs text-muted">Filtrando por:</span>
          {ativos.map(([chave, valor]) => (
            <button
              key={chave}
              onClick={() => definir(chave as keyof TipoFiltros, '')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gold-500/30 bg-gold-500/10 px-2.5 py-1 text-xs text-gold-200 transition-colors hover:border-gold-400"
            >
              {rotulo(chave, String(valor))}
              <X size={11} />
            </button>
          ))}
          <button
            onClick={() => aoMudar({ ordem: filtros.ordem })}
            className="text-xs text-muted underline-offset-2 transition-colors hover:text-gold-300 hover:underline"
          >
            limpar tudo
          </button>
        </div>
      )}
    </div>
  );
}

function Atalho({
  children,
  ativo,
  aoClicar,
}: {
  children: React.ReactNode;
  ativo: boolean;
  aoClicar: () => void;
}) {
  return (
    <button
      onClick={aoClicar}
      className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
        ativo
          ? 'border-gold-500/50 bg-gold-500/10 text-gold-200'
          : 'border-navy-800 text-muted hover:border-gold-500/30 hover:text-parchment'
      }`}
    >
      {children}
    </button>
  );
}
