'use client';

import React, { useEffect, useState } from 'react';
import { History, Loader2, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react';
import { Botao, Modal, Secao, Selo } from '@/components/ui/base';
import { Comparacao } from './Comparacao';
import { curadoriaApi, formatarData, type VersaoDetalhe, type VersaoResumo } from '@/lib/curadoria';

/**
 * HISTORICO E RESTAURACAO
 * -----------------------
 * Existe para uma situacao especifica: alguem publicou algo que piorou o
 * atendimento e precisa voltar atras agora, sem chamar ninguem.
 *
 * Restaurar NAO apaga o que veio depois. A versao 12 continua sendo a 12, e a
 * volta a ela vira uma versao nova marcada como restauracao. Apagar o
 * intervalo esconderia justamente o erro que motivou a volta.
 */
export default function Historico({
  agentId,
  podeRestaurar,
  aoRestaurar,
}: {
  agentId: string;
  podeRestaurar: boolean;
  aoRestaurar: () => void;
}) {
  const [versoes, setVersoes] = useState<VersaoResumo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [detalhe, setDetalhe] = useState<VersaoDetalhe | null>(null);
  const [confirmando, setConfirmando] = useState<VersaoDetalhe | null>(null);
  const [restaurando, setRestaurando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  /**
   * Recarga por contador em vez de uma funcao chamada no efeito.
   *
   * O efeito nao pode mexer em estado de forma sincrona - isso encadeia
   * renderizacoes. Mudar o contador e um evento (clique, restauracao
   * concluida); o efeito so reage a ele.
   */
  const [recarga, setRecarga] = useState(0);
  const recarregar = () => setRecarga((n) => n + 1);

  useEffect(() => {
    let vivo = true;

    curadoriaApi
      .versoes(agentId)
      .then((r) => vivo && setVersoes(r.versoes))
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Falha ao carregar o historico'))
      .finally(() => vivo && setCarregando(false));

    // Trocar de agente no meio de uma requisicao nao pode pintar o historico
    // do agente anterior.
    return () => {
      vivo = false;
    };
  }, [agentId, recarga]);

  const abrir = async (numero: number) => {
    setErro(null);
    try {
      setDetalhe(await curadoriaApi.versao(agentId, numero));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao abrir a versao');
    }
  };

  const restaurar = async () => {
    if (!confirmando) return;
    setRestaurando(true);
    try {
      await curadoriaApi.restaurar(agentId, confirmando.versao);
      setConfirmando(null);
      setDetalhe(null);
      recarregar();
      aoRestaurar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao restaurar');
    } finally {
      setRestaurando(false);
    }
  };

  if (carregando) {
    return (
      <div className="flex items-center gap-2 py-10 text-muted">
        <Loader2 size={16} className="animate-spin text-gold-400" />
        Carregando o historico…
      </div>
    );
  }

  return (
    <Secao
      titulo="Historico de versoes"
      descricao="Toda publicacao vira uma versao, com data, autor e o que mudou. Abra qualquer uma para comparar com o que esta no ar e, se precisar, voltar para ela."
    >
      {erro && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
          {erro}
        </p>
      )}

      {!versoes.length ? (
        <div className="rounded-xl border border-navy-800 bg-navy-900/40 p-6 text-center">
          <History size={20} className="mx-auto mb-3 text-navy-600" />
          <p className="text-sm text-muted">
            Nenhuma versao publicada ainda. O agente esta rodando com a configuracao original, e a
            primeira publicacao criara a versao 1.
          </p>
        </div>
      ) : (
        <ol className="space-y-2">
          {versoes.map((versao, indice) => (
            <li key={versao.versao}>
              <button
                onClick={() => abrir(versao.versao)}
                className="flex w-full items-start gap-4 rounded-xl border border-navy-800 bg-navy-900/40 p-4 text-left transition-colors hover:border-gold-500/30"
              >
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-navy-700 font-display text-sm text-gold-300">
                  {versao.versao}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-sm tracking-wide text-cream">
                      {versao.nota || 'Sem descricao'}
                    </span>
                    {indice === 0 && <Selo cor="ativo">no ar</Selo>}
                    {versao.restauradaDe !== null && (
                      <Selo cor="espera">
                        <Undo2 size={11} />
                        volta da versao {versao.restauradaDe}
                      </Selo>
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-muted">
                    {formatarData(versao.publicadaEm)} · {versao.publicadaPor}
                    {versao.alteracoes.length > 0 && (
                      <>
                        {' · '}
                        {versao.alteracoes.length}{' '}
                        {versao.alteracoes.length === 1 ? 'alteracao' : 'alteracoes'}
                      </>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {/* ------------------------------------------------ detalhe da versao */}
      {detalhe && (
        <Modal
          titulo={`Versao ${detalhe.versao}`}
          subtitulo={`${formatarData(detalhe.publicadaEm)} · publicada por ${detalhe.publicadaPor}`}
          aoFechar={() => setDetalhe(null)}
          largura="max-w-3xl"
          rodape={
            <>
              <Botao aoClicar={() => setDetalhe(null)}>Fechar</Botao>
              {podeRestaurar && detalhe.alteracoesEmRelacaoAoAtual.length > 0 && (
                <Botao aparencia="secundario" aoClicar={() => setConfirmando(detalhe)}>
                  <RotateCcw size={15} />
                  Restaurar esta versao
                </Botao>
              )}
            </>
          }
        >
          <div className="space-y-5">
            <div>
              <h3 className="mb-2 font-display text-sm tracking-wide text-cream">
                O que mudou quando esta versao foi publicada
              </h3>
              <Comparacao alteracoes={detalhe.alteracoes} />
            </div>

            <div className="border-t border-navy-800 pt-5">
              <h3 className="mb-2 font-display text-sm tracking-wide text-cream">
                Diferenca para o que esta no ar agora
              </h3>
              <p className="mb-3 text-xs text-muted">
                E isto que voltaria a valer se voce restaurar esta versao.
              </p>
              <Comparacao alteracoes={detalhe.alteracoesEmRelacaoAoAtual} />
            </div>
          </div>
        </Modal>
      )}

      {/* ------------------------------------------------------ confirmacao */}
      {confirmando && (
        <Modal
          titulo="Restaurar esta versao?"
          aoFechar={() => setConfirmando(null)}
          rodape={
            <>
              <Botao aoClicar={() => setConfirmando(null)} desabilitado={restaurando}>
                Cancelar
              </Botao>
              <Botao aparencia="principal" aoClicar={restaurar} desabilitado={restaurando}>
                {restaurando ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
                Restaurar versao {confirmando.versao}
              </Botao>
            </>
          }
        >
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/5 p-4">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-300" />
              <div className="space-y-1.5 text-sm leading-relaxed text-amber-100/90">
                <p>
                  A configuracao da versao {confirmando.versao} passa a valer no atendimento
                  imediatamente, para todas as conversas novas.
                </p>
                <p className="text-xs text-amber-200/70">
                  Nada e apagado: isto cria uma versao nova, marcada como restauracao. Se voce tiver
                  um rascunho em aberto, ele continua guardado.
                </p>
              </div>
            </div>

            <div>
              <h3 className="mb-2 font-display text-sm tracking-wide text-cream">O que volta a valer</h3>
              <Comparacao alteracoes={confirmando.alteracoesEmRelacaoAoAtual} />
            </div>
          </div>
        </Modal>
      )}
    </Secao>
  );
}
