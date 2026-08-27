'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Bot,
  Loader2,
  MessageSquare,
  Mic,
  Image as ImageIcon,
  PlayCircle,
  Search,
  Send,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  User,
  UserCog,
} from 'lucide-react';
import { BrandLockup } from '@/components/Brand';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import { motivoLegivel } from '@/lib/pausa';
import {
  api,
  conversationsApi,
  type ConversationDetail,
  type ConversationMessage,
  type ConversationSummary,
} from '@/lib/api';

const STATUS_LABEL: Record<string, { texto: string; cor: string }> = {
  WAITING_MESSAGES: { texto: 'Recebendo', cor: 'bg-gold-500/15 text-gold-300' },
  READY_TO_PROCESS: { texto: 'Na fila', cor: 'bg-gold-500/15 text-gold-300' },
  PROCESSING: { texto: 'Respondendo', cor: 'bg-sky-400/15 text-sky-300' },
  WAITING_USER: { texto: 'Aguardando contato', cor: 'bg-emerald-400/15 text-emerald-300' },
  PAUSED: { texto: 'Pausada', cor: 'bg-amber-400/15 text-amber-300' },
  BOT_LOOP_DETECTED: { texto: 'Loop detectado', cor: 'bg-red-400/15 text-red-300' },
  CLOSED: { texto: 'Encerrada', cor: 'bg-navy-800 text-muted' },
};

/**
 * O WhatsApp endereca muitos chats por LID (`1234@lid`), que NAO e o telefone.
 * O numero real chega junto das mensagens e fica gravado (ver
 * backend/src/whatsapp/lid.resolver.js), entao `numero` costuma estar
 * preenchido mesmo nesses chats.
 *
 * O caso `isLid` sobra para quando o telefone ainda nao apareceu — e ai vale
 * dizer "identificador" em vez de formatar o LID como se fosse um telefone.
 */
const identificacao = (c: ConversationSummary) =>
  c.numero ?? (c.isLid ? `ID ${c.identificador}` : c.chatId);

