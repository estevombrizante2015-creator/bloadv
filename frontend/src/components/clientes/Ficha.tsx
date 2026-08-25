'use client';

import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Archive,
  Check,
  CircleCheck,
  ClipboardList,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Trash2,
  History as HistoryIcon,
  User,
} from 'lucide-react';
import Link from 'next/link';
import { Botao, Campo, EditorTexto, EntradaTexto, Modal, Selo, Seletor } from '@/components/ui/base';
import { Alertas, PontoDeCor, SeloStatus } from './comuns';
import Inteligencia from './Inteligencia';
import LinhaDoTempo from './LinhaDoTempo';
import Tarefas from './Tarefas';
import {
  clientesApi,
  dataCurta,
  haQuantoTempo,
  PRIORIDADE_COR,
  PRIORIDADE_LABEL,
  type CampoExtra,
  type ClienteDetalhe,
  type Evento,
  type Pipeline,
  type Responsavel,
  type Tarefa,
} from '@/lib/clientes';

/**
 * FICHA DO CLIENTE
 * ----------------
 * A tela precisa responder, de cima para baixo e sem rolagem: quem e o cliente
 * → onde ele esta no processo → o que ja aconteceu → o que aguardamos → qual a
 * pendencia → quem responde → qual o proximo passo.
 *
 * Por isso o cabecalho carrega identidade e status, os campos operacionais vem
 * logo abaixo, e conversa/historico ficam em abas: sao o material de consulta,
 * nao a resposta.
 */

const ABAS = [
  { id: 'geral', label: 'Visao geral', Icone: User },
  { id: 'timeline', label: 'Linha do tempo', Icone: HistoryIcon },
  { id: 'tarefas', label: 'Tarefas', Icone: ClipboardList },
] as const;

type AbaId = (typeof ABAS)[number]['id'];

