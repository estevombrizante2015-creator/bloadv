'use client';

import React, { useState } from 'react';
import { Check, ClipboardList, Loader2, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { Botao, Campo, EditorTexto, EntradaTexto, Modal, Selo, Seletor } from '@/components/ui/base';
import { PontoDeCor } from './comuns';
import {
  clientesApi,
  dataCurta,
  prazoRelativo,
  PRIORIDADE_COR,
  PRIORIDADE_LABEL,
  type Prioridade,
  type Responsavel,
  type Tarefa,
} from '@/lib/clientes';

/**
 * TAREFAS DO CLIENTE
 * ------------------
 * Abertas primeiro, ordenadas por prazo, com o vencimento em linguagem de
 * agenda ("vencida ha 3 dias", "amanha") em vez de uma data que exige contar
 * nos dedos.
 *
 * As concluidas ficam visiveis embaixo: mostram o que ja foi cobrado e evitam
 * a mesma cobranca duas vezes — a queixa mais comum de quem recebe atendimento
 * de um escritorio.
 */

const SUGESTOES = [
  'Entrar em contato',
  'Solicitar documento',
  'Validar informacao',
  'Retornar proposta',
  'Realizar acompanhamento',
  'Revisar processo',
  'Cobrar pendencia',
];

export default function Tarefas({
  clienteId,
  tarefas,
  responsaveis,
  prioridades,
  podeEditar,
  aoMudar,
}: {
  clienteId: string;
  tarefas: Tarefa[];
  responsaveis: Responsavel[];
  prioridades: Prioridade[];
  podeEditar: boolean;
  aoMudar: () => void;
}) {
  const [criando, setCriando] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const abertas = tarefas.filter((t) => t.status === 'aberta');
  const fechadas = tarefas.filter((t) => t.status !== 'aberta');

  const alternar = async (tarefa: Tarefa) => {
    setOcupado(tarefa.id);
    setErro(null);
    try {
      await clientesApi.atualizarTarefa(tarefa.id, {
        status: tarefa.status === 'aberta' ? 'concluida' : 'aberta',
      });
      aoMudar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel atualizar.');
    } finally {
      setOcupado(null);
    }
  };

  const remover = async (tarefa: Tarefa) => {
    setOcupado(tarefa.id);
    try {
      await clientesApi.removerTarefa(tarefa.id);
      aoMudar();
    } finally {
      setOcupado(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {abertas.length
            ? `${abertas.length} ${abertas.length === 1 ? 'tarefa aberta' : 'tarefas abertas'}`
            : 'Nenhuma tarefa aberta'}
        </p>
        {podeEditar && (
          <Botao aparencia="secundario" aoClicar={() => setCriando(true)}>
            <Plus size={15} />
            Nova tarefa
          </Botao>
        )}
      </div>

      {erro && <p className="text-sm text-red-200">{erro}</p>}

      {!tarefas.length && (
        <div className="rounded-2xl border border-navy-800 bg-navy-900/40 p-8 text-center">
          <ClipboardList size={20} className="mx-auto mb-3 text-navy-600" />
          <p className="text-sm text-muted">
            Nenhuma tarefa. Crie uma para o proximo passo nao depender de alguem lembrar.
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {abertas.map((tarefa) => (
          <li
            key={tarefa.id}
            className={`group flex items-start gap-3 rounded-xl border p-4 ${
              tarefa.vencida
                ? 'border-red-500/25 bg-red-500/[0.03]'
                : tarefa.venceHoje
                  ? 'border-amber-400/25 bg-amber-400/[0.03]'
                  : 'border-navy-800 bg-navy-900/40'
            }`}
          >
            <button
              onClick={() => alternar(tarefa)}
              disabled={!podeEditar || ocupado === tarefa.id}
              title="Concluir"
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-navy-600 transition-colors hover:border-emerald-400 hover:bg-emerald-400/10 disabled:opacity-50"
            >
              {ocupado === tarefa.id && <Loader2 size={11} className="animate-spin text-gold-400" />}
            </button>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="font-display text-sm tracking-wide text-cream">{tarefa.titulo}</h4>
                {tarefa.sugeridaPorIA && (
                  <Selo>
                    <Sparkles size={10} />
                    sugerida
                  </Selo>
                )}
                {tarefa.prioridade !== 'normal' && <Selo cor="atencao">{tarefa.prioridade}</Selo>}
              </div>

              {tarefa.descricao && (
                <p className="mt-1 text-sm leading-relaxed text-muted">{tarefa.descricao}</p>
              )}

              <p className="mt-1.5 text-xs text-muted">
                {tarefa.prazo && (
                  <span className={tarefa.vencida ? 'text-red-300' : tarefa.venceHoje ? 'text-amber-300' : ''}>
                    {prazoRelativo(tarefa.prazo)}
                  </span>
                )}
                {tarefa.prazo && tarefa.responsavel && ' · '}
                {tarefa.responsavel?.nome}
                {!tarefa.prazo && !tarefa.responsavel && 'sem prazo nem responsavel'}
              </p>
            </div>

            {podeEditar && (
              <button
                onClick={() => remover(tarefa)}
                aria-label="Remover tarefa"
                className="rounded-lg p-1.5 text-navy-600 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>

      {fechadas.length > 0 && (
        <div className="space-y-2 border-t border-navy-800 pt-5">
          <h3 className="text-xs uppercase tracking-[0.2em] text-muted">Concluidas</h3>
          <ul className="space-y-1">
            {fechadas.map((tarefa) => (
              <li key={tarefa.id} className="group flex items-center gap-3 px-1 py-1.5 text-sm">
                <Check size={14} className="shrink-0 text-emerald-400/70" />
                <span className="min-w-0 flex-1 truncate text-muted line-through decoration-navy-600">
                  {tarefa.titulo}
                </span>
                <span className="shrink-0 text-xs text-navy-600">
                  {dataCurta(tarefa.concluidaEm)}
                  {tarefa.concluidaPor ? ` · ${tarefa.concluidaPor}` : ''}
                </span>
                {podeEditar && (
                  <button
                    onClick={() => alternar(tarefa)}
                    title="Reabrir"
                    className="rounded p-1 text-navy-600 opacity-0 transition-all hover:text-gold-300 group-hover:opacity-100"
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {criando && (
        <NovaTarefa
          clienteId={clienteId}
          responsaveis={responsaveis}
          prioridades={prioridades}
          aoFechar={() => setCriando(false)}
          aoCriar={() => {
            setCriando(false);
            aoMudar();
          }}
        />
      )}
    </div>
  );
}

function NovaTarefa({
  clienteId,
  responsaveis,
  prioridades,
  aoFechar,
  aoCriar,
}: {
  clienteId: string;
  responsaveis: Responsavel[];
  prioridades: Prioridade[];
  aoFechar: () => void;
  aoCriar: () => void;
}) {
  const [dados, setDados] = useState<{
    titulo: string;
    descricao: string;
    prazo: string;
    prioridade: Prioridade;
    responsavelId: string;
  }>({ titulo: '', descricao: '', prazo: '', prioridade: 'normal', responsavelId: '' });

  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const criar = async () => {
    setSalvando(true);
    setErro(null);
    try {
      await clientesApi.criarTarefa(clienteId, {
        titulo: dados.titulo,
        descricao: dados.descricao,
        prazo: dados.prazo || null,
        prioridade: dados.prioridade,
        responsavel: responsaveis.find((r) => r.id === dados.responsavelId) || null,
      });
      aoCriar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel criar.');
    } finally {
      setSalvando(false);
    }
  };

  const campo = 'w-full rounded-xl border border-navy-800 bg-navy-900/60 px-3.5 py-2.5 text-sm text-cream focus:border-gold-500/40 focus:outline-none';

  return (
    <Modal
      titulo="Nova tarefa"
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao aoClicar={aoFechar} desabilitado={salvando}>
            Cancelar
          </Botao>
          <Botao
            aparencia="principal"
            aoClicar={criar}
            desabilitado={salvando || !dados.titulo.trim()}
          >
            {salvando ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Criar tarefa
          </Botao>
        </>
      }
    >
      <div className="space-y-5">
        {erro && <p className="text-sm text-red-200">{erro}</p>}

        <Campo titulo="O que precisa ser feito" obrigatorio>
          <EntradaTexto
            valor={dados.titulo}
            aoMudar={(titulo) => setDados({ ...dados, titulo })}
            placeholder="Cobrar o comprovante de residencia"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SUGESTOES.map((s) => (
              <button
                key={s}
                onClick={() => setDados({ ...dados, titulo: s })}
                className="rounded-md border border-navy-800 px-2 py-1 text-xs text-muted transition-colors hover:border-gold-500/40 hover:text-gold-200"
              >
                {s}
              </button>
            ))}
          </div>
        </Campo>

        <Campo titulo="Detalhes" explicacao="Opcional. O que quem for executar precisa saber.">
          <EditorTexto
            valor={dados.descricao}
            aoMudar={(descricao) => setDados({ ...dados, descricao })}
            minimoDeLinhas={2}
          />
        </Campo>

        <div className="grid gap-5 sm:grid-cols-3">
          <Campo titulo="Prazo">
            <input
              type="date"
              value={dados.prazo}
              onChange={(e) => setDados({ ...dados, prazo: e.target.value })}
              className={campo}
            />
          </Campo>

          <Campo titulo="Prioridade">
            <Seletor
              valor={dados.prioridade}
              aoMudar={(v) => setDados({ ...dados, prioridade: v as Prioridade })}
              opcoes={prioridades.map((p) => ({
                valor: p,
                label: PRIORIDADE_LABEL[p],
                enfeite: <PontoDeCor cor={PRIORIDADE_COR[p]} />,
              }))}
            />
          </Campo>

          <Campo titulo="Responsavel">
            <Seletor
              valor={dados.responsavelId}
              aoMudar={(responsavelId) => setDados({ ...dados, responsavelId })}
              opcoes={[
                { valor: '', label: 'Ninguem' },
                ...responsaveis.map((r) => ({ valor: r.id, label: r.nome, descricao: r.email })),
              ]}
            />
          </Campo>
        </div>
      </div>
    </Modal>
  );
}