const dataHora = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export default function ConversasPage() {
  const { status: authStatus, signOut, user } = useAuth({ requireAuth: true });
  const { socket } = useSocket();

  const [lista, setLista] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [busca, setBusca] = useState('');
  const [carregando, setCarregando] = useState(true);

  const [canais, setCanais] = useState<{ id: string; label: string; phone: string | null }[]>([]);
  const [canalFiltro, setCanalFiltro] = useState<string>('');

  const [selecionada, setSelecionada] = useState<ConversationSummary | null>(null);
  const [detalhe, setDetalhe] = useState<ConversationDetail | null>(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);
  const [rascunho, setRascunho] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erroEnvio, setErroEnvio] = useState<string | null>(null);
  const [alternandoAgente, setAlternandoAgente] = useState(false);
  /** Enviar assume o atendimento? Fica ligado; desligar serve para so complementar. */
  const [assumirAoEnviar, setAssumirAoEnviar] = useState(true);

  const carregarRef = useRef<(() => void) | null>(null);

  /** Reflete na lista o que mudou numa conversa, sem recarregar tudo do servidor. */
  const aplicarNaLista = useCallback(
    (channelId: string, chatId: string, mudancas: Partial<ConversationSummary>) => {
      setLista((prev) =>
        prev.map((c) => (c.channelId === channelId && c.chatId === chatId ? { ...c, ...mudancas } : c))
      );
    },
    []
  );

  const carregar = useCallback(async (q?: string, channelId?: string) => {
    setCarregando(true);
    try {
      const r = await conversationsApi.list({ q, channelId, limit: 100 });
      setLista(r.conversations);
      setTotal(r.total);
    } catch {
      setLista([]);
    } finally {
      setCarregando(false);
    }
  }, []);

  /**
   * Carga inicial e busca no mesmo efeito.
   * Com `busca` vazia no primeiro render, isto ja faz a carga inicial - e como
   * roda dentro de um setTimeout, nao ha setState sincrono dentro do efeito.
   * O atraso tambem evita uma consulta por tecla digitada.
   */
  useEffect(() => {
    const timer = setTimeout(
      () => carregar(busca || undefined, canalFiltro || undefined),
      busca ? 350 : 0
    );
    return () => clearTimeout(timer);
  }, [busca, canalFiltro, carregar]);

  /**
   * Abre direto a conversa apontada pela URL (`/conversas?canal=..&chat=..`).
   *
   * E o link que sai da lista de conversas pausadas, no painel de conexoes:
   * sem isto, quem clicava caia na lista geral e tinha de procurar a pessoa de
   * novo — justamente a busca que o link deveria poupar.
   *
   * A leitura e de `window.location`, e nao de `useSearchParams`, para nao
   * exigir um limite de Suspense em volta da pagina inteira (ver
   * next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md).
   * O efeito roda so no cliente, onde `window` existe.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const canal = params.get('canal');
    const chat = params.get('chat');
    if (!canal || !chat) return;

    let cancelado = false;

    // A conversa e a lista chegam juntas: `selecionada` e `detalhe` sao
    // preenchidos de uma vez quando a resposta volta, sem estado de carga
    // proprio — que exigiria um setState sincrono dentro do efeito.
    conversationsApi
      .detail(canal, chat)
      .then((d) => {
        if (cancelado || !d.conversa) return;
        setSelecionada(d.conversa);
        setDetalhe(d);
      })
      .catch(() => {});

    return () => {
      cancelado = true;
    };
  }, []);

  // Os numeros conectados viram as abas de segmentacao.
  useEffect(() => {
    api
      .channels()
      .then((r) =>
        setCanais(
          r.channels.map((c) => ({ id: c.id, label: c.label, phone: c.phoneFormatted ?? null }))
        )
      )
      .catch(() => setCanais([]));
  }, []);

  /**
   * Tempo real: mensagem nova entra na conversa aberta na hora, e a lista
   * reordena. Sem isto era preciso trocar de conversa para ver o que chegou.
   */
  useEffect(() => {
    if (!socket) return;

    const onMensagem = (payload: {
      channelId: string;
      chatId: string;
      pushName?: string;
      mensagem: ConversationMessage;
    }) => {
      // So anexa se for a conversa que esta aberta na tela.
      setSelecionada((atual) => {
        if (atual && atual.channelId === payload.channelId && atual.chatId === payload.chatId) {
          setDetalhe((d) =>
            d && !d.mensagens.some((m) => m.id === payload.mensagem.id)
              ? { ...d, mensagens: [...d.mensagens, payload.mensagem] }
              : d
          );
        }
        return atual;
      });

      // A lista sempre reflete o movimento, mesmo em conversa nao aberta.
      setLista((prev) => {
        const i = prev.findIndex(
          (c) => c.channelId === payload.channelId && c.chatId === payload.chatId
        );
        if (i === -1) {
          // Conversa nova: recarrega para trazer o registro completo.
          carregarRef.current?.();
          return prev;
        }
        const atualizada = {
          ...prev[i],
          mensagens: prev[i].mensagens + 1,
          nome: prev[i].nome || payload.pushName || null,
          updatedAt: payload.mensagem.em,
        };
        return [atualizada, ...prev.filter((_, j) => j !== i)];
      });
    };

    const onAtualizacao = (payload: {
      channelId: string;
      chatId: string;
      status?: string;
      pausedReason?: string;
    }) => {
      setSelecionada((c) =>
        c && c.channelId === payload.channelId && c.chatId === payload.chatId
          ? { ...c, status: payload.status ?? c.status, pausedReason: payload.pausedReason ?? null }
          : c
      );
      setLista((prev) =>
        prev.map((c) =>
          c.channelId === payload.channelId && c.chatId === payload.chatId
            ? { ...c, status: payload.status ?? c.status }
            : c
        )
      );
    };

    socket.on('conversation:message', onMensagem);
    socket.on('conversation:update', onAtualizacao);

    return () => {
      socket.off('conversation:message', onMensagem);
      socket.off('conversation:update', onAtualizacao);
    };
  }, [socket]);

  useEffect(() => {
    carregarRef.current = () => carregar(busca || undefined, canalFiltro || undefined);
  }, [carregar, busca, canalFiltro]);

  const abrir = async (conversa: ConversationSummary) => {
    setSelecionada(conversa);
    setDetalhe(null);
    setConfirmandoExclusao(false);
    setRascunho('');
    setErroEnvio(null);
    setCarregandoDetalhe(true);
    try {
      setDetalhe(await conversationsApi.detail(conversa.channelId, conversa.chatId));
    } finally {
      setCarregandoDetalhe(false);
    }
  };

  /**
   * O atendente escreve pelo painel. Por padrao o agente e pausado nessa
   * conversa: pessoa e agente respondendo juntos confunde o contato.
   */
  const enviar = async () => {
    const texto = rascunho.trim();
    if (!texto || !selecionada || enviando) return;

    setEnviando(true);
    setErroEnvio(null);
    try {
      const r = await conversationsApi.send(
        selecionada.channelId,
        selecionada.chatId,
        texto,
        assumirAoEnviar
      );
      setRascunho('');
      setDetalhe((d) => (d ? { ...d, mensagens: [...d.mensagens, r.mensagem] } : d));
      if (r.agentePausado) {
        setSelecionada((c) => (c ? { ...c, status: 'PAUSED', pausedReason: 'atendimento_humano' } : c));
      }
      carregar(busca || undefined, canalFiltro || undefined);
    } catch (err) {
      setErroEnvio(err instanceof Error ? err.message : 'Nao foi possivel enviar');
    } finally {
      setEnviando(false);
    }
  };

  /**
   * Liga e desliga o agente NESTA conversa.
   *
   * O interruptor do canal, em Conexoes, vale para todo mundo que escreve
   * naquele numero. Este vale para uma pessoa so — e e o que a equipe precisa
   * no dia a dia: assumir um atendimento sem tirar o agente dos outros.
   */
  const alternarAgente = async (ativar: boolean) => {
    if (!selecionada || alternandoAgente) return;

    setAlternandoAgente(true);
    setErroEnvio(null);

    // O estado muda na hora: um interruptor que so reage depois da resposta do
    // servidor faz a pessoa clicar de novo achando que falhou.
    const anterior = { status: selecionada.status, pausedReason: selecionada.pausedReason };
    const otimista = ativar
      ? { status: 'WAITING_USER', pausedReason: null }
      : { status: 'PAUSED', pausedReason: 'atendimento_humano' };

    setSelecionada((c) => (c ? { ...c, ...otimista } : c));
    aplicarNaLista(selecionada.channelId, selecionada.chatId, otimista);

    try {
      const acao = ativar ? conversationsApi.resume : conversationsApi.pause;
      await acao(selecionada.channelId, selecionada.chatId);
    } catch (err) {
      // Volta ao que era: deixar o interruptor mentindo sobre quem atende e
      // pior do que nao ter interruptor.
      setSelecionada((c) => (c ? { ...c, ...anterior } : c));
      aplicarNaLista(selecionada.channelId, selecionada.chatId, anterior);
      setErroEnvio(err instanceof Error ? err.message : 'Nao foi possivel alterar o agente.');
    } finally {
      setAlternandoAgente(false);
    }
  };

  const devolverAoAgente = () => alternarAgente(true);

  const excluir = async () => {
    if (!selecionada) return;
    await conversationsApi.remove(selecionada.channelId, selecionada.chatId).catch(() => null);
    setSelecionada(null);
    setDetalhe(null);
    setConfirmandoExclusao(false);
    carregar(busca || undefined, canalFiltro || undefined);
  };

  if (authStatus !== 'authenticated') {
    return (
      <main className="grid min-h-screen place-items-center bg-navy-950">
        <Loader2 className="h-6 w-6 animate-spin text-gold-400" />
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-navy-950">
      <header className="sticky top-0 z-20 border-b border-navy-800 bg-navy-900/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3.5">
          <BrandLockup compact />
          <div className="flex items-center gap-3">
            <Link
              href="/connections"
              className="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-cream"
            >
              <ArrowLeft size={14} />
              Conexoes
            </Link>
            <span className="hidden max-w-[12rem] truncate border-l border-navy-800 pl-3 text-xs text-muted sm:inline">
              {user?.name || user?.email}
            </span>
            <button onClick={signOut} className="text-xs text-muted hover:text-red-400">
              Sair
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6">
          <h1 className="font-display text-[26px] tracking-wide text-cream">Conversas</h1>
          <p className="mt-2 text-sm text-muted">
            {total} conversa{total === 1 ? '' : 's'} registrada{total === 1 ? '' : 's'}. Acompanhe o
            atendimento e audite como o agente respondeu.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
          {/* ------------------------------- lista */}
          <section className="flex flex-col rounded-2xl border border-navy-800 bg-navy-900">
            {/* Segmentacao por numero: cada aba e um WhatsApp do escritorio. */}
            {canais.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-b border-navy-800 p-3 pb-2">
                <AbaCanal ativa={!canalFiltro} onClick={() => setCanalFiltro('')}>
                  Todos
                </AbaCanal>
                {canais.map((c) => (
                  <AbaCanal
                    key={c.id}
                    ativa={canalFiltro === c.id}
                    onClick={() => setCanalFiltro(c.id)}
                    title={c.phone ?? 'nao conectado'}
                  >
                    {c.label}
                  </AbaCanal>
                ))}
              </div>
            )}

            <div className="border-b border-navy-800 p-3">
              <div className="relative">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Buscar por nome ou numero"
                  className="w-full rounded-lg border border-navy-800 bg-navy-950 py-2 pl-9 pr-3 text-sm text-cream outline-none transition-colors focus:border-gold-500/60"
                />
              </div>
            </div>

            <div className="scrollbar-thin max-h-[34rem] flex-1 divide-y divide-navy-800 overflow-y-auto">
              {carregando ? (
                <div className="grid place-items-center py-16">
                  <Loader2 className="h-5 w-5 animate-spin text-gold-400" />
                </div>
              ) : lista.length === 0 ? (
                <p className="px-4 py-16 text-center text-sm text-muted">
                  {busca ? 'Nada encontrado.' : 'Nenhuma conversa ainda.'}
                </p>
              ) : (
                lista.map((c) => {
                  const status = STATUS_LABEL[c.status] ?? {
                    texto: c.status,
                    cor: 'bg-navy-800 text-muted',
                  };
                  const ativa = selecionada?.chatId === c.chatId;

                  return (
                    <button
                      key={c.id}
                      onClick={() => abrir(c)}
                      className={`flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors ${
                        ativa ? 'bg-navy-800/70' : 'hover:bg-navy-800/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {/*
                            Quem responde esta pessoa, de relance. Sem isto, so
                            se descobre abrindo a conversa — e uma carteira com
                            dez atendimentos assumidos vira dez cliques para
                            saber quais o agente ainda cobre.
                          */}
                          {c.status === 'PAUSED' || c.status === 'BOT_LOOP_DETECTED' ? (
                            <UserCog
                              size={12}
                              className="shrink-0 text-amber-300"
                              aria-label="Você responde esta pessoa"
                            />
                          ) : (
                            <Bot
                              size={12}
                              className="shrink-0 text-emerald-400/70"
                              aria-label="O agente responde esta pessoa"
                            />
                          )}
                          <span className="truncate text-sm font-medium text-cream">
                            {c.nome || identificacao(c)}
                          </span>
                        </span>
                        <span className="shrink-0 text-[10px] text-navy-600">
                          {dataHora(c.updatedAt)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted">
                        <span className={c.numero ? '' : 'text-navy-600'}>{identificacao(c)}</span>
                        <span className="text-navy-600">·</span>
                        <span>{c.mensagens} msg</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${status.cor}`}>
                          {status.texto}
                        </span>
                        {c.handoff && (
                          <span className="rounded bg-orange-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                            handoff
                          </span>
                        )}
                        {c.possibleBot && (
                          <span className="rounded bg-red-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                            bot?
                          </span>
                        )}
                        {c.tipoCaso && (
                          <span className="truncate rounded bg-navy-800 px-1.5 py-0.5 text-[10px] text-muted">
                            {c.tipoCaso.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* ------------------------------- detalhe */}
          <section className="rounded-2xl border border-navy-800 bg-navy-900">
            {!selecionada ? (
              <div className="grid h-full min-h-[26rem] place-items-center p-10 text-center">
                <div>
                  <MessageSquare className="mx-auto mb-3 h-8 w-8 text-navy-700" />
                  <p className="text-sm text-muted">Escolha uma conversa para ver o historico.</p>
                </div>
              </div>
            ) : (
              <>
                <header className="flex flex-wrap items-start justify-between gap-3 border-b border-navy-800 px-5 py-4">
                  <div className="min-w-0">
                    <h2 className="truncate font-display text-lg tracking-wide text-cream">
                      {selecionada.nome || identificacao(selecionada)}
                    </h2>
                    <p className="mt-0.5 text-xs tabular-nums text-muted">
                      {identificacao(selecionada)} · {selecionada.channelLabel}
                      {selecionada.agentId && ` · ${selecionada.agentId}`}
                    </p>
                    {selecionada.isLid && (
                      <InformarNumero
                        conversa={selecionada}
                        aoDefinir={(atualizada) => {
                          setSelecionada(atualizada);
                          carregar(busca || undefined, canalFiltro || undefined);
                        }}
                      />
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <InterruptorDoAgente
                      conversa={selecionada}
                      ocupado={alternandoAgente}
                      aoAlternar={alternarAgente}
                    />

                    {confirmandoExclusao ? (
                      <>
                        <span className="text-xs text-red-300">Excluir tudo?</span>
                        <button
                          onClick={excluir}
                          className="rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-500"
                        >
                          Confirmar
                        </button>
                        <button
                          onClick={() => setConfirmandoExclusao(false)}
                          className="rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted hover:text-cream"
                        >
                          Cancelar
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmandoExclusao(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted transition-colors hover:border-red-400/40 hover:text-red-400"
                      >
                        <Trash2 size={13} />
                        Excluir conversa
                      </button>
                    )}
                  </div>
                </header>

                {carregandoDetalhe ? (
                  <div className="grid place-items-center py-24">
                    <Loader2 className="h-5 w-5 animate-spin text-gold-400" />
                  </div>
                ) : (
                  <>
                    {(detalhe?.resumoRolante || detalhe?.ontologia?.slots) && (
                      <div className="border-b border-navy-800 bg-navy-950/40 px-5 py-3">
                        {detalhe?.resumoRolante && (
                          <p className="text-xs leading-relaxed text-muted">
                            <span className="font-semibold text-gold-300">Resumo: </span>
                            {detalhe.resumoRolante}
                          </p>
                        )}
                        {detalhe?.ontologia?.slots && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {Object.entries(detalhe.ontologia.slots)
                              .filter(([, v]) => v !== null && v !== '')
                              .map(([k, v]) => (
                                <span
                                  key={k}
                                  className="rounded bg-navy-800 px-1.5 py-0.5 text-[10px] text-muted"
                                >
                                  <span className="text-navy-600">{k}:</span>{' '}
                                  {Array.isArray(v) ? v.join(', ') : String(v)}
                                </span>
                              ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="scrollbar-thin max-h-[26rem] space-y-3 overflow-y-auto p-5">
                      {detalhe?.mensagens.length ? (
                        detalhe.mensagens.map((m) => <Bolha key={m.id} m={m} />)
                      ) : (
                        <p className="py-10 text-center text-sm text-muted">
                          Nenhuma mensagem registrada.
                        </p>
                      )}
                    </div>

                    {/* ---- intervencao do atendente ---- */}
                    <div className="border-t border-navy-800 p-4">
                      {selecionada.status === 'PAUSED' ||
                      selecionada.status === 'BOT_LOOP_DETECTED' ? (
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2">
                          <span className="text-[11px] text-amber-200">
                            Você responde esta pessoa
                            {selecionada.pausedReason
                              ? ` — ${motivoLegivel(selecionada.pausedReason)}`
                              : ''}
                            . As outras conversas seguem com o agente.
                          </span>
                          <button
                            onClick={devolverAoAgente}
                            disabled={alternandoAgente}
                            className="inline-flex items-center gap-1.5 rounded-md border border-navy-700 px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-emerald-400/40 hover:text-emerald-300 disabled:opacity-50"
                          >
                            <PlayCircle size={12} />
                            Devolver ao agente
                          </button>
                        </div>
                      ) : (
                        /*
                         * Assumir ao enviar e o comportamento certo por padrao —
                         * pessoa e agente respondendo juntos confunde o contato.
                         * Mas as vezes o atendente so quer complementar uma
                         * informacao e devolver a conversa; sem esta opcao ele
                         * teria de religar o agente logo depois, toda vez.
                         */
                        <label className="mb-2 flex cursor-pointer select-none items-center gap-2">
                          <input
                            type="checkbox"
                            checked={assumirAoEnviar}
                            onChange={(e) => setAssumirAoEnviar(e.target.checked)}
                            className="peer sr-only"
                          />
                          <span className="relative h-4 w-7 shrink-0 rounded-full bg-navy-800 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-muted after:transition-transform peer-checked:bg-amber-400/70 peer-checked:after:translate-x-3 peer-checked:after:bg-navy-950" />
                          <span className="text-[11px] text-muted">
                            {assumirAoEnviar
                              ? 'Ao enviar, você assume esta conversa e o agente para de responder.'
                              : 'Enviar sem assumir: o agente continua respondendo esta pessoa.'}
                          </span>
                        </label>
                      )}

                      {erroEnvio && (
                        <p className="mb-2 flex items-center gap-1.5 text-[11px] text-red-300">
                          <TriangleAlert size={12} />
                          {erroEnvio}
                        </p>
                      )}

                      <div className="flex items-end gap-2">
                        <textarea
                          value={rascunho}
                          onChange={(e) => setRascunho(e.target.value)}
                          onKeyDown={(e) => {
                            // Enter envia; Shift+Enter quebra linha.
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              enviar();
                            }
                          }}
                          rows={2}
                          maxLength={4000}
                          placeholder="Escreva como atendente..."
                          className="scrollbar-thin flex-1 resize-none rounded-xl border border-navy-800 bg-navy-950 px-3 py-2.5 text-sm text-cream outline-none transition-colors focus:border-gold-500/60"
                        />
                        <button
                          onClick={enviar}
                          disabled={enviando || !rascunho.trim()}
                          className="inline-flex h-[42px] items-center gap-2 rounded-xl bg-gradient-to-b from-gold-300 to-gold-500 px-4 text-sm font-semibold text-navy-950 transition-all hover:from-gold-200 hover:to-gold-400 disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          {enviando ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <Send size={15} />
                          )}
                          Enviar
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

/** Uma mensagem no histórico. Contato à esquerda, agente à direita. */
function Bolha({ m }: { m: ConversationMessage }) {
  const doAgente = m.direcao === 'out';
  // Mensagem escrita por pessoa do escritorio, nao pelo agente.
  const porPessoa = doAgente && m.autor === 'human';
  const hora = new Date(m.em).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const icone =
    m.tipo === 'audio' ? <Mic size={11} /> : m.tipo === 'image' ? <ImageIcon size={11} /> : null;

  return (
    <div className={`flex ${doAgente ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] ${doAgente ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
            !doAgente
              ? 'rounded-bl-sm bg-navy-800 text-cream'
              : porPessoa
                ? 'rounded-br-sm border border-sky-400/25 bg-sky-400/10 text-cream'
                : 'rounded-br-sm bg-gold-500/15 text-cream'
          }`}
        >
          {icone && (
            <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
              {icone}
              {m.tipo === 'audio' ? 'audio transcrito' : 'imagem'}
            </span>
          )}
          <p className="whitespace-pre-wrap">{m.texto || m.transcricao || m.descricaoImagem || '—'}</p>
          {m.legenda && (
            <p className="mt-1.5 border-t border-white/10 pt-1.5 text-xs text-muted">
              legenda: {m.legenda}
            </p>
          )}
          {m.erroMidia && (
            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-300">
              <TriangleAlert size={11} />
              midia nao processada
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 px-1 text-[10px] text-navy-600">
          {!doAgente ? (
            <User size={10} />
          ) : porPessoa ? (
            <UserCog size={10} className="text-sky-300" />
          ) : (
            <Bot size={10} />
          )}
          <span className="tabular-nums">{hora}</span>
          {porPessoa && (
            <span className="text-sky-300">{m.operador ? m.operador.split('@')[0] : 'atendente'}</span>
          )}
          {m.tier && <span className="text-gold-400/70">{m.tier}</span>}
          {m.tokens > 0 && <span className="tabular-nums">{m.tokens} tok</span>}
          {m.bloqueadoPor && (
            <span className="flex items-center gap-0.5 text-amber-400">
              <ShieldAlert size={10} />
              {m.bloqueadoPor}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Aba de segmentacao: cada numero do escritorio tem a sua. */
function AbaCanal({
  ativa,
  onClick,
  children,
  title,
}: {
  ativa: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
        ativa
          ? 'bg-gold-500/15 text-gold-300'
          : 'text-muted hover:bg-navy-800 hover:text-cream'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * INFORMAR O TELEFONE DE UM CHAT POR LID
 * --------------------------------------
 * O WhatsApp endereca alguns chats por um identificador opaco e nem sempre
 * revela o telefone por tras dele — `senderPn` nao vem em toda mensagem, o
 * evento de compartilhamento depende do contato, e a agenda so ajuda se a
 * pessoa estiver nela.
 *
 * Quando nenhuma fonte entrega, quem esta no painel consegue ver o numero no
 * proprio aplicativo. Digitar aqui e melhor do que a equipe conviver com um
 * "ID 40351318433948" que nao diz nada — e o vinculo passa a valer para este
 * contato em todos os numeros do escritorio, nao so nesta conversa.
 */
function InformarNumero({
  conversa,
  aoDefinir,
}: {
  conversa: ConversationSummary;
  aoDefinir: (conversa: ConversationSummary) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [telefone, setTelefone] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const salvar = async () => {
    setSalvando(true);
    setErro(null);
    try {
      const { conversa: atualizada } = await conversationsApi.definirNumero(
        conversa.channelId,
        conversa.chatId,
        telefone
      );
      aoDefinir(atualizada);
      setAberto(false);
      setTelefone('');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel salvar.');
    } finally {
      setSalvando(false);
    }
  };

  if (!aberto) {
    return (
      <p className="mt-1 text-[10px] leading-relaxed text-navy-600">
        O WhatsApp nao informou o telefone deste contato. Ele aparece sozinho assim que o
        aplicativo entregar o numero —{' '}
        <button
          onClick={() => setAberto(true)}
          className="text-gold-400/80 underline-offset-2 transition-colors hover:text-gold-300 hover:underline"
        >
          ou informe agora
        </button>
        .
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={telefone}
          onChange={(e) => setTelefone(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') salvar();
            if (e.key === 'Escape') setAberto(false);
          }}
          placeholder="(19) 99638-3884"
          className="w-44 rounded-lg border border-navy-700 bg-navy-900 px-2.5 py-1.5 text-xs tabular-nums text-cream placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none"
        />
        <button
          onClick={salvar}
          disabled={salvando || telefone.replace(/\D/g, '').length < 10}
          className="rounded-lg border border-gold-500/40 px-2.5 py-1.5 text-xs text-gold-200 transition-colors hover:border-gold-400 disabled:opacity-40"
        >
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
        <button
          onClick={() => setAberto(false)}
          className="px-1.5 py-1.5 text-xs text-muted transition-colors hover:text-cream"
        >
          Cancelar
        </button>
      </div>

      {erro ? (
        <p className="text-[10px] text-red-300">{erro}</p>
      ) : (
        <p className="text-[10px] text-navy-600">
          Como aparece no WhatsApp, com DDD. Vale para este contato em todos os numeros do
          escritorio.
        </p>
      )}
    </div>
  );
}

/**
 * O AGENTE ATENDE ESTA PESSOA?
 * ----------------------------
 * Interruptor por CONVERSA, sempre visivel no cabecalho.
 *
 * Ele ja existia, mas escondido: so aparecia depois que a conversa estava
 * pausada, num aviso pequeno acima da caixa de texto. Quem assumia um
 * atendimento e queria devolve-lo nao achava o caminho, e acabava no
 * interruptor de Conexoes — que desliga o agente para TODO MUNDO daquele
 * numero. O controle existia e a tela nao contava.
 *
 * O texto diz quem responde, nao o estado tecnico: "Voce atende" e o que
 * importa saber antes de digitar.
 */
function InterruptorDoAgente({
  conversa,
  ocupado,
  aoAlternar,
}: {
  conversa: ConversationSummary;
  ocupado: boolean;
  aoAlternar: (ativar: boolean) => void;
}) {
  const pausada = conversa.status === 'PAUSED' || conversa.status === 'BOT_LOOP_DETECTED';
  const ativo = !pausada;

  // Loop entre robos nao se desfaz sozinho: retomar precisa ser uma decisao.
  const porLoop = conversa.status === 'BOT_LOOP_DETECTED';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={ativo}
      disabled={ocupado}
      onClick={() => aoAlternar(pausada)}
      title={
        ativo
          ? 'O agente responde esta pessoa. Clique para assumir voce.'
          : 'Você responde esta pessoa. Clique para devolver ao agente.'
      }
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
        ativo
          ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-200 hover:border-emerald-400/60'
          : 'border-amber-400/30 bg-amber-400/[0.07] text-amber-200 hover:border-amber-400/60'
      }`}
    >
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors after:absolute after:top-0.5 after:h-3 after:w-3 after:rounded-full after:transition-transform ${
          ativo
            ? 'bg-emerald-400/70 after:left-0.5 after:translate-x-3 after:bg-navy-950'
            : 'bg-navy-700 after:left-0.5 after:bg-muted'
        }`}
      />
      {ocupado ? (
        <Loader2 size={12} className="animate-spin" />
      ) : ativo ? (
        <Bot size={13} />
      ) : (
        <UserCog size={13} />
      )}
      <span className="whitespace-nowrap font-medium">
        {ativo ? 'Agente atende' : porLoop ? 'Pausado (loop)' : 'Você atende'}
      </span>
    </button>
  );
}
