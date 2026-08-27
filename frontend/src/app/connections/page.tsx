'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Bot,
  Loader2,
  LogOut,
  RefreshCw,
  MessagesSquare,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  TriangleAlert,
  X,
  Wifi,
  WifiOff,
} from 'lucide-react';
import ConnectionCard from '@/components/ConnectionCard';
import ConversasPausadas from '@/components/ConversasPausadas';
import SaudeNumeros, { resumoSaude } from '@/components/SaudeNumeros';
import { BrandLockup } from '@/components/Brand';
import { useChannels } from '@/hooks/useChannels';
import { useAuth } from '@/hooks/useAuth';
import {
  api,
  type AgentTier,
  type PausedConversation,
  type CustoOpenAI,
  type PipelineConfig,
  type RelatorioSaude,
  type UsageReport,
} from '@/lib/api';

export default function ConnectionsPage() {
  // Painel protegido: sem sessao valida, volta para o login.
  const { user, status: authStatus, signOut, retry } = useAuth({ requireAuth: true });

  const {
    channels,
    loading,
    error,
    busy,
    socketConnected,
    refresh,
    connect,
    disconnect,
    logout,
    toggleAgent,
    rename,
    assignAgent,
    dismissError,
  } = useChannels();

  const [tiers, setTiers] = useState<AgentTier[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [config, setConfig] = useState<PipelineConfig | null>(null);
  const [paused, setPaused] = useState<PausedConversation[]>([]);
  const [saude, setSaude] = useState<RelatorioSaude | null>(null);
  const [saudeCarregando, setSaudeCarregando] = useState(true);
  const [custo, setCusto] = useState<CustoOpenAI | null>(null);

  const loadCusto = useCallback((forcar = false) => {
    api
      .billing(forcar)
      .then(setCusto)
      .catch(() => setCusto(null));
  }, []);

  const loadPaused = useCallback(() => {
    api
      .pausedConversations()
      .then((r) => setPaused(r.conversations))
      .catch(() => setPaused([]));
  }, []);

  const loadSaude = useCallback(() => {
    api
      .health()
      .then(setSaude)
      .catch(() => setSaude(null))
      .finally(() => setSaudeCarregando(false));
  }, []);

  useEffect(() => {
    api.tiers().then((r) => setTiers(r.tiers)).catch(() => setTiers([]));
    api.usage().then(setUsage).catch(() => setUsage(null));
    api.config().then(setConfig).catch(() => setConfig(null));
    loadPaused();
    loadCusto();
  }, [loadPaused, loadCusto]);

  /**
   * A saude e agregada no banco (24h de mensagens, execucoes e guardrails), e
   * nao vem pelo socket: recalcular a cada `channel:update` faria a tela pagar
   * cinco agregacoes por QR piscando.
   *
   * O intervalo de 60s e o compromisso — quem esta olhando a tela ve a mudanca
   * em menos de um minuto, e quem deixou aberta o dia todo nao gera carga.
   * `status` na dependencia faz a leitura acontecer NA HORA quando um numero
   * conecta ou cai, que e justamente quando a resposta muda.
   */
  const statusDosCanais = channels.map((c) => `${c.id}:${c.status}`).join(',');

  useEffect(() => {
    loadSaude();
    const timer = setInterval(loadSaude, 60_000);
    return () => clearInterval(timer);
  }, [loadSaude, statusDosCanais]);

  const resume = async (channelId: string, chatId: string) => {
    await api.resumeConversation(channelId, chatId).catch(() => null);
    loadPaused();
    loadSaude(); // conversa retomada sai do sinal de "conversas pausadas"
  };

  const connected = channels.filter((c) => c.status === 'connected').length;
  const savedTokens = usage?.byTier.reduce((acc, t) => acc + (t.saved ?? 0), 0) ?? 0;
  const usedTokens = usage?.byTier.reduce((acc, t) => acc + (t.tokens ?? 0), 0) ?? 0;

  // Servidor fora do ar NAO desloga: a sessao continua e o painel espera.
  if (authStatus === 'offline') {
    return (
      <main className="grid min-h-screen place-items-center bg-navy-950 px-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-amber-400/25 bg-amber-400/10">
            <WifiOff className="h-6 w-6 text-amber-400" />
          </div>
          <h1 className="font-display text-xl tracking-wide text-cream">Servidor indisponivel</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Sua sessao continua valida. Assim que o servidor responder, o painel volta sozinho.
          </p>
          <button
            onClick={retry}
            className="mt-6 inline-flex items-center gap-2 rounded-xl border border-navy-800 px-5 py-2.5 text-sm text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300"
          >
            <RefreshCw size={15} />
            Tentar agora
          </button>
        </div>
      </main>
    );
  }

  if (authStatus !== 'authenticated') {
    return (
      <main className="grid min-h-screen place-items-center bg-navy-950">
        <Loader2 className="h-6 w-6 animate-spin text-gold-400" />
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-navy-950">
      {/* ------------------------------------------------ barra superior */}
      <header className="sticky top-0 z-20 border-b border-navy-800 bg-navy-900/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3.5">
          <BrandLockup compact />

          <div className="flex items-center gap-2">
            <span
              className={`hidden items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium sm:inline-flex ${
                socketConnected
                  ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
                  : 'border-red-400/25 bg-red-400/10 text-red-300'
              }`}
            >
              {socketConnected ? <Wifi size={13} /> : <WifiOff size={13} />}
              {socketConnected ? 'Servidor online' : 'Servidor offline'}
            </span>

            <Link
              href="/conversas"
              className="inline-flex items-center gap-1.5 rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300"
            >
              <MessagesSquare size={14} />
              Conversas
            </Link>

            <Link
              href="/clientes"
              className="inline-flex items-center gap-1.5 rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300"
            >
              <Users size={14} />
              Clientes
            </Link>

            <Link
              href="/curadoria"
              className="inline-flex items-center gap-1.5 rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300"
            >
              <SlidersHorizontal size={14} />
              Curadoria
            </Link>

            <button
              onClick={() => {
                refresh();
                loadSaude();
                loadCusto(true); // botao explicito pula o cache de 5 min
              }}
              title="Atualizar"
              className="rounded-lg border border-navy-800 p-2 text-muted transition-colors hover:border-navy-700 hover:text-cream"
            >
              <RefreshCw size={15} />
            </button>

            <div className="ml-1 flex items-center gap-2 border-l border-navy-800 pl-3">
              <span className="hidden max-w-[12rem] truncate text-xs text-muted sm:inline">
                {user?.name || user?.email}
              </span>
              <button
                onClick={signOut}
                title="Sair"
                className="rounded-lg border border-navy-800 p-2 text-muted transition-colors hover:border-red-400/40 hover:text-red-400"
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-[26px] tracking-wide text-cream">
            Conexoes de WhatsApp
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Dois numeros para o atendimento inicial de quem procura o escritorio e um para
            clientes com caso em andamento. O pareamento e feito lendo o QR no aplicativo.
          </p>
        </div>

        {/*
          Aviso flutuante, fora do fluxo do documento. Como banner acima da grade
          ele empurrava todos os cards a cada clique - era isso que "piscava".
        */}
        {error && (
          <div
            role="alert"
            className="fixed bottom-6 left-1/2 z-30 flex max-w-[calc(100vw-3rem)] -translate-x-1/2 items-start gap-2.5 rounded-xl border border-red-400/30 bg-navy-900 px-4 py-3 text-sm text-red-300 shadow-xl shadow-navy-950/60"
          >
            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
            <button
              onClick={dismissError}
              aria-label="Fechar aviso"
              className="ml-2 shrink-0 rounded p-0.5 text-muted transition-colors hover:text-cream"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* resumo */}
        <section className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {/*
            "2/3 conectados" nunca foi a resposta completa: numero conectado
            sem agente atribuido conta como conectado e nao atende ninguem. O
            resumo de saude vai junto, no mesmo cartao, para as duas leituras
            nunca serem feitas em telas diferentes.
          */}
          <Stat
            label="Numeros conectados"
            value={`${connected}/3`}
            hint={saude ? resumoSaude(saude) : undefined}
          />
          <Stat label="Tokens usados (24h)" value={usedTokens.toLocaleString('pt-BR')} />
          <CartaoCusto custo={custo} />
          <Stat
            label="Tokens poupados"
            value={savedTokens.toLocaleString('pt-BR')}
            hint="pela ontologia"
            accent
          />
          <Stat label="Repasses ao advogado" value={String(usage?.handoffs ?? 0)} />
          <Stat
            label="Conversas pausadas"
            value={String(paused.length)}
            // "loop ou handoff" nao dizia o que fazer. O numero aqui e uma
            // fila: sao pessoas que so recebem resposta se alguem responder.
            hint={paused.length ? 'esperando uma pessoa responder' : undefined}
          />
        </section>

        {/* cards dos canais */}
        {loading ? (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[27rem] animate-pulse rounded-2xl border border-navy-800 bg-navy-900"
              />
            ))}
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {channels.map((channel) => (
              <ConnectionCard
                key={channel.id}
                channel={channel}
                busy={busy[channel.id]}
                onConnect={() => connect(channel.id)}
                onDisconnect={() => disconnect(channel.id)}
                onLogout={() => logout(channel.id)}
                onToggleAgent={(enabled) => toggleAgent(channel.id, enabled)}
                onRename={(label) => rename(channel.id, label)}
                onAssign={(agentId) => assignAgent(channel.id, agentId)}
                agents={config?.agents.map((a) => ({ id: a.id, label: a.label })) ?? []}
              />
            ))}
          </div>
        )}

        {/* saude: o cartao acima diz se conectou; esta secao diz se atende */}
        <SaudeNumeros relatorio={saude} carregando={saudeCarregando} />

        {/* agentes configurados */}
        {config && config.agents.length > 0 && (
          <Section icon={<Bot size={15} />} title="Agentes e numeros">
            <div className="grid gap-3 md:grid-cols-2">
              {config.agents.map((agent) => (
                <div key={agent.id} className="rounded-xl border border-navy-800 bg-navy-900 p-4">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="font-display text-[15px] tracking-wide text-cream">
                      {agent.label}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ${
                        agent.status === 'active'
                          ? 'bg-emerald-400/15 text-emerald-300'
                          : 'bg-amber-400/15 text-amber-300'
                      }`}
                    >
                      {agent.status === 'active' ? 'ativo' : agent.status}
                    </span>
                  </div>
                  <p className="mb-3 text-xs leading-relaxed text-muted">{agent.description}</p>
                  {agent.numbers.length ? (
                    <ul className="space-y-1">
                      {agent.numbers.map((n) => (
                        <li key={n} className="font-mono text-[11px] tabular-nums text-gold-300">
                          {n}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] italic text-navy-600">
                      Nenhum numero atribuido ainda
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-navy-600">
              O vinculo numero &rarr; agente e resolvido na leitura do QR e fica persistido. Para
              adicionar um numero, inclua-o na lista do agente em{' '}
              <code className="font-mono text-muted">agents.config.js</code>.
            </p>
          </Section>
        )}

        {/* conversas pausadas */}
        {paused.length > 0 && (
          <Section icon={<TriangleAlert size={15} />} title="Conversas pausadas">
            <ConversasPausadas
              conversas={paused}
              canais={channels.map((c) => ({ id: c.id, label: c.label }))}
              onRetomar={resume}
            />
          </Section>
        )}

        {/* tiers */}
        {tiers.length > 0 && (
          <Section title="Tiers do agente">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {tiers.map((tier) => (
                <div key={tier.key} className="rounded-xl border border-navy-800 bg-navy-900 p-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="font-display text-[15px] tracking-wide text-cream">
                      {tier.label}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${
                        tier.userFacing
                          ? 'border-gold-500/25 bg-gold-500/10 text-gold-300'
                          : 'border-navy-700 text-muted'
                      }`}
                    >
                      {tier.userFacing ? 'conversa' : 'interno'}
                    </span>
                  </div>
                  <p className="mb-2 font-mono text-[11px] text-navy-600">{tier.model}</p>
                  <p className="text-xs leading-relaxed text-muted">{tier.description}</p>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* guardrails */}
        {usage && usage.guardrails.length > 0 && (
          <Section icon={<ShieldCheck size={15} />} title="Guardrails acionados (24h)">
            <div className="divide-y divide-navy-800 overflow-hidden rounded-xl border border-navy-800 bg-navy-900">
              {usage.guardrails.slice(0, 8).map((g) => (
                <div
                  key={`${g._id.stage}-${g._id.rule}`}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        g._id.stage === 'input'
                          ? 'bg-gold-500/10 text-gold-300'
                          : 'bg-amber-400/10 text-amber-300'
                      }`}
                    >
                      {g._id.stage === 'input' ? 'entrada' : 'saida'}
                    </span>
                    <span className="truncate font-mono text-xs text-muted">{g._id.rule}</span>
                  </span>
                  <span className="font-semibold tabular-nums text-cream">{g.count}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* parametros operacionais */}
        {config && (
          <section className="mt-10 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Param label="Janela do buffer" value={`${config.buffer.windowMs / 1000}s de silencio`} />
            <Param label="Transcricao de audio" value={config.media.whisperModel} />
            <Param label="Leitura de imagem" value={config.media.visionModel} />
            <Param
              label="Base de conhecimento"
              value={config.knowledgeBackend === 'mongo' ? 'busca semantica' : 'verbetes locais'}
            />
            {config.expediente && (
              <Param
                label="Horario de atendimento"
                value={`${config.expediente.inicio}–${config.expediente.fim} · seg a sex`}
                estado={
                  config.expediente.agora.dentro
                    ? { texto: `aberto agora (${config.expediente.agora.hora})`, ok: true }
                    : { texto: `fechado (${config.expediente.agora.hora})`, ok: false }
                }
              />
            )}
          </section>
        )}

        <p className="mt-10 max-w-2xl text-[11px] leading-relaxed text-navy-600">
          As credenciais de cada numero ficam em{' '}
          <code className="font-mono text-muted">backend/sessions/</code>, fora do controle de
          versao. Desparear apaga esses arquivos e exige nova leitura de QR.
        </p>
      </main>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * CUSTO DA CONTA OPENAI
 * ---------------------
 * Token e uma grandeza que ninguem transforma em decisao. O que o escritorio
 * precisa saber e quanto ja gastou no mes — por isso o valor grande e o do
 * mes, com o dia como apoio.
 *
 * Quando a leitura nao esta disponivel, o cartao mostra O MOTIVO em vez de um
 * traco. Em numero de dinheiro, "nao sei" com explicacao mantem a confianca;
 * um traco sem explicacao faz duvidar do painel inteiro.
 */
function CartaoCusto({ custo }: { custo: CustoOpenAI | null }) {
  const moeda = (valor?: number) =>
    typeof valor === 'number'
      ? valor.toLocaleString('pt-BR', {
          style: 'currency',
          currency: (custo?.moeda || 'usd').toUpperCase(),
          minimumFractionDigits: 2,
        })
      : '—';

  if (!custo || !custo.ok) {
    return (
      <div className="rounded-xl border border-navy-800 bg-navy-900 px-4 py-3">
        <p className="text-[10px] uppercase tracking-[0.14em] text-muted">Custo OpenAI</p>
        <p className="mt-1 text-sm text-muted">Indisponivel</p>
        <p className="mt-1 text-[10px] leading-relaxed text-navy-600">
          {custo?.motivo ?? 'Sem resposta do servidor agora.'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-navy-800 bg-navy-900 px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted">Custo OpenAI (mes)</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-cream">{moeda(custo.custoMes)}</p>
      <p className="mt-0.5 text-[10px] tabular-nums text-navy-600">
        hoje {moeda(custo.custoHoje)}
        {custo.saldo?.disponivel
          ? ` · saldo ${moeda(custo.saldo.restante)}`
          : custo.doCache
            ? ' · leitura em cache'
            : ''}
      </p>
      {!custo.saldo?.disponivel && custo.saldo?.motivo && (
        <p className="mt-1 text-[10px] leading-relaxed text-navy-600" title={custo.saldo.motivo}>
          Saldo nao exposto pela OpenAI
        </p>
      )}
      {custo.aviso && <p className="mt-1 text-[10px] text-amber-300/80">{custo.aviso}</p>}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-navy-800 bg-navy-900 px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          accent ? 'text-gold-300' : 'text-cream'
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-navy-600">{hint}</p>}
    </div>
  );
}

function Param({
  label,
  value,
  estado,
}: {
  label: string;
  value: string;
  estado?: { texto: string; ok: boolean };
}) {
  return (
    <div className="rounded-xl border border-navy-800 bg-navy-900 px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-0.5 font-mono text-sm text-cream">{value}</p>
      {estado && (
        <p
          className={`mt-1 flex items-center gap-1.5 text-[10px] ${
            estado.ok ? 'text-emerald-300' : 'text-amber-300'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${estado.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          {estado.texto}
        </p>
      )}
    </div>
  );
}
