'use client';

import React from 'react';
import { Activity, CheckCircle2, CircleSlash, Loader2, TriangleAlert } from 'lucide-react';
import type { NivelSaude, RelatorioSaude, SaudeCanal, SinalSaude } from '@/lib/api';

/**
 * SAUDE DOS NUMEROS
 * -----------------
 * O cartao de conexao responde "conectou?" — e essa nunca foi a pergunta que
 * importa. Um numero pode estar conectado, verde, sem erro nenhum, e nao
 * responder ninguem: sem agente atribuido, com o interruptor desligado depois
 * de um atendimento manual, ou com todas as conversas pausadas.
 *
 * Esta secao responde "esta atendendo?". Cada numero mostra UM nivel e, junto,
 * o motivo e o que fazer — farol sem explicacao vira farol ignorado, e o
 * silencio de um numero e caro demais para depender de alguem desconfiar.
 */

const NIVEL: Record<
  NivelSaude,
  { borda: string; fundo: string; texto: string; ponto: string; Icone: typeof CheckCircle2 }
> = {
  critico: {
    borda: 'border-red-400/30',
    fundo: 'bg-red-400/[0.06]',
    texto: 'text-red-300',
    ponto: 'bg-red-400',
    Icone: TriangleAlert,
  },
  atencao: {
    borda: 'border-amber-400/30',
    fundo: 'bg-amber-400/[0.06]',
    texto: 'text-amber-300',
    ponto: 'bg-amber-400',
    Icone: TriangleAlert,
  },
  saudavel: {
    borda: 'border-emerald-400/25',
    fundo: 'bg-emerald-400/[0.05]',
    texto: 'text-emerald-300',
    ponto: 'bg-emerald-400',
    Icone: CheckCircle2,
  },
  inativo: {
    borda: 'border-navy-800',
    fundo: 'bg-navy-900',
    texto: 'text-muted',
    ponto: 'bg-navy-600',
    Icone: CircleSlash,
  },
};

/** "ha 3 h" diz mais que um horario quando a pergunta e "isso ainda esta valendo?". */
function desde(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'agora';
  const minutos = Math.floor(ms / 60_000);
  if (minutos < 60) return `ha ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 48) return `ha ${horas} h`;
  return `ha ${Math.floor(horas / 24)} dias`;
}

function duracao(ms: number | null): string {
  if (!ms || ms < 0) return '—';
  const minutos = Math.floor(ms / 60_000);
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 48) return `${horas} h`;
  return `${Math.floor(horas / 24)} dias`;
}

export function resumoSaude(relatorio: RelatorioSaude | null): string {
  if (!relatorio) return '—';
  const { critico, atencao, saudavel, inativo } = relatorio.resumo;
  const partes: string[] = [];
  if (critico) partes.push(`${critico} parado`);
  if (atencao) partes.push(`${atencao} com ressalva`);
  if (saudavel) partes.push(`${saudavel} atendendo`);
  if (!partes.length && inativo) partes.push(`${inativo} fora de operacao`);
  return partes.join(' · ');
}

function Sinal({ sinal }: { sinal: SinalSaude }) {
  const cor = NIVEL[sinal.nivel];
  return (
    <li className="flex gap-2.5">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${cor.ponto}`} />
      <div className="min-w-0">
        <p className={`text-xs font-semibold ${cor.texto}`}>{sinal.titulo}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{sinal.detalhe}</p>
        {sinal.comoResolver && (
          <p className="mt-1 border-l-2 border-gold-500/30 pl-2.5 text-[11px] leading-relaxed text-parchment/70">
            {sinal.comoResolver}
          </p>
        )}
      </div>
    </li>
  );
}

function Metrica({ rotulo, valor }: { rotulo: string; valor: React.ReactNode }) {
  return (
    <div>
      <p className="text-[15px] font-semibold tabular-nums text-cream">{valor}</p>
      <p className="text-[10px] uppercase tracking-[0.1em] text-muted">{rotulo}</p>
    </div>
  );
}

function CartaoSaude({ canal }: { canal: SaudeCanal }) {
  const cor = NIVEL[canal.nivel];
  const { Icone } = cor;
  const v = canal.volume24h;

  return (
    <article className={`rounded-xl border ${cor.borda} ${cor.fundo} p-4`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-[15px] tracking-wide text-cream">
            {canal.label}
          </h3>
          <p className="truncate text-[11px] tabular-nums text-muted">
            {canal.phoneFormatted ?? 'sem numero pareado'}
            {canal.agente && (
              <>
                {' · '}
                {canal.agente.label}
                {!canal.agente.ligado && ' (desligado)'}
              </>
            )}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border ${cor.borda} px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${cor.texto}`}
        >
          <Icone size={11} />
          {canal.nivelLabel}
        </span>
      </header>

      <div className="mt-4 grid grid-cols-4 gap-3 border-y border-navy-800/60 py-3">
        <Metrica rotulo="Recebidas 24h" valor={v.recebidas24h} />
        <Metrica rotulo="Respondidas" valor={v.enviadas24h} />
        <Metrica
          rotulo="Ultima msg"
          valor={<span className="text-xs font-normal">{desde(v.ultimaRecebidaEm)}</span>}
        />
        <Metrica
          rotulo={canal.status === 'connected' ? 'Conectado ha' : 'Conexao'}
          valor={
            <span className="text-xs font-normal">
              {canal.status === 'connected'
                ? duracao(canal.conexao.tempoConectadoMs)
                : desde(canal.conexao.desconectadoEm)}
            </span>
          }
        />
      </div>

      <ul className="mt-3 space-y-2.5">
        {canal.sinais.map((sinal, i) => (
          <Sinal key={`${sinal.titulo}-${i}`} sinal={sinal} />
        ))}
        {!canal.sinais.length && (
          <li className="text-[11px] text-muted">Nada a relatar nas ultimas 24h.</li>
        )}
      </ul>

      {(v.falhas > 0 || v.latenciaMediaMs) && (
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] tabular-nums text-navy-600">
          <span>{v.execucoes} resposta(s) gerada(s)</span>
          {v.falhas > 0 && <span>{v.falhas} falha(s)</span>}
          {v.latenciaMediaMs && <span>{(v.latenciaMediaMs / 1000).toFixed(1)}s em media</span>}
          {v.enviadasPorPessoa24h > 0 && <span>{v.enviadasPorPessoa24h} enviada(s) por pessoas</span>}
        </p>
      )}
    </article>
  );
}

export default function SaudeNumeros({
  relatorio,
  carregando,
}: {
  relatorio: RelatorioSaude | null;
  carregando: boolean;
}) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
        <Activity size={15} />
        Saude dos numeros
        {relatorio && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] font-normal normal-case tracking-normal text-navy-600">
            janela de {relatorio.janela} · verificado {desde(relatorio.verificadoEm)}
          </span>
        )}
      </h2>

      {carregando && !relatorio ? (
        <div className="flex items-center gap-2 rounded-xl border border-navy-800 bg-navy-900 px-4 py-6 text-sm text-muted">
          <Loader2 size={15} className="animate-spin text-gold-400" />
          Levantando o estado dos numeros
        </div>
      ) : !relatorio ? (
        <p className="rounded-xl border border-navy-800 bg-navy-900 px-4 py-6 text-sm text-muted">
          Nao foi possivel levantar a saude dos numeros agora. O atendimento nao para por causa
          disto — e so esta leitura que ficou indisponivel.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {relatorio.canais.map((canal) => (
            <CartaoSaude key={canal.id} canal={canal} />
          ))}
        </div>
      )}
    </section>
  );
}
