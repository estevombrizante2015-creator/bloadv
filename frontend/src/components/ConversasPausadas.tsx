'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Bot, Loader2, MessageSquare, PlayCircle, TriangleAlert, User } from 'lucide-react';
import type { PausedConversation } from '@/lib/api';
import { desde, iniciais, motivoLegivel, pausaAutomatica } from '@/lib/pausa';

/**
 * CONVERSAS EM QUE O AGENTE ESTA CALADO
 * -------------------------------------
 * Esta lista e uma fila de trabalho, nao um relatorio: cada linha e uma pessoa
 * que so recebe resposta se alguem do escritorio responder.
 *
 * Antes eram telefones crus, um embaixo do outro, com a chave interna do motivo
 * ("atendimento_humano") por legenda. Para saber com quem se falava era preciso
 * abrir uma por uma. Agora a linha responde, na ordem em que a duvida aparece:
 * QUEM e, POR QUE parou, HA QUANTO TEMPO — e se a pessoa esta esperando
 * resposta agora.
 */

type Canal = { id: string; label: string };

export default function ConversasPausadas({
  conversas,
  canais = [],
  onRetomar,
}: {
  conversas: PausedConversation[];
  canais?: Canal[];
  onRetomar: (sessionId: string, chatId: string) => Promise<void> | void;
}) {
  const [retomando, setRetomando] = useState<string | null>(null);

  const retomar = async (conversa: PausedConversation) => {
    setRetomando(conversa._id);
    try {
      await onRetomar(conversa.sessionId, conversa.chatId);
    } finally {
      setRetomando(null);
    }
  };

  const automaticas = conversas.filter((c) => pausaAutomatica(c.pausedReason, c.status)).length;

  return (
    <div className="overflow-hidden rounded-xl border border-navy-800 bg-navy-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-navy-800 px-4 py-2.5">
        <p className="text-[11px] leading-relaxed text-muted">
          O agente esta calado nestas {conversas.length}{' '}
          {conversas.length === 1 ? 'conversa' : 'conversas'}. Ninguem recebe resposta automatica
          ate alguem retomar.
        </p>
        {automaticas > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200">
            <TriangleAlert size={11} />
            {automaticas} {automaticas === 1 ? 'pausa automatica' : 'pausas automaticas'}
          </span>
        )}
      </div>

      {/* Com muitas conversas paradas, a lista sozinha empurraria o resto da
          pagina para fora da tela. */}
      <div className="max-h-[28rem] divide-y divide-navy-800 overflow-y-auto">
        {conversas.map((conversa) => (
          <Linha
            key={conversa._id}
            conversa={conversa}
            canal={canais.find((c) => c.id === conversa.sessionId)?.label || conversa.sessionId}
            retomando={retomando === conversa._id}
            onRetomar={() => retomar(conversa)}
          />
        ))}
      </div>
    </div>
  );
}

function Linha({
  conversa,
  canal,
  retomando,
  onRetomar,
}: {
  conversa: PausedConversation;
  canal: string;
  retomando: boolean;
  onRetomar: () => void;
}) {
  const automatica = pausaAutomatica(conversa.pausedReason, conversa.status);
  const motivo = motivoLegivel(conversa.pausedReason) || 'pausada';
  const letras = iniciais(conversa.nome);

  /**
   * O WhatsApp endereca muitos chats por LID, que NAO e telefone. Quando o
   * numero real ainda nao apareceu, dizer "identificador" e mais honesto do que
   * formatar o codigo opaco como se fosse um numero de telefone.
   */
  const contato =
    conversa.numero ||
    (conversa.isLid ? `ID ${conversa.identificador ?? conversa.chatId}` : conversa.chatId);

  const paradaHa = desde(conversa.pausedAt);

  /**
   * A pessoa escreveu DEPOIS que a conversa parou: ela esta esperando uma
   * resposta que o agente nao vai dar. E o unico dado desta tela que pede acao
   * imediata, entao e o unico com cor propria.
   */
  const esperando =
    conversa.lastUserMessageAt &&
    conversa.pausedAt &&
    new Date(conversa.lastUserMessageAt) > new Date(conversa.pausedAt)
      ? desde(conversa.lastUserMessageAt)
      : null;

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-navy-850/60">
      <div
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${
          letras
            ? 'border-gold-500/25 bg-gold-500/10 text-gold-300'
            : 'border-navy-700 bg-navy-850 text-navy-600'
        }`}
        aria-hidden
      >
        {letras ?? <User size={14} />}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-cream">
          {conversa.nome || <span className="text-muted">Sem nome no WhatsApp</span>}
        </p>
        <p className="truncate text-[11px] text-muted">
          <span className="tabular-nums">{contato}</span>
          <span className="text-navy-600"> · {canal}</span>
          {paradaHa && <span className="text-navy-600"> · parada {paradaHa}</span>}
        </p>
      </div>

      <div className="flex min-w-0 flex-col items-start gap-1 sm:items-end">
        <span
          className={`inline-flex max-w-full items-center gap-1.5 truncate rounded-md border px-2 py-0.5 text-[10px] ${
            automatica
              ? 'border-amber-400/25 bg-amber-400/10 text-amber-200'
              : 'border-sky-400/25 bg-sky-400/10 text-sky-300'
          }`}
          title={conversa.pausedReason || conversa.status}
        >
          {automatica ? <Bot size={11} /> : <User size={11} />}
          {motivo}
        </span>

        {esperando && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-300">
            <MessageSquare size={10} />
            escreveu {esperando} e segue sem resposta
          </span>
        )}

        {conversa.botSignals?.length ? (
          <span className="truncate text-[10px] text-navy-600">
            sinais: {conversa.botSignals.join(', ')}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Link
          href={`/conversas?canal=${conversa.sessionId}&chat=${encodeURIComponent(conversa.chatId)}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-navy-800 px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-sky-400/40 hover:text-sky-300"
        >
          <MessageSquare size={13} />
          Abrir
        </Link>
        <button
          onClick={onRetomar}
          disabled={retomando}
          title="Devolve esta conversa ao agente. As outras nao mudam."
          className="inline-flex items-center gap-1.5 rounded-lg border border-navy-800 px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300 disabled:opacity-50"
        >
          {retomando ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <PlayCircle size={13} />
          )}
          Retomar
        </button>
      </div>
    </div>
  );
}
