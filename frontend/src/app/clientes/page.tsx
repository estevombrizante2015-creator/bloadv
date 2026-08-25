'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Columns3,
  LayoutDashboard,
  List,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Upload,
  WifiOff,
} from 'lucide-react';
import { BrandLockup } from '@/components/Brand';
import { Botao, Campo, EntradaTexto, Modal } from '@/components/ui/base';
import Filtros from '@/components/clientes/Filtros';
import Ficha from '@/components/clientes/Ficha';
import Kanban from '@/components/clientes/Kanban';
import Lista from '@/components/clientes/Lista';
import PainelOperacional from '@/components/clientes/Painel';
import Importar from '@/components/clientes/Importar';
import { useAuth } from '@/hooks/useAuth';
import {
  clientesApi,
  type ClienteResumo,
  type Filtros as TipoFiltros,
  type Pipeline,
  type Responsavel,
} from '@/lib/clientes';

/**
 * GESTAO OPERACIONAL DE CLIENTES
 * ------------------------------
 * A central de acompanhamento que substitui a planilha.
 *
 * Tres visoes do MESMO recorte: o painel mostra os numeros, a lista mostra os
 * clientes em detalhe e o quadro mostra o fluxo. Os filtros valem para as tres
 * — clicar em "7 parados" no painel e trocar para o quadro mantem os mesmos
 * sete. Sem isso a pessoa refiltraria a cada troca de aba e desistiria de usar
 * mais de uma visao.
 */

const ABAS = [
  { id: 'painel', label: 'Painel', Icone: LayoutDashboard },
  { id: 'lista', label: 'Lista', Icone: List },
  { id: 'kanban', label: 'Quadro', Icone: Columns3 },
] as const;

type AbaId = (typeof ABAS)[number]['id'];

