'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  FileText,
  History as HistoryIcon,
  Loader2,
  MessageSquare,
  Mic,
  MessagesSquare,
  Power,
  Save,
  ScrollText,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Botao, Modal, Selo } from '@/components/ui/base';
import { AbaEmpresa, AbaInstrucoes, AbaMensagens, AbaMidia, AbaRegras, AbaTom } from './abas';
import { Comparacao, ResultadoValidacao } from './Comparacao';
import Historico from './Historico';
import PainelTeste from './PainelTeste';
import {
  clonar,
  curadoriaApi,
  formatarData,
  iguais,
  type Alteracao,
  type ConfiguracaoAgente,
  type EstadoAgente,
  type Opcoes,
  type Validacao,
} from '@/lib/curadoria';

/**
 * EDITOR DE UM AGENTE
 * -------------------
 * O fluxo da tela e o do enunciado: editar -> salvar rascunho -> testar ->
 * publicar. O que garante que ele seja seguido nao e o desenho, e o servidor:
 * so existe UM rascunho por agente, e publicar publica o rascunho salvo.
 *
 * Por isso "Revisar e publicar" salva o rascunho antes de abrir a comparacao.
 * A alternativa - recusar publicar com alteracoes na tela - so ensinaria a
 * pessoa a clicar em salvar antes, sem beneficio nenhum.
 */

const ABAS = [
  { id: 'instrucoes', label: 'Instrucoes', Icone: FileText },
  { id: 'tom', label: 'Tom de voz', Icone: MessageSquare },
  { id: 'regras', label: 'Regras', Icone: ScrollText },
  { id: 'mensagens', label: 'Mensagens', Icone: MessagesSquare },
  { id: 'midia', label: 'Imagem, audio e web', Icone: Mic },
  { id: 'empresa', label: 'Empresa', Icone: Building2 },
  { id: 'historico', label: 'Historico', Icone: HistoryIcon },
] as const;

type AbaId = (typeof ABAS)[number]['id'];

