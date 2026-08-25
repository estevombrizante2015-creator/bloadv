'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  FileClock,
  Loader2,
  LogOut,
  RefreshCw,
  Users,
  WifiOff,
} from 'lucide-react';
import { BrandLockup } from '@/components/Brand';
import { Botao, Selo } from '@/components/ui/base';
import EditorAgente from '@/components/curadoria/EditorAgente';
import Usuarios from '@/components/curadoria/Usuarios';
import { useAuth } from '@/hooks/useAuth';
import { curadoriaApi, formatarData, type AgenteResumo, type Opcoes } from '@/lib/curadoria';

/**
 * CURADORIA DOS AGENTES
 * ---------------------
 * A tela pela qual a equipe do escritorio evolui o comportamento dos agentes
 * depois da entrega, sem tocar em codigo, arquivo, banco ou deploy.
 *
 * A separacao que o produto inteiro sustenta:
 *
 *   motor do agente  -> responsabilidade tecnica  (pipeline, guardrails, modelos)
 *   conteudo e tom   -> responsabilidade da equipe (esta tela)
 *
 * Nada aqui expoe chave, modelo, banco ou variavel de ambiente. Se um campo
 * desta interface precisar de explicacao tecnica para ser preenchido, ele esta
 * no lugar errado.
 */
export default function CuradoriaPage() {
  const { user, status: authStatus, signOut, retry } = useAuth({ requireAuth: true });

  const [opcoes, setOpcoes] = useState<Opcoes | null>(null);
  const [agentes, setAgentes] = useState<AgenteResumo[]>([]);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [verAcessos, setVerAcessos] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregarAgentes = useCallback(() => {
    curadoriaApi
      .agentes()
      .then((r) => setAgentes(r.agentes))
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar os agentes'));
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;

    Promise.all([curadoriaApi.opcoes(), curadoriaApi.agentes()])
      .then(([opcoesCarregadas, listaAgentes]) => {
        setOpcoes(opcoesCarregadas);
        setAgentes(listaAgentes.agentes);
      })
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar a curadoria'))
      .finally(() => setCarregando(false));
  }, [authStatus]);

  // Servidor fora do ar NAO desloga: a sessao continua e a tela espera.
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

  if (authStatus !== 'authenticated' || carregando) {
    return (
      <main className="grid min-h-screen place-items-center bg-navy-950">
        <Loader2 className="h-6 w-6 animate-spin text-gold-400" />
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-navy-950">
      {/* ------------------------------------------------ barra superior */}
      <header className="sticky top-0 z-30 border-b border-navy-800 bg-navy-900/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3.5">
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
            <button
              onClick={signOut}
              className="rounded-lg border border-navy-800 p-2 text-muted transition-colors hover:border-gold-500/40 hover:text-gold-300"
              aria-label="Sair"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {erro && (
          <p className="mb-6 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
            {erro}
          </p>
        )}

        {!opcoes ? null : selecionado ? (
          <EditorAgente
            agentId={selecionado}
            opcoes={opcoes}
            aoVoltar={() => setSelecionado(null)}
            aoAtualizarLista={carregarAgentes}
          />
        ) : verAcessos ? (
          <div className="space-y-6">
            <button
              onClick={() => setVerAcessos(false)}
              className="text-sm text-muted transition-colors hover:text-gold-300"
            >
              ← Voltar para os agentes
            </button>
            <Usuarios opcoes={opcoes} meuId={user?.id} />
          </div>
        ) : (
          <ListaAgentes
            agentes={agentes}
            opcoes={opcoes}
            aoAbrir={setSelecionado}
            aoVerAcessos={() => setVerAcessos(true)}
          />
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------- lista

function ListaAgentes({
  agentes,
  opcoes,
  aoAbrir,
  aoVerAcessos,
}: {
  agentes: AgenteResumo[];
  opcoes: Opcoes;
  aoAbrir: (id: string) => void;
  aoVerAcessos: () => void;
}) {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-wide text-cream">Curadoria dos agentes</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Aqui voce ajusta como cada agente conversa: o que ele faz, o tom, as regras, as
            mensagens e as informacoes do escritorio. As alteracoes so entram em operacao quando
            voce publica, e da para testar antes.
          </p>
        </div>

        {opcoes.permissoes.gerenciarUsuarios && (
          <Botao aparencia="discreto" aoClicar={aoVerAcessos}>
            <Users size={15} />
            Acessos
          </Botao>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {agentes.map((agente) => {
          const ativo = agente.status === 'active';

          return (
            <button
              key={agente.id}
              onClick={() => aoAbrir(agente.id)}
              className="group flex flex-col rounded-2xl border border-navy-800 bg-navy-900/40 p-6 text-left transition-colors hover:border-gold-500/40"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
                      ativo ? 'border-emerald-400/25 bg-emerald-400/10' : 'border-navy-700 bg-navy-850'
                    }`}
                  >
                    <Bot size={18} className={ativo ? 'text-emerald-300' : 'text-muted'} />
                  </span>
                  <div>
                    <h2 className="font-display text-lg tracking-wide text-cream">{agente.label}</h2>
                    <Selo cor={ativo ? 'ativo' : 'espera'}>{ativo ? 'Ativo' : 'Em espera'}</Selo>
                  </div>
                </div>

                <ArrowRight
                  size={18}
                  className="mt-2 text-navy-600 transition-colors group-hover:text-gold-400"
                />
              </div>

              <p className="mt-4 text-sm leading-relaxed text-muted">{agente.descricao}</p>

              {agente.numeros.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {agente.numeros.map((numero) => (
                    <Selo key={numero}>{numero}</Selo>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-xs text-muted">Nenhum numero vinculado ainda.</p>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-navy-800 pt-4 text-xs text-muted">
                {agente.nuncaPublicada ? (
                  <span>Configuracao original, nunca editada</span>
                ) : (
                  <span>
                    Versao {agente.versao} · {formatarData(agente.publicadaEm)}
                    {agente.publicadaPor ? ` · ${agente.publicadaPor}` : ''}
                  </span>
                )}

                {agente.temRascunho && (
                  <Selo cor="atencao">
                    <FileClock size={11} />
                    rascunho nao publicado
                  </Selo>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-xs leading-relaxed text-muted">
        Um agente <span className="text-parchment/70">em espera</span> esta pronto e configuravel,
        mas nao responde automaticamente. Ele pode ser ativado por um administrador a qualquer
        momento, sem alteracao no sistema.
      </p>
    </div>
  );
}
