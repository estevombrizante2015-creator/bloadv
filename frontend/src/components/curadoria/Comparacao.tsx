'use client';

import React from 'react';
import { ArrowRight, Check, CircleCheck, Minus, Plus } from 'lucide-react';
import { Problema as CartaoProblema } from '@/components/ui/base';
import type { Alteracao, Validacao } from '@/lib/curadoria';

/**
 * COMPARACAO ANTES x DEPOIS
 * -------------------------
 * A tela que a equipe ve antes de publicar. O objetivo nao e mostrar um diff:
 * e responder "o que muda no atendimento se eu clicar em publicar agora".
 *
 * Por isso cada linha vem com o ROTULO em portugues vindo do servidor
 * ("Tom de voz", "Regra editada") e nao com o caminho do campo. E por isso os
 * dois lados aparecem inteiros, um sob o outro: destacar palavra a palavra
 * economiza espaco e obriga a pessoa a remontar a frase de cabeca.
 */

const ESTILOS = {
  adicionado: { rotulo: 'Novo', cor: 'text-emerald-300', borda: 'border-emerald-400/25', Icone: Plus },
  removido: { rotulo: 'Removido', cor: 'text-red-300', borda: 'border-red-500/25', Icone: Minus },
  alterado: { rotulo: 'Alterado', cor: 'text-gold-300', borda: 'border-gold-500/25', Icone: ArrowRight },
} as const;

function Lado({ titulo, texto, apagado }: { titulo: string; texto: string; apagado?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1.5 text-xs uppercase tracking-[0.2em] text-muted">{titulo}</p>
      <div
        className={`scrollbar-thin max-h-52 overflow-y-auto whitespace-pre-line rounded-xl border border-navy-800 px-3.5 py-2.5 text-sm leading-relaxed ${
          apagado ? 'bg-navy-900/30 text-muted' : 'bg-navy-900/60 text-parchment'
        }`}
      >
        {texto.trim() || <span className="italic text-muted">(vazio)</span>}
      </div>
    </div>
  );
}

export function Comparacao({ alteracoes }: { alteracoes: Alteracao[] }) {
  if (!alteracoes.length) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-navy-800 bg-navy-900/40 p-5">
        <CircleCheck size={18} className="shrink-0 text-emerald-300" />
        <p className="text-sm text-parchment/80">
          Nada mudou em relacao ao que esta no ar agora.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {alteracoes.map((alteracao, indice) => {
        const estilo = ESTILOS[alteracao.tipo];
        const { Icone } = estilo;

        return (
          <article
            key={`${alteracao.campo}-${indice}`}
            className={`rounded-xl border ${estilo.borda} bg-navy-900/30 p-4`}
          >
            <header className="mb-3 flex items-center gap-2">
              <Icone size={14} className={estilo.cor} />
              <h4 className="font-display text-sm tracking-wide text-cream">{alteracao.rotulo}</h4>
              <span className={`ml-auto text-xs ${estilo.cor}`}>{estilo.rotulo}</span>
            </header>

            <div className="flex flex-col gap-3 sm:flex-row">
              {alteracao.tipo !== 'adicionado' && (
                <Lado titulo="Antes" texto={alteracao.antes} apagado />
              )}
              {alteracao.tipo !== 'removido' && <Lado titulo="Depois" texto={alteracao.depois} />}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/**
 * Bloco de validacao: erros primeiro, avisos depois.
 *
 * Erro impede publicar; aviso e um palpite que a pessoa decide. A tela precisa
 * deixar essa diferenca obvia, senao um aviso vira erro na cabeca de quem le
 * e a publicacao para por medo.
 */
export function ResultadoValidacao({ validacao }: { validacao: Validacao | null }) {
  if (!validacao) return null;

  const { erros, avisos } = validacao;

  if (!erros.length && !avisos.length) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-4">
        <Check size={16} className="shrink-0 text-emerald-300" />
        <p className="text-sm text-emerald-100/90">Tudo certo. Pode publicar.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {erros.length > 0 && (
        <p className="text-sm text-red-200">
          {erros.length === 1
            ? 'Um problema precisa ser corrigido antes de publicar:'
            : `${erros.length} problemas precisam ser corrigidos antes de publicar:`}
        </p>
      )}

      {erros.map((problema, i) => (
        <CartaoProblema key={`erro-${i}`} {...problema} />
      ))}

      {avisos.length > 0 && (
        <p className="pt-1 text-sm text-amber-200/90">
          {erros.length ? 'Alem disso, vale conferir:' : 'Nada impede a publicacao. Vale conferir:'}
        </p>
      )}

      {avisos.map((problema, i) => (
        <CartaoProblema key={`aviso-${i}`} {...problema} />
      ))}
    </div>
  );
}