export default function EditorAgente({
  agentId,
  opcoes,
  aoVoltar,
  aoAtualizarLista,
}: {
  agentId: string;
  opcoes: Opcoes;
  aoVoltar: () => void;
  aoAtualizarLista: () => void;
}) {
  const [estado, setEstado] = useState<EstadoAgente | null>(null);
  const [config, setConfig] = useState<ConfiguracaoAgente | null>(null);
  /** Ultima versao gravada no servidor: a referencia de "ha algo a salvar". */
  const [salvo, setSalvo] = useState<ConfiguracaoAgente | null>(null);
  const [padrao, setPadrao] = useState<ConfiguracaoAgente | null>(null);

  const [aba, setAba] = useState<AbaId>('instrucoes');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [recado, setRecado] = useState<string | null>(null);

  const [publicacao, setPublicacao] = useState<{ alteracoes: Alteracao[]; validacao: Validacao } | null>(null);
  const [publicando, setPublicando] = useState(false);
  const [nota, setNota] = useState('');
  const [testando, setTestando] = useState(false);
  const [confirmandoDescarte, setConfirmandoDescarte] = useState(false);

  const podeEditar = opcoes.permissoes.editar;

  // ------------------------------------------------------------ carregar

  /**
   * Recarga por contador.
   *
   * Um efeito nao pode alterar estado de forma sincrona - isso encadeia
   * renderizacoes. Entao quem pede a recarga e o evento (publicou, descartou,
   * restaurou) mudando o contador; o efeito apenas reage a ele e reposiciona a
   * tela sobre o que o servidor devolver.
   */
  const [recarga, setRecarga] = useState(0);
  const recarregar = () => setRecarga((n) => n + 1);

  useEffect(() => {
    let vivo = true;

    curadoriaApi
      .agente(agentId)
      .then((dados) => {
        if (!vivo) return;
        setEstado(dados);
        // A tela abre sobre o rascunho quando ele existe: e o trabalho em
        // andamento, nao o que esta no ar.
        const base = dados.rascunho ?? dados.publicada;
        setConfig(clonar(base));
        setSalvo(clonar(base));
      })
      .catch(
        (e) => vivo && setErro(e instanceof Error ? e.message : 'Nao foi possivel carregar este agente.')
      );

    curadoriaApi
      .padrao(agentId)
      .then((r) => vivo && setPadrao(r.config))
      .catch(() => vivo && setPadrao(null));

    // Trocar de agente no meio de uma requisicao nao pode pintar a tela com a
    // configuracao do agente anterior.
    return () => {
      vivo = false;
    };
  }, [agentId, recarga]);

  // Recado some sozinho: um "salvo" permanente na tela vira ruido.
  useEffect(() => {
    if (!recado) return;
    const t = setTimeout(() => setRecado(null), 4000);
    return () => clearTimeout(t);
  }, [recado]);

  const alteracoesNaoSalvas = useMemo(
    () => Boolean(config && salvo && !iguais(config, salvo)),
    [config, salvo]
  );

  // Sair no meio de uma edicao nao pode custar o texto escrito.
  useEffect(() => {
    if (!alteracoesNaoSalvas) return;
    const aviso = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', aviso);
    return () => window.removeEventListener('beforeunload', aviso);
  }, [alteracoesNaoSalvas]);

  // -------------------------------------------------------------- acoes

  const aoMudar = (patch: Partial<ConfiguracaoAgente>) =>
    setConfig((atual) => (atual ? { ...atual, ...patch } : atual));

  const salvarRascunho = async () => {
    if (!config) return null;
    setSalvando(true);
    setErro(null);
    try {
      const resposta = await curadoriaApi.salvarRascunho(agentId, config);
      setSalvo(clonar(resposta.rascunho));
      setConfig(clonar(resposta.rascunho));
      setRecado('Rascunho salvo. O atendimento continua com a versao publicada.');
      aoAtualizarLista();
      return resposta;
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel salvar.');
      return null;
    } finally {
      setSalvando(false);
    }
  };

  const abrirPublicacao = async () => {
    if (!config) return;
    setErro(null);

    // Publicar publica o RASCUNHO salvo: garantir que ele reflete a tela antes
    // de mostrar a comparacao evita publicar uma coisa tendo revisado outra.
    const salvamento = alteracoesNaoSalvas ? await salvarRascunho() : null;
    if (alteracoesNaoSalvas && !salvamento) return;

    setPublicando(true);
    try {
      const { validacao, alteracoes } = await curadoriaApi.validar(agentId, config);
      setPublicacao({ validacao, alteracoes });
      setNota('');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel preparar a publicacao.');
    } finally {
      setPublicando(false);
    }
  };

  const publicar = async () => {
    setPublicando(true);
    setErro(null);
    try {
      const resultado = await curadoriaApi.publicar(agentId, nota);
      setPublicacao(null);
      setRecado(`Publicado. O atendimento ja esta usando a versao ${resultado.versao}.`);
      recarregar();
      aoAtualizarLista();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel publicar.');
    } finally {
      setPublicando(false);
    }
  };

  const descartar = async () => {
    setConfirmandoDescarte(false);
    setErro(null);
    try {
      if (estado?.temRascunho) await curadoriaApi.descartar(agentId);
      recarregar();
      aoAtualizarLista();
      setRecado('Alteracoes descartadas. A tela voltou para a versao publicada.');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel descartar.');
    }
  };

  const alternarStatus = async () => {
    if (!estado) return;
    const novo = estado.agente.status === 'active' ? 'standby' : 'active';
    try {
      await curadoriaApi.status(agentId, novo);
      recarregar();
      aoAtualizarLista();
      setRecado(
        novo === 'active'
          ? 'Agente ativado. Ele volta a responder nos numeros dele.'
          : 'Agente em espera. Ele para de responder, mas nada e perdido.'
      );
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel alterar o status.');
    }
  };

  // ------------------------------------------------------------ estados

  if (!estado || !config) {
    return (
      <div className="flex items-center gap-3 py-20 text-muted">
        {erro ? (
          <p className="text-red-200">{erro}</p>
        ) : (
          <>
            <Loader2 size={18} className="animate-spin text-gold-400" />
            Carregando…
          </>
        )}
      </div>
    );
  }

  const ativo = estado.agente.status === 'active';
  const temPendencia = alteracoesNaoSalvas || estado.temRascunho;
  const propsAba = { config, aoMudar, opcoes, podeEditar, padrao };

  return (
    <div className="space-y-6">
      {/* ----------------------------------------------------- cabecalho */}
      <div>
        <button
          onClick={aoVoltar}
          className="mb-4 inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-gold-300"
        >
          <ArrowLeft size={15} />
          Todos os agentes
        </button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl tracking-wide text-cream">{estado.agente.label}</h1>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted">
              {estado.agente.descricao}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Selo cor={ativo ? 'ativo' : 'espera'}>{ativo ? 'Ativo' : 'Em espera'}</Selo>
              <Selo>
                {estado.nuncaPublicada ? 'configuracao original' : `versao ${estado.versao}`}
              </Selo>
              {estado.agente.numeros.map((numero) => (
                <Selo key={numero}>{numero}</Selo>
              ))}
            </div>
          </div>

          {opcoes.permissoes.alterarStatus && (
            <Botao aparencia="discreto" aoClicar={alternarStatus}>
              <Power size={15} />
              {ativo ? 'Colocar em espera' : 'Ativar agente'}
            </Botao>
          )}
        </div>

        {!ativo && (
          <p className="mt-4 rounded-xl border border-navy-700 bg-navy-900/50 px-4 py-3 text-sm leading-relaxed text-parchment/75">
            Este agente esta preparado mas nao responde automaticamente. Voce pode configurar tudo e
            testar a vontade; ele so entra em operacao quando for ativado.
          </p>
        )}
      </div>

      {/* -------------------------------------------------- barra de acao */}
      <div className="sticky top-16 z-20 -mx-2 rounded-2xl border border-navy-800 bg-navy-900/90 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            {temPendencia ? (
              <p className="flex items-center gap-2 text-sm text-amber-200">
                <TriangleAlert size={14} className="shrink-0" />
                {alteracoesNaoSalvas
                  ? 'Voce tem alteracoes que ainda nao foram salvas.'
                  : `Rascunho salvo em ${formatarData(estado.rascunhoEm)}, ainda nao publicado.`}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted">
                <CheckCircle2 size={14} className="shrink-0 text-emerald-400/70" />
                Tudo publicado.
                {estado.publicadaEm && ` Ultima publicacao em ${formatarData(estado.publicadaEm)}.`}
              </p>
            )}
          </div>

          {podeEditar && (
            <div className="flex flex-wrap items-center gap-2">
              {temPendencia && (
                <Botao aparencia="discreto" aoClicar={() => setConfirmandoDescarte(true)}>
                  <Trash2 size={15} />
                  Descartar
                </Botao>
              )}

              <Botao
                aparencia="discreto"
                aoClicar={salvarRascunho}
                desabilitado={!alteracoesNaoSalvas || salvando}
              >
                {salvando ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                Salvar rascunho
              </Botao>

              <Botao aparencia="secundario" aoClicar={() => setTestando(true)}>
                <Sparkles size={15} />
                Testar agente
              </Botao>

              <Botao
                aparencia="principal"
                aoClicar={abrirPublicacao}
                desabilitado={!temPendencia || publicando}
              >
                {publicando ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                Revisar e publicar
              </Botao>
            </div>
          )}
        </div>

        {recado && <p className="mt-2 text-sm text-emerald-200/90">{recado}</p>}
        {erro && <p className="mt-2 text-sm text-red-200">{erro}</p>}
      </div>

      {!podeEditar && (
        <p className="rounded-xl border border-navy-700 bg-navy-900/50 px-4 py-3 text-sm text-parchment/75">
          Seu acesso permite consultar a configuracao e o historico, mas nao alterar. Peca a um
          administrador se precisar editar.
        </p>
      )}

      {/* ---------------------------------------------------------- abas */}
      <div className="flex flex-col gap-6 lg:flex-row">
        <nav className="lg:w-52 lg:shrink-0">
          <ul className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
            {ABAS.map(({ id, label, Icone }) => (
              <li key={id} className="shrink-0">
                <button
                  onClick={() => setAba(id)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm transition-colors ${
                    aba === id
                      ? 'bg-gold-500/10 text-gold-200'
                      : 'text-muted hover:bg-navy-900/60 hover:text-parchment'
                  }`}
                >
                  <Icone size={15} className="shrink-0" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 pb-16">
          {aba === 'instrucoes' && <AbaInstrucoes {...propsAba} />}
          {aba === 'tom' && <AbaTom {...propsAba} />}
          {aba === 'regras' && <AbaRegras {...propsAba} />}
          {aba === 'mensagens' && <AbaMensagens {...propsAba} />}
          {aba === 'midia' && <AbaMidia {...propsAba} />}
          {aba === 'empresa' && <AbaEmpresa {...propsAba} />}
          {aba === 'historico' && (
            <Historico
              agentId={agentId}
              podeRestaurar={opcoes.permissoes.restaurar}
              aoRestaurar={() => {
                recarregar();
                aoAtualizarLista();
              }}
            />
          )}
        </div>
      </div>

      {/* ------------------------------------------------------ publicar */}
      {publicacao && (
        <Modal
          titulo="Revisar antes de publicar"
          subtitulo="Isto passa a valer no atendimento assim que voce confirmar."
          largura="max-w-3xl"
          aoFechar={() => setPublicacao(null)}
          rodape={
            <>
              <Botao aoClicar={() => setPublicacao(null)} desabilitado={publicando}>
                Voltar e editar
              </Botao>
              <Botao
                aparencia="principal"
                aoClicar={publicar}
                desabilitado={publicando || !publicacao.validacao.ok || !publicacao.alteracoes.length}
              >
                {publicando ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                Publicar agora
              </Botao>
            </>
          }
        >
          <div className="space-y-5">
            <ResultadoValidacao validacao={publicacao.validacao} />

            <div className="border-t border-navy-800 pt-5">
              <h3 className="mb-3 font-display text-sm tracking-wide text-cream">
                {publicacao.alteracoes.length === 1
                  ? '1 alteracao'
                  : `${publicacao.alteracoes.length} alteracoes`}
              </h3>
              <Comparacao alteracoes={publicacao.alteracoes} />
            </div>

            {publicacao.validacao.ok && publicacao.alteracoes.length > 0 && (
              <div className="border-t border-navy-800 pt-5">
                <label className="mb-2 block font-display text-sm tracking-wide text-cream">
                  Descreva a mudanca (opcional)
                </label>
                <input
                  value={nota}
                  onChange={(e) => setNota(e.target.value.slice(0, 120))}
                  placeholder="Ajuste de abordagem comercial"
                  className="w-full rounded-xl border border-navy-800 bg-navy-900/60 px-4 py-3 text-sm text-cream placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none"
                />
                <p className="mt-2 text-xs text-muted">
                  Aparece no historico. Ajuda quem for procurar depois por que o atendimento mudou.
                </p>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* -------------------------------------------------------- testar */}
      {testando && (
        <Modal
          titulo={`Testar ${estado.agente.label}`}
          subtitulo="Uma conversa de mentira, com a configuracao de verdade."
          largura="max-w-3xl"
          aoFechar={() => setTestando(false)}
        >
          <div className="h-[62vh]">
            <PainelTeste
              agentId={agentId}
              config={config}
              temAlteracoesNaoSalvas={alteracoesNaoSalvas}
            />
          </div>
        </Modal>
      )}

      {/* ------------------------------------------------------ descartar */}
      {confirmandoDescarte && (
        <Modal
          titulo="Descartar as alteracoes?"
          aoFechar={() => setConfirmandoDescarte(false)}
          rodape={
            <>
              <Botao aoClicar={() => setConfirmandoDescarte(false)}>Cancelar</Botao>
              <Botao aparencia="perigo" aoClicar={descartar}>
                <Trash2 size={15} />
                Descartar
              </Botao>
            </>
          }
        >
          <p className="text-sm leading-relaxed text-parchment/85">
            Tudo o que voce editou desde a ultima publicacao sera perdido, e a tela volta para a
            configuracao que esta no ar
            {estado.nuncaPublicada ? '' : ` (versao ${estado.versao})`}. Isto nao pode ser desfeito.
          </p>
          <p className="mt-3 text-sm text-muted">
            O atendimento nao muda: ele ja estava usando a versao publicada o tempo todo.
          </p>
        </Modal>
      )}
    </div>
  );
}
