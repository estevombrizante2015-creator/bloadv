'use client';

import React, { useState, useSyncExternalStore } from 'react';
import {
  Bot,
  CheckCircle2,
  Loader2,
  LogOut,
  Power,
  QrCode,
  RefreshCw,
  X,
  Pencil,
  ScrollText,
  Smartphone,
  UserPlus,
  TriangleAlert,
  Users,
} from 'lucide-react';
import type { ChannelState } from '@/lib/api';

/**
 * Cores de STATUS sao semanticas e nao seguem a marca de proposito:
 * verde precisa significar conectado em qualquer painel. O dourado fica
 * reservado para identidade e acao primaria.
 */
const STATUS_META: Record<
  ChannelState['status'],
  { label: string; dot: string; text: string }
> = {
  connected: { label: 'Conectado', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  connecting: { label: 'Conectando', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400' },
  qr: { label: 'Aguardando leitura', dot: 'bg-gold-400 animate-pulse', text: 'text-gold-400' },
  disconnected: { label: 'Desconectado', dot: 'bg-navy-600', text: 'text-muted' },
  logged_out: { label: 'Sessao encerrada', dot: 'bg-orange-400', text: 'text-orange-400' },
  error: { label: 'Erro', dot: 'bg-red-400', text: 'text-red-400' },
};

const ROLE_META = {
  leads: { label: 'Novos casos', icon: ScrollText },
  clients: { label: 'Clientes', icon: Users },
} as const;

function formatPhone(raw: string | null) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const match = digits.match(/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/);
  if (!match) return `+${digits}`;
  return `+${match[1]} (${match[2]}) ${match[3]}-${match[4]}`;
}

/**
 * Relogio de 1s como fonte externa: e assim que o React quer que se leia
 * estado mutavel de fora (Date.now()), sem impureza no render.
 *
 * `noop` desliga a assinatura quando nao ha contagem em andamento. Antes o
 * intervalo rodava sempre, e um canal ja CONECTADO re-renderizava uma vez por
 * segundo para sempre - era isso que fazia o cartao "ficar atualizando".
 */
const subscribeToSecond = (onChange: () => void) => {
  const timer = setInterval(onChange, 1000);
  return () => clearInterval(timer);
};

const noop = () => () => {};

/** Contagem regressiva do QR: o Baileys troca o codigo a cada ~60s. */
function useCountdown(expiresAt: number | null) {
  const nowSeconds = useSyncExternalStore(
    expiresAt ? subscribeToSecond : noop,
    () => (expiresAt ? Math.floor(Date.now() / 1000) : 0),
    () => 0
  );

  if (!expiresAt || nowSeconds === 0) return null;
  return Math.max(0, Math.round(expiresAt / 1000 - nowSeconds));
}

interface Props {
  channel: ChannelState;
  busy?: boolean;
  /** Agentes que podem receber este numero (o inerte nao entra). */
  agents?: { id: string; label: string }[];
  onConnect: () => void;
  onDisconnect: () => void;
  onLogout: () => void;
  onToggleAgent: (enabled: boolean) => void;
  onRename?: (label: string) => void;
  onAssign?: (agentId: string) => void;
}

export default function ConnectionCard({
  channel,
  busy,
  agents = [],
  onConnect,
  onDisconnect,
  onLogout,
  onToggleAgent,
  onRename,
  onAssign,
}: Props) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(channel.label);
  const status = STATUS_META[channel.status] ?? STATUS_META.disconnected;
  const role = ROLE_META[channel.role];
  const RoleIcon = role.icon;
  const countdown = useCountdown(channel.status === 'qr' ? channel.qrExpiresAt : null);
  const agentEnabled = channel.agentEnabled !== false;

  // O agente nao e escolhido a mao: sai do numero pareado no QR.
  const boundAgent = channel.agent ?? null;
  const agentStandby = boundAgent?.status === 'standby';

  // Numero pareado que nao pertence a nenhum agente: conecta, mas nao responde.
  // Precisa gritar, senao o canal parece saudavel e o silencio vira misterio.
  const unassigned =
    channel.status === 'connected' && Boolean(channel.phoneNumber) && !boundAgent?.matchedByNumber;

  const commitName = () => {
    const value = draftName.trim();
    setEditingName(false);
    if (value && value !== channel.label) onRename?.(value);
    else setDraftName(channel.label);
  };

  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-navy-800 bg-navy-900 transition-colors hover:border-navy-700">
      {/* cabecalho */}
      <header className="flex items-start justify-between gap-3 border-b border-navy-800 px-5 py-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-gold-500/25 bg-gold-500/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-gold-300">
              <RoleIcon size={11} />
              {role.label}
            </span>
            <span className="font-mono text-[10px] text-navy-600">{channel.id}</span>
          </div>

          {editingName ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  setDraftName(channel.label);
                  setEditingName(false);
                }
              }}
              maxLength={60}
              className="w-full rounded-lg border border-gold-500/50 bg-navy-950 px-2 py-1 font-display text-[17px] tracking-wide text-cream outline-none"
            />
          ) : (
            <button
              onClick={() => {
                setDraftName(channel.label);
                setEditingName(true);
              }}
              title="Renomear"
              className="group/name flex w-full items-center gap-1.5 text-left"
            >
              <h3 className="truncate font-display text-[17px] tracking-wide text-cream">
                {channel.label}
              </h3>
              <Pencil
                size={12}
                className="shrink-0 text-navy-600 opacity-0 transition-opacity group-hover/name:opacity-100"
              />
            </button>
          )}
          <p className="truncate text-[13px] tabular-nums text-muted">
            {formatPhone(channel.phoneNumber) ?? 'Nenhum numero pareado'}
          </p>

          {unassigned ? (
            <div className="mt-2.5 rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-2.5 py-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
                <TriangleAlert size={12} />
                Numero nao atribuido
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                Conectado, mas sem agente responsavel — por isso ninguem responde.
              </p>
              {agents.length > 0 && onAssign && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => onAssign(agent.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-md border border-gold-500/30 bg-gold-500/10 px-2 py-1 text-[10px] font-semibold text-gold-200 transition-colors hover:bg-gold-500/20 disabled:opacity-40"
                    >
                      <UserPlus size={10} />
                      {agent.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : boundAgent ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  agentStandby
                    ? 'border border-amber-400/25 bg-amber-400/10 text-amber-300'
                    : 'border border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
                }`}
              >
                <Bot size={11} />
                {boundAgent.label}
                {agentStandby && ' · standby'}
              </span>
              <span
                className="text-[10px] text-navy-600"
                title={
                  boundAgent.matchedByNumber
                    ? 'Numero cadastrado: agente identificado automaticamente'
                    : 'Numero nao cadastrado: usando o agente padrao'
                }
              >
                {boundAgent.source === 'painel' ? 'atribuido no painel' : 'vinculo automatico'}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 pt-1">
          <span className={`h-2 w-2 rounded-full ${status.dot}`} />
          <span className={`text-xs font-medium ${status.text}`}>{status.label}</span>
        </div>
      </header>

      {/* area do QR / estado */}
      <div className="flex min-h-[17rem] flex-1 items-center justify-center bg-navy-950/60 p-6">
        {channel.status === 'qr' && channel.qr && (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-xl bg-cream p-3 shadow-lg shadow-navy-950/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={channel.qr} alt={`QR code de ${channel.label}`} className="h-44 w-44" />
            </div>
            <p className="max-w-[15rem] text-center text-[11px] leading-relaxed text-muted">
              WhatsApp no celular &rarr;{' '}
              <strong className="font-medium text-cream">Aparelhos conectados</strong> &rarr;
              Conectar um aparelho
            </p>
            <div className="flex items-center gap-2">
              {countdown !== null && (
                <span className="rounded-full border border-gold-500/25 bg-gold-500/[0.08] px-3 py-1 text-[11px] tabular-nums text-gold-300">
                  {countdown > 0 ? `Expira em ${countdown}s` : 'Gerando novo codigo'}
                </span>
              )}
              <button
                onClick={onDisconnect}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-full border border-navy-800 px-3 py-1 text-[11px] text-muted transition-colors hover:border-red-400/40 hover:text-red-400 disabled:opacity-40"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                Cancelar
              </button>
            </div>
          </div>
        )}

        {channel.status === 'connecting' && (
          <div className="flex flex-col items-center gap-4">
            {/* esqueleto do proprio QR: a area nao muda de tamanho quando ele chega */}
            <div className="relative h-[12.5rem] w-[12.5rem] overflow-hidden rounded-xl border border-navy-800 bg-navy-900">
              <div className="grid h-full w-full grid-cols-8 grid-rows-8 gap-1.5 p-4 opacity-40">
                {Array.from({ length: 64 }).map((_, i) => (
                  <span
                    key={i}
                    className="rounded-[2px] bg-navy-700"
                    style={{
                      animation: 'pulse 1.6s ease-in-out infinite',
                      animationDelay: `${((i % 8) + Math.floor(i / 8)) * 55}ms`,
                    }}
                  />
                ))}
              </div>
              {/* varredura dourada, indicando trabalho em andamento */}
              <div className="pointer-events-none absolute inset-0 animate-[shimmer_1.8s_linear_infinite] bg-gradient-to-b from-transparent via-gold-400/20 to-transparent" />
            </div>

            <div className="flex items-center gap-2 text-sm text-cream">
              <Loader2 size={15} className="animate-spin text-gold-400" />
              Abrindo sessao no WhatsApp
            </div>
            <p className="text-[11px] text-muted">O codigo aparece aqui em instantes</p>

            <button
              onClick={onDisconnect}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted transition-colors hover:border-red-400/40 hover:text-red-400 disabled:opacity-40"
            >
              <X size={13} />
              Cancelar
            </button>
          </div>
        )}

        {channel.status === 'connected' && (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-400/10">
              <CheckCircle2 className="h-8 w-8 text-emerald-400" />
            </div>
            <p className="font-display text-base tracking-wide text-cream">Numero conectado</p>
            {channel.pushName && <p className="text-xs text-muted">{channel.pushName}</p>}

            <dl className="mt-2 flex gap-6 text-center">
              <Stat label="Recebidas" value={channel.stats?.messagesIn ?? 0} />
              <Stat label="Enviadas" value={channel.stats?.messagesOut ?? 0} />
              <Stat
                label="Tokens"
                value={`${((channel.stats?.tokensUsed ?? 0) / 1000).toFixed(1)}k`}
              />
            </dl>
          </div>
        )}

        {(channel.status === 'disconnected' ||
          channel.status === 'logged_out' ||
          channel.status === 'error') && (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-navy-800 bg-navy-900">
              {channel.status === 'error' ? (
                <TriangleAlert className="h-6 w-6 text-red-400" />
              ) : (
                <Smartphone className="h-6 w-6 text-muted" />
              )}
            </div>
            <p className="text-sm text-cream">
              {channel.status === 'logged_out'
                ? 'A sessao foi encerrada no celular'
                : 'Nenhum aparelho pareado'}
            </p>
            {channel.lastError && (
              <p className="max-w-[15rem] text-[11px] text-red-400/90">{channel.lastError}</p>
            )}
            <button
              onClick={onConnect}
              disabled={busy}
              className="mt-2 inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-gold-300 to-gold-500 px-6 py-2.5 text-sm font-semibold text-navy-950 transition-all hover:from-gold-200 hover:to-gold-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <QrCode size={16} />}
              Gerar QR Code
            </button>
          </div>
        )}
      </div>

      {/* rodape com acoes */}
      <footer className="flex items-center justify-between gap-2 border-t border-navy-800 px-4 py-3">
        {/*
          Este interruptor vale para TODAS as conversas deste numero. Existe
          outro, por pessoa, em Conversas — e confundir os dois custa caro:
          desligar aqui para assumir um atendimento tira o agente de todo mundo.
          Por isso o rotulo diz o alcance, nao so o nome do agente.
        */}
        <label
          className="flex cursor-pointer select-none items-center gap-2"
          title="Vale para todas as conversas deste numero. Para uma pessoa so, use o interruptor em Conversas."
        >
          <input
            type="checkbox"
            checked={agentEnabled}
            onChange={(e) => onToggleAgent(e.target.checked)}
            className="peer sr-only"
          />
          <span className="relative h-5 w-9 rounded-full bg-navy-800 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-muted after:transition-transform peer-checked:bg-gold-500 peer-checked:after:translate-x-4 peer-checked:after:bg-navy-950" />
          <span className="text-xs text-muted">
            {boundAgent ? (
              <>
                <strong className="font-medium text-cream">{boundAgent.label}</strong> em{' '}
                <strong className="font-medium text-cream">todas</strong> as conversas
              </>
            ) : (
              'Agente em todas as conversas'
            )}
          </span>
        </label>

        <div className="flex items-center gap-1">
          {channel.status === 'connected' && (
            <IconButton
              onClick={onDisconnect}
              disabled={busy}
              title="Desconectar sem apagar o pareamento"
            >
              <Power size={16} />
            </IconButton>
          )}

          {channel.hasCredentials && (
            <>
              <IconButton
                onClick={onConnect}
                disabled={busy || channel.status === 'connected'}
                title="Reconectar"
              >
                <RefreshCw size={16} />
              </IconButton>
              <IconButton
                onClick={onLogout}
                disabled={busy}
                title="Desparear e apagar credenciais"
                danger
              >
                <LogOut size={16} />
              </IconButton>
            </>
          )}
        </div>
      </footer>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dd className="text-lg font-semibold tabular-nums text-cream">{value}</dd>
      <dt className="text-[10px] uppercase tracking-[0.1em] text-muted">{label}</dt>
    </div>
  );
}

function IconButton({
  children,
  danger,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...props}
      className={`rounded-lg p-2 transition-colors disabled:opacity-30 ${
        danger
          ? 'text-red-400/80 hover:bg-red-500/10 hover:text-red-400'
          : 'text-muted hover:bg-navy-800 hover:text-cream'
      }`}
    >
      {children}
    </button>
  );
}