export default function ClientesPage() {
  const { user, status: authStatus, signOut, retry } = useAuth({ requireAuth: true });

  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [responsaveis, setResponsaveis] = useState<Responsavel[]>([]);

  const [aba, setAba] = useState<AbaId>('painel');
  const [filtros, setFiltros] = useState<TipoFiltros>({});
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [importando, setImportando] = useState(false);

  const [clientes, setClientes] = useState<ClienteResumo[]>([]);
  const [total, setTotal] = useState(0);
  const [colunas, setColunas] = useState<
    Array<{ id: string; label: string; cor: string; total: number; clientes: ClienteResumo[] }>
  >([]);

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  const permissoes = user?.permissoes;
  const podeEditar = Boolean(permissoes?.editar);
  const podeExcluir = Boolean(permissoes?.gerenciarUsuarios);

  // ------------------------------------------------------------ carregar

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    let vivo = true;

    Promise.all([clientesApi.pipeline(), clientesApi.responsaveis()])
      .then(([dadosPipeline, dadosResponsaveis]) => {
        if (!vivo) return;
        setPipeline(dadosPipeline);
        setResponsaveis(dadosResponsaveis.responsaveis);
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Falha ao carregar'));

    return () => {
      vivo = false;
    };
  }, [authStatus]);

  useEffect(() => {
    // O painel busca os proprios numeros; a ficha aberta cobre a tela.
    if (authStatus !== 'authenticated' || aba === 'painel' || selecionado) return;

    let vivo = true;

    const consulta =
      aba === 'kanban'
        ? clientesApi.kanban(filtros).then((r) => vivo && setColunas(r.colunas))
        : clientesApi.listar(filtros).then((r) => {
            if (!vivo) return;
            setClientes(r.clientes);
            setTotal(r.total);
          });

    consulta
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Falha ao carregar clientes'))
      .finally(() => vivo && setCarregando(false));

    return () => {
      vivo = false;
    };
  }, [authStatus, aba, filtros, selecionado, recarga]);

  /**
   * Quem liga o "carregando" e a ACAO, nao o efeito.
   *
   * Um efeito nao pode alterar estado de forma sincrona (isso encadeia
   * renderizacoes), e a intencao de recarregar nasce aqui de qualquer forma:
   * trocar de aba, mexer no filtro, salvar uma ficha.
   */
  const recarregar = useCallback(() => {
    setCarregando(true);
    setRecarga((n) => n + 1);
  }, []);

  const trocarAba = (id: AbaId) => {
    if (id !== 'painel') setCarregando(true);
    setAba(id);
  };

  const aplicarFiltros = (novos: TipoFiltros) => {
    setCarregando(true);
    setFiltros(novos);
  };

  /** Um indicador do painel leva para a lista ja filtrada. */
  const filtrarDoPainel = (novos: TipoFiltros) => {
    setCarregando(true);
    setFiltros(novos);
    setAba('lista');
  };

  const fecharFicha = () => {
    setCarregando(true);
    setSelecionado(null);
  };

  const mover = async (clienteId: string, colunaId: string) => {
    await clientesApi.mover(clienteId, colunaId);
    recarregar();
  };

  const carregarMais = () => {
    const proximo = String(clientes.length);
    clientesApi
      .listar({ ...filtros, pular: proximo })
      .then((r) => setClientes((atual) => [...atual, ...r.clientes]))
      .catch(() => {});
  };

  // ------------------------------------------------------------- estados

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

  if (authStatus !== 'authenticated' || !pipeline) {
    return (
      <main className="grid min-h-screen place-items-center bg-navy-950">
        <Loader2 className="h-6 w-6 animate-spin text-gold-400" />
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-navy-950">
      <header className="sticky top-0 z-30 border-b border-navy-800 bg-navy-900/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3.5">
          <BrandLockup compact />

          <div className="flex items-center gap-2">
            <Link
              href="/connections"
              className="hidden rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300 sm:inline-flex"
            >
              Conexoes
            </Link>
            <Link
              href="/conversas"
              className="hidden rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300 sm:inline-flex"
            >
              Conversas
            </Link>
            <Link
              href="/curadoria"
              className="hidden rounded-lg border border-navy-800 px-3 py-1.5 text-xs text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300 sm:inline-flex"
            >
              Curadoria
            </Link>
            <button
              onClick={signOut}
              aria-label="Sair"
              className="rounded-lg border border-navy-800 p-2 text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {selecionado ? (
          <Ficha
            clienteId={selecionado}
            pipeline={pipeline}
            responsaveis={responsaveis}
            podeEditar={podeEditar}
            podeExcluir={podeExcluir}
            aoVoltar={fecharFicha}
            aoMudar={recarregar}
          />
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl tracking-wide text-cream">Clientes</h1>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
                  Acompanhamento de toda a carteira: onde cada pessoa esta, o que estamos
                  aguardando e qual e o proximo passo.
                </p>
              </div>

              {podeEditar && (
                <div className="flex items-center gap-2">
                  <Botao aparencia="discreto" aoClicar={() => setImportando(true)}>
                    <Upload size={15} />
                    Importar planilha
                  </Botao>
                  <Botao aparencia="secundario" aoClicar={() => setCriando(true)}>
                    <Plus size={15} />
                    Novo cliente
                  </Botao>
                </div>
              )}
            </div>

            <nav className="flex gap-1 border-b border-navy-800">
              {ABAS.map(({ id, label, Icone }) => (
                <button
                  key={id}
                  onClick={() => trocarAba(id)}
                  className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition-colors ${
                    aba === id
                      ? 'border-gold-500 text-gold-200'
                      : 'border-transparent text-muted hover:text-parchment'
                  }`}
                >
                  <Icone size={15} />
                  {label}
                </button>
              ))}
            </nav>

            {erro && (
              <p className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
                {erro}
              </p>
            )}

            {aba === 'painel' ? (
              <PainelOperacional aoFiltrar={filtrarDoPainel} aoAbrirCliente={setSelecionado} />
            ) : (
              <div className="space-y-5">
                <Filtros
                  filtros={filtros}
                  aoMudar={aplicarFiltros}
                  pipeline={pipeline}
                  responsaveis={responsaveis}
                  total={aba === 'lista' ? total : undefined}
                />

                {aba === 'lista' ? (
                  <Lista
                    clientes={clientes}
                    total={total}
                    carregando={carregando}
                    aoAbrir={setSelecionado}
                    aoCarregarMais={carregarMais}
                  />
                ) : (
                  <Kanban
                    colunas={colunas}
                    carregando={carregando}
                    podeEditar={podeEditar}
                    aoAbrir={setSelecionado}
                    aoMover={mover}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {importando && (
        <Importar aoFechar={() => setImportando(false)} aoConcluir={recarregar} />
      )}

      {criando && (
        <NovoCliente
          aoFechar={() => setCriando(false)}
          aoCriar={(id) => {
            setCriando(false);
            setSelecionado(id);
            recarregar();
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------- cadastro

function NovoCliente({
  aoFechar,
  aoCriar,
}: {
  aoFechar: () => void;
  aoCriar: (id: string) => void;
}) {
  const [dados, setDados] = useState({ nome: '', telefone: '', email: '' });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [existente, setExistente] = useState<string | null>(null);

  const criar = async () => {
    setSalvando(true);
    setErro(null);
    setExistente(null);
    try {
      const { cliente } = await clientesApi.criar(dados);
      aoCriar(cliente.id);
    } catch (e) {
      const mensagem = e instanceof Error ? e.message : 'Nao foi possivel cadastrar.';
      setErro(mensagem);
      // O servidor responde 409 com o id do cliente que ja existe; oferecer a
      // ficha existente e melhor do que deixar a pessoa procurar na lista.
      if (mensagem.includes('Ja existe')) setExistente('procure pelo telefone na lista');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal
      titulo="Novo cliente"
      subtitulo="Quem chega pelo WhatsApp entra sozinho. Este cadastro e para quem veio por outro caminho."
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao aoClicar={aoFechar} desabilitado={salvando}>
            Cancelar
          </Botao>
          <Botao
            aparencia="principal"
            aoClicar={criar}
            desabilitado={salvando || dados.telefone.replace(/\D/g, '').length < 10}
          >
            {salvando ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Cadastrar
          </Botao>
        </>
      }
    >
      <div className="space-y-5">
        {erro && (
          <p className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
            {erro}
            {existente && <span className="block text-xs text-red-200/70">{existente}</span>}
          </p>
        )}

        <Campo titulo="Nome">
          <EntradaTexto valor={dados.nome} aoMudar={(nome) => setDados({ ...dados, nome })} />
        </Campo>

        <Campo
          titulo="Telefone"
          obrigatorio
          explicacao="Com DDD. E por ele que a ficha se conecta as conversas de WhatsApp desta pessoa."
        >
          <EntradaTexto
            valor={dados.telefone}
            aoMudar={(telefone) => setDados({ ...dados, telefone })}
            placeholder="(19) 99638-3884"
          />
        </Campo>

        <Campo titulo="E-mail">
          <EntradaTexto
            tipo="email"
            valor={dados.email}
            aoMudar={(email) => setDados({ ...dados, email })}
          />
        </Campo>
      </div>
    </Modal>
  );
}
