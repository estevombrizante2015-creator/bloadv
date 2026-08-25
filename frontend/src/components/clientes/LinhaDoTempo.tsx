'use client';

import React, { useState } from 'react';
import {
  ArrowRightLeft,
  Bot,
  ClipboardList,
  FileText,
  Flag,
  Loader2,
  LogIn,
  MessageSquare,
  PenLine,
  Sparkles,
  UserCog,
} from 'lucide-react';
import { Botao } from '@/components/ui/base';
import { clientesApi, dataHora, type Evento } from '@/lib/clientes';

/**
 * LINHA DO TEMPO
 * --------------
 * Tudo o que aconteceu com o cliente, em ordem. A maior parte foi registrada
 * SOZINHA — mensagem recebida, status alterado, tarefa concluida. E essa a
 * diferenca em relacao a planilha, onde o historico so existe quando alguem
 * lembra de escrever, ou seja: quase nunca nos casos que mais importam.
 *
 * O filtro por tipo existe porque uma conversa ativa gera dezenas de linhas de
 * mensagem, e quem procura "quando mudamos o status" nao deveria ter de rolar
 * por elas.
 */

const APARENCIA: Record<string, { Icone: typeof MessageSquare; cor: string; rotulo: string }> = {
  entrada: { Icone: LogIn, cor: 'text-emerald-300', rotulo: 'Entrada' },
  mensagem: { Icone: MessageSquare, cor: 'text-sky-300', rotulo: 'Conversa' },
  status: { Icone: ArrowRightLeft, cor: 'text-gold-300', rotulo: 'Status' },
  etapa: { Icone: Flag, cor: 'text-violet-300', rotulo: 'Etapa' },
  responsavel: { Icone: UserCog, cor: 'text-violet-300', rotulo: 'Responsavel' },
  observacao: { Icone: PenLine, cor: 'text-parchment/70', rotulo: 'Observacao' },
  pendencia: { Icone: ClipboardList, cor: 'text-amber-300', rotulo: 'Pendencia' },
  tarefa: { Icone: ClipboardList, cor: 'text-amber-300', rotulo: 'Tarefa' },
  documento: { Icone: FileText, cor: 'text-sky-300', rotulo: 'Documento' },
  resumo: { Icone: Sparkles, cor: 'text-gold-400', rotulo: 'Resumo' },
  campo: { Icone: PenLine, cor: 'text-muted', rotulo: 'Alteracao' },
  sistema: { Icone: Bot, cor: 'text-muted', rotulo: 'Sistema' },
};

const AUTOR: Record<string, string> = {
  sistema: 'registrado automaticamente',
  cliente: 'o cliente',
  agente: 'o agente',
  usuario: '',
};

const FILTROS = [
  { id: '', label: 'Tudo' },
  { id: 'mensagem', label: 'Conversas' },
  { id: 'status,etapa,campo,responsavel', label: 'Mudancas' },
  { id: 'observacao,pendencia,tarefa', label: 'Anotacoes e tarefas' },
];

export default function LinhaDoTempo({
  clienteId,
  eventos,
  podeEditar,
  aoRegistrar,
}: {
  clienteId: string;
  eventos: Evento[];
  podeEditar: boolean;
  aoRegistrar: () => void;
}) {
  const [filtro, setFiltro] = useState('');
  const [observacao, setObservacao] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const tipos = filtro ? filtro.split(',') : null;
  const visiveis = tipos ? eventos.filter((e) => tipos.includes(e.tipo)) : eventos;

  const registrar = async () => {
    const texto = observacao.trim();
    if (!texto) return;

    setSalvando(true);
    setErro(null);
    try {
      await clientesApi.observacao(clienteId, texto);
      setObservacao('');
      aoRegistrar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel registrar.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="space-y-5">
      {podeEditar && (
        <div className="space-y-2 rounded-2xl border border-navy-800 p-4">
          <textarea
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            rows={2}
            placeholder="Registrar uma observacao no historico…"
            className="w-full resize-none rounded-xl border border-navy-800 bg-navy-900/60 px-3.5 py-2.5 text-sm text-cream placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted">
              Fica no historico da ficha. Nao e enviado ao cliente.
            </p>
            <Botao
              aparencia="secundario"
              aoClicar={registrar}
              desabilitado={!observacao.trim() || salvando}
            >
              {salvando ? <Loader2 size={14} className="animate-spin" /> : <PenLine size={14} />}
              Registrar
            </Botao>
          </div>
          {erro && <p className="text-sm text-red-200">{erro}</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTROS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFiltro(f.id)}
            className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              filtro === f.id
                ? 'border-gold-500/50 bg-gold-500/10 text-gold-200'
                : 'border-navy-800 text-muted hover:border-gold-500/30 hover:text-parchment'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!visiveis.length ? (
        <p className="rounded-xl border border-navy-800 bg-navy-900/40 p-8 text-center text-sm text-muted">
          Nada registrado neste recorte ainda.
        </p>
      ) : (
        <ol className="relative space-y-1 border-l border-navy-800 pl-6">
          {visiveis.map((evento) => {
            const aparencia = APARENCIA[evento.tipo] || APARENCIA.sistema;
            const { Icone } = aparencia;
            const autor =
              evento.autor?.tipo === 'usuario'
                ? evento.autor.nome || 'alguem da equipe'
                : AUTOR[evento.autor?.tipo || 'sistema'];

            return (
              <li key={evento.id} className="relative py-2.5">
                <span className="absolute -left-[1.9rem] top-3 flex h-5 w-5 items-center justify-center rounded-full border border-navy-700 bg-navy-950">
                  <Icone size={11} className={aparencia.cor} />
                </span>

                <div className="flex flex-wrap items-baseline gap-x-2">
                  <p className="text-sm leading-relaxed text-parchment">{evento.titulo}</p>
                  <span className="text-xs tabular-nums text-navy-600">{dataHora(evento.em)}</span>
                </div>

                {evento.descricao && (
                  <p className="mt-1 whitespace-pre-line border-l-2 border-navy-800 pl-3 text-sm leading-relaxed text-muted">
                    {evento.descricao}
                  </p>
                )}

                {autor && <p className="mt-0.5 text-xs text-navy-600">{autor}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