export default function Ficha({
  clienteId,
  pipeline,
  responsaveis,
  podeEditar,
  podeExcluir,
  aoVoltar,
  aoMudar,
}: {
  clienteId: string;
  pipeline: Pipeline;
  responsaveis: Responsavel[];
  podeEditar: boolean;
  podeExcluir: boolean;
  aoVoltar: () => void;
  aoMudar: () => void;
}) {
  const [cliente, setCliente] = useState<ClienteDetalhe | null>(null);
  const [tarefas, setTarefas] = useState<Tarefa[]>([]);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [desatualizado, setDesatualizado] = useState(false);
  const [perguntas, setPerguntas] = useState<string[]>([]);

  const [aba, setAba] = useState<AbaId>('geral');
  const [recarga, setRecarga] = useState(0);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [recado, setRecado] = useState<string | null>(null);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);

  /** Rascunho local dos campos editaveis. */
  const [form, setForm] = useState<Record<string, unknown>>({});

  useEffect(() => {
    let vivo = true;

    clientesApi
      .obter(clienteId)
      .then((dados) => {
        if (!vivo) return;
        setCliente(dados.cliente);
        setTarefas(dados.tarefas);
        setEventos(dados.timeline);
        setDesatualizado(dados.resumoDesatualizado);
        setPerguntas(dados.perguntasSugeridas);
        setForm({});
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Falha ao abrir a ficha'));

    return () => {
      vivo = false;
    };
  }, [clienteId, recarga]);

  useEffect(() => {
    if (!recado) return;
    const t = setTimeout(() => setRecado(null), 3500);
    return () => clearTimeout(t);
  }, [recado]);

  const definir = (campo: string, valor: unknown) => setForm((atual) => ({ ...atual, [campo]: valor }));

  const valor = <T,>(campo: keyof ClienteDetalhe, padrao: T): T =>
    (form[campo] !== undefined ? form[campo] : cliente?.[campo]) as T ?? padrao;

  const temMudancas = Object.keys(form).length > 0;

  const salvar = async () => {
    if (!temMudancas) return;
    setSalvando(true);
    setErro(null);
    try {
      const { cliente: atualizado } = await clientesApi.atualizar(clienteId, form);
      setCliente(atualizado);
      setForm({});
      setRecado('Alteracoes salvas.');
      aoMudar();
      // A timeline ganhou linhas novas com o que acabou de mudar.
      setRecarga((n) => n + 1);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel salvar.');
    } finally {
      setSalvando(false);
    }
  };

  const excluir = async () => {
    setConfirmandoExclusao(false);
    try {
      await clientesApi.remover(clienteId);
      aoMudar();
      aoVoltar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel excluir.');
    }
  };

  if (!cliente) {
    return (
      <div className="flex items-center gap-3 py-20 text-muted">
        {erro ? (
          <p className="text-red-200">{erro}</p>
        ) : (
          <>
            <Loader2 size={18} className="animate-spin text-gold-400" />
            Carregando a ficha…
          </>
        )}
      </div>
    );
  }

  const conversa = cliente.conversas[0];
  const campo = 'w-full rounded-xl border border-navy-800 bg-navy-900/60 px-3.5 py-2.5 text-sm text-cream focus:border-gold-500/40 focus:outline-none disabled:opacity-60';

  return (
    <div className="space-y-6">
      {/* ----------------------------------------------------- cabecalho */}
      <div>
        <button
          onClick={aoVoltar}
          className="mb-4 inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-gold-300"
        >
          <ArrowLeft size={15} />
          Voltar para a carteira
        </button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-2xl tracking-wide text-cream">
              {cliente.nome || cliente.telefoneFormatado || 'Sem identificacao'}
            </h1>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <SeloStatus label={cliente.statusLabel} cor={cliente.statusCor} />
              {cliente.etapaLabel && <Selo>{cliente.etapaLabel}</Selo>}
              {cliente.telefoneFormatado && <Selo>{cliente.telefoneFormatado}</Selo>}
              {cliente.arquivado && <Selo cor="atencao">arquivada</Selo>}
            </div>

            <p className="mt-2 text-xs text-muted">
              Cliente desde {dataCurta(cliente.entradaEm)} · ultimo contato{' '}
              {haQuantoTempo(cliente.ultimoContatoEm)} ·{' '}
              {cliente.origem === 'whatsapp' ? 'entrou pelo WhatsApp' : 'cadastro manual'}
            </p>

            <div className="mt-2">
              <Alertas cliente={cliente} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {conversa && (
              <Link
                href={`/conversas?channelId=${conversa.channelId}&chat=${encodeURIComponent(conversa.chatId)}`}
                className="inline-flex items-center gap-2 rounded-xl border border-navy-800 px-4 py-2.5 text-sm text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300"
              >
                <MessageSquare size={15} />
                Ver conversa
              </Link>
            )}

            {podeEditar && (
              <Botao
                aparencia="discreto"
                aoClicar={() => definir('arquivado', !cliente.arquivado)}
                titulo="Arquivar tira a ficha das listas sem apagar nada"
              >
                <Archive size={15} />
                {valor('arquivado', false) ? 'Reativar' : 'Arquivar'}
              </Botao>
            )}

            {podeEditar && (
              <Botao aparencia="principal" aoClicar={salvar} desabilitado={!temMudancas || salvando}>
                {salvando ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                Salvar
              </Botao>
            )}
          </div>
        </div>

        {recado && (
          <p className="mt-3 flex items-center gap-2 text-sm text-emerald-200/90">
            <CircleCheck size={14} />
            {recado}
          </p>
        )}
        {erro && <p className="mt-3 text-sm text-red-200">{erro}</p>}
        {temMudancas && (
          <p className="mt-3 text-sm text-amber-200">Ha alteracoes nao salvas nesta ficha.</p>
        )}
      </div>

      {/* --------------------------------------------------------- abas */}
      <nav className="flex gap-1 border-b border-navy-800">
        {ABAS.map(({ id, label, Icone }) => (
          <button
            key={id}
            onClick={() => setAba(id)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition-colors ${
              aba === id
                ? 'border-gold-500 text-gold-200'
                : 'border-transparent text-muted hover:text-parchment'
            }`}
          >
            <Icone size={15} />
            {label}
            {id === 'tarefas' && tarefas.some((t) => t.status === 'aberta') && (
              <span className="rounded-md bg-navy-800 px-1.5 text-xs tabular-nums">
                {tarefas.filter((t) => t.status === 'aberta').length}
              </span>
            )}
          </button>
        ))}
      </nav>

      {aba === 'geral' && (
        <div className="space-y-6">
          <Inteligencia
            cliente={cliente}
            desatualizado={desatualizado}
            perguntasSugeridas={perguntas}
            podeUsar={podeEditar}
            aoAplicarSugestoes={(atualizado) => {
              setCliente(atualizado);
              setRecarga((n) => n + 1);
              aoMudar();
            }}
          />

          <div className="grid gap-6 lg:grid-cols-3">
            {/* ------------------------------------ acompanhamento */}
            <section className="space-y-5 rounded-2xl border border-navy-800 p-5 lg:col-span-2">
              <h2 className="font-display text-base tracking-wide text-cream">Acompanhamento</h2>

              <div className="grid gap-5 sm:grid-cols-2">
                <Campo titulo="Status" explicacao="Onde o cliente esta agora.">
                  <Seletor
                    valor={valor('status', '')}
                    desabilitado={!podeEditar}
                    aoMudar={(v) => definir('status', v)}
                    opcoes={pipeline.status.map((s) => ({
                      valor: s.id,
                      label: s.label,
                      enfeite: <PontoDeCor cor={s.cor} />,
                    }))}
                  />
                </Campo>

                <Campo titulo="Etapa do processo">
                  <Seletor
                    valor={valor('etapa', '') || ''}
                    desabilitado={!podeEditar}
                    aoMudar={(v) => definir('etapa', v)}
                    opcoes={[
                      { valor: '', label: 'Nao definida' },
                      ...pipeline.etapas.map((e) => ({ valor: e.id, label: e.label })),
                    ]}
                  />
                </Campo>
              </div>

              <Campo
                titulo="O que estamos aguardando"
                explicacao="Em uma linha: o que trava o andamento agora. E o campo que o agente usa para responder ao cliente."
              >
                <EntradaTexto
                  valor={valor('aguardando', '') || ''}
                  aoMudar={(v) => definir('aguardando', v)}
                  desabilitado={!podeEditar}
                  placeholder="Comprovante de residencia"
                />
              </Campo>

              <div className="grid gap-5 sm:grid-cols-2">
                <Campo titulo="Proxima acao" explicacao="O que o escritorio precisa fazer em seguida.">
                  <EntradaTexto
                    valor={valor('proximaAcao', '') || ''}
                    aoMudar={(v) => definir('proximaAcao', v)}
                    desabilitado={!podeEditar}
                    placeholder="Cobrar o documento"
                  />
                </Campo>

                <Campo titulo="Data da proxima acao">
                  <input
                    type="date"
                    value={String(valor('proximaAcaoEm', '') || '').slice(0, 10)}
                    disabled={!podeEditar}
                    onChange={(e) => definir('proximaAcaoEm', e.target.value || null)}
                    className={campo}
                  />
                </Campo>
              </div>

              <Pendencias
                cliente={cliente}
                podeEditar={podeEditar}
                aoMudar={(atualizado) => {
                  setCliente(atualizado);
                  setRecarga((n) => n + 1);
                }}
              />

              <CamposDaPlanilha campos={cliente.camposExtras} />

              <Campo
                titulo="Observacoes internas"
                explicacao="So a equipe ve. Nunca entra no resumo enviado ao cliente nem nas respostas do agente."
              >
                <EditorTexto
                  valor={valor('observacoesInternas', '') || ''}
                  aoMudar={(v) => definir('observacoesInternas', v)}
                  desabilitado={!podeEditar}
                  minimoDeLinhas={4}
                />
              </Campo>
            </section>

            {/* ------------------------------------------- identificacao */}
            <section className="space-y-5 rounded-2xl border border-navy-800 p-5">
              <h2 className="font-display text-base tracking-wide text-cream">Dados do cliente</h2>

              <Campo titulo="Nome">
                <EntradaTexto
                  valor={valor('nome', '') || ''}
                  aoMudar={(v) => definir('nome', v)}
                  desabilitado={!podeEditar}
                />
              </Campo>

              <Campo titulo="Telefone" explicacao="E a identidade do cliente no sistema inteiro.">
                <EntradaTexto
                  valor={valor('telefone', '') || ''}
                  aoMudar={(v) => definir('telefone', v)}
                  desabilitado={!podeEditar}
                />
              </Campo>

              <Campo titulo="E-mail">
                <EntradaTexto
                  tipo="email"
                  valor={valor('email', '') || ''}
                  aoMudar={(v) => definir('email', v)}
                  desabilitado={!podeEditar}
                />
              </Campo>

              <Campo titulo="Responsavel pelo atendimento">
                <Seletor
                  valor={(valor('responsavel', null) as Responsavel | null)?.id || ''}
                  desabilitado={!podeEditar}
                  aoMudar={(id) =>
                    definir('responsavel', responsaveis.find((r) => r.id === id) || null)
                  }
                  opcoes={[
                    { valor: '', label: 'Sem responsavel' },
                    // O e-mail entra como segunda linha: em escritorio com dois
                    // "Barbosa", o nome sozinho nao distingue quem e quem.
                    ...responsaveis.map((r) => ({
                      valor: r.id,
                      label: r.nome,
                      descricao: r.email,
                    })),
                  ]}
                />
              </Campo>

              <Campo titulo="Prioridade">
                <Seletor
                  valor={valor('prioridade', 'normal')}
                  desabilitado={!podeEditar}
                  aoMudar={(v) => definir('prioridade', v)}
                  opcoes={pipeline.prioridades.map((p) => ({
                    valor: p,
                    label: PRIORIDADE_LABEL[p],
                    enfeite: <PontoDeCor cor={PRIORIDADE_COR[p]} />,
                  }))}
                />
              </Campo>

              <Etiquetas
                tags={valor('tags', cliente.tags) as string[]}
                sugestoes={pipeline.tags}
                podeEditar={podeEditar}
                aoMudar={(tags) => definir('tags', tags)}
              />

              {podeExcluir && (
                <div className="border-t border-navy-800 pt-4">
                  <button
                    onClick={() => setConfirmandoExclusao(true)}
                    className="inline-flex items-center gap-2 text-xs text-red-300/70 transition-colors hover:text-red-300"
                  >
                    <Trash2 size={13} />
                    Excluir ficha permanentemente
                  </button>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {aba === 'timeline' && (
        <LinhaDoTempo
          clienteId={clienteId}
          eventos={eventos}
          podeEditar={podeEditar}
          aoRegistrar={() => setRecarga((n) => n + 1)}
        />
      )}

      {aba === 'tarefas' && (
        <Tarefas
          clienteId={clienteId}
          tarefas={tarefas}
          responsaveis={responsaveis}
          prioridades={pipeline.prioridades}
          podeEditar={podeEditar}
          aoMudar={() => {
            setRecarga((n) => n + 1);
            aoMudar();
          }}
        />
      )}

      {confirmandoExclusao && (
        <Modal
          titulo="Excluir esta ficha?"
          aoFechar={() => setConfirmandoExclusao(false)}
          rodape={
            <>
              <Botao aoClicar={() => setConfirmandoExclusao(false)}>Cancelar</Botao>
              <Botao aparencia="perigo" aoClicar={excluir}>
                <Trash2 size={15} />
                Excluir
              </Botao>
            </>
          }
        >
          <p className="text-sm leading-relaxed text-parchment/85">
            A ficha, a linha do tempo inteira e as tarefas deste cliente serao apagadas. Isto nao
            pode ser desfeito.
          </p>
          <p className="mt-3 text-sm text-muted">
            Na maioria dos casos o que voce quer e <strong className="text-parchment/80">arquivar</strong>:
            some das listas e nada e perdido. As conversas de WhatsApp nao sao afetadas.
          </p>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------ pendencias

function Pendencias({
  cliente,
  podeEditar,
  aoMudar,
}: {
  cliente: ClienteDetalhe;
  podeEditar: boolean;
  aoMudar: (cliente: ClienteDetalhe) => void;
}) {
  const [nova, setNova] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const abertas = cliente.todasPendencias.filter((p) => !p.resolvida);
  const resolvidas = cliente.todasPendencias.filter((p) => p.resolvida);

  const adicionar = async () => {
    const texto = nova.trim();
    if (!texto) return;
    setOcupado(true);
    try {
      const { cliente: atualizado } = await clientesApi.adicionarPendencia(cliente.id, texto);
      aoMudar(atualizado);
      setNova('');
    } finally {
      setOcupado(false);
    }
  };

  const resolver = async (pendenciaId: string) => {
    setOcupado(true);
    try {
      const { cliente: atualizado } = await clientesApi.resolverPendencia(cliente.id, pendenciaId);
      aoMudar(atualizado);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="font-display text-sm tracking-wide text-cream">
        Pendencias {abertas.length > 0 && <span className="text-amber-300">({abertas.length})</span>}
      </h3>

      {abertas.length === 0 && resolvidas.length === 0 && (
        <p className="text-xs text-navy-600">Nenhuma pendencia registrada.</p>
      )}

      <ul className="space-y-1.5">
        {abertas.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.03] px-3.5 py-2.5"
          >
            <button
              onClick={() => resolver(p.id)}
              disabled={!podeEditar || ocupado}
              title="Marcar como resolvida"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-amber-400/50 transition-colors hover:bg-amber-400/20 disabled:opacity-50"
            />
            <span className="min-w-0 flex-1 text-sm text-parchment">{p.texto}</span>
            <span className="shrink-0 text-xs text-muted">{dataCurta(p.criadaEm)}</span>
          </li>
        ))}

        {/* Resolvidas ficam a vista: mostram o que ja foi cobrado e evitam
            cobrar duas vezes a mesma coisa. */}
        {resolvidas.slice(0, 3).map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3.5 py-1.5 text-sm text-muted">
            <Check size={13} className="shrink-0 text-emerald-400/70" />
            <span className="min-w-0 flex-1 truncate line-through decoration-navy-600">{p.texto}</span>
            <span className="shrink-0 text-xs">{dataCurta(p.resolvidaEm)}</span>
          </li>
        ))}
      </ul>

      {podeEditar && (
        <div className="flex items-center gap-2">
          <input
            value={nova}
            onChange={(e) => setNova(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && adicionar()}
            placeholder="Registrar uma pendencia"
            className="flex-1 rounded-xl border border-navy-800 bg-navy-900/60 px-3.5 py-2 text-sm text-cream placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none"
          />
          <Botao aparencia="discreto" aoClicar={adicionar} desabilitado={!nova.trim() || ocupado}>
            <Plus size={14} />
          </Botao>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- etiquetas

function Etiquetas({
  tags,
  sugestoes,
  podeEditar,
  aoMudar,
}: {
  tags: string[];
  sugestoes: string[];
  podeEditar: boolean;
  aoMudar: (tags: string[]) => void;
}) {
  const [nova, setNova] = useState('');

  const adicionar = (texto: string) => {
    const limpo = texto.trim().toLowerCase();
    if (!limpo || tags.includes(limpo)) return;
    aoMudar([...tags, limpo]);
    setNova('');
  };

  const disponiveis = sugestoes.filter((s) => !tags.includes(s));

  return (
    <Campo titulo="Etiquetas" explicacao="Para agrupar clientes fora do status e da etapa.">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 rounded-lg border border-navy-700 bg-navy-850 px-2.5 py-1 text-xs text-parchment/80"
            >
              {tag}
              {podeEditar && (
                <button
                  onClick={() => aoMudar(tags.filter((t) => t !== tag))}
                  className="text-muted transition-colors hover:text-red-300"
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {!tags.length && <span className="text-xs text-navy-600">nenhuma</span>}
        </div>

        {podeEditar && (
          <>
            <input
              value={nova}
              onChange={(e) => setNova(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  adicionar(nova);
                }
              }}
              placeholder="Nova etiqueta"
              className="w-full rounded-lg border border-navy-800 bg-navy-900/60 px-3 py-1.5 text-xs text-cream placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none"
            />

            {/* Sugestoes existentes evitam dez grafias da mesma etiqueta. */}
            {disponiveis.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {disponiveis.slice(0, 6).map((s) => (
                  <button
                    key={s}
                    onClick={() => adicionar(s)}
                    className="rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:text-gold-300"
                  >
                    + {s}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Campo>
  );
}

// ------------------------------------------------------ campos da planilha

/**
 * As colunas da planilha que o produto nao modela.
 *
 * "Parte contraria", "numero do processo", "documentos entregues" — cada
 * escritorio tem as suas, e sao a substancia do caso. Ficam aqui com o titulo
 * original, em vez de virarem texto corrido dentro das observacoes.
 *
 * Recolhido por padrao quando ha muitos: a ficha responde primeiro "onde o
 * cliente esta", e uma lista de vinte campos antes disso enterra a resposta.
 */
function CamposDaPlanilha({ campos }: { campos: CampoExtra[] }) {
  const [aberto, setAberto] = useState(false);

  if (!campos?.length) return null;

  const visiveis = aberto ? campos : campos.slice(0, 4);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-sm tracking-wide text-cream">Dados da planilha</h3>
        <Selo>{campos.length}</Selo>
      </div>

      <dl className="space-y-1.5">
        {visiveis.map((campo) => (
          <div
            key={campo.rotulo}
            className="grid gap-1 rounded-lg border border-navy-800 bg-navy-900/30 px-3 py-2 sm:grid-cols-3"
          >
            <dt className="truncate text-xs uppercase tracking-wider text-muted">{campo.rotulo}</dt>
            <dd className="whitespace-pre-line text-sm leading-relaxed text-parchment sm:col-span-2">
              {campo.valor}
            </dd>
          </div>
        ))}
      </dl>

      {campos.length > 4 && (
        <button
          onClick={() => setAberto((v) => !v)}
          className="text-xs text-muted transition-colors hover:text-gold-300"
        >
          {aberto ? 'Mostrar menos' : `Ver os outros ${campos.length - 4}`}
        </button>
      )}

      <p className="text-xs leading-relaxed text-muted">
        Vieram da importacao e sao internos: entram no que a IA le para a equipe, nunca no resumo
        enviado ao cliente.
      </p>
    </div>
  );
}
