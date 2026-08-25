'use client';

import React, { useState } from 'react';
import {
  Check,
  Copy,
  Loader2,
  MessageSquareQuote,
  RefreshCw,
  Send,
  Sparkles,
  TriangleAlert,
  Wand2,
} from 'lucide-react';
import { Botao } from '@/components/ui/base';
import { clientesApi, dataHora, type ClienteDetalhe, type Sugestao } from '@/lib/clientes';

/**
 * RESUMO INTELIGENTE, ASSISTENTE E SUGESTOES
 * ------------------------------------------
 * O que transforma a ficha em copiloto: em vez de ler dezenas de mensagens, o
 * colaborador le um paragrafo, copia a versao para o cliente e envia.
 *
 * As duas versoes do resumo vem de chamadas separadas no servidor, cada uma
 * com o seu material — a que escreve para o cliente nunca ve observacao
 * interna, tarefa ou nome de responsavel. Aqui na tela elas so aparecem
 * separadas o suficiente para ninguem copiar a errada: o botao de copiar
 * existe apenas na versao do cliente.
 */

export default function Inteligencia({
  cliente,
  desatualizado,
  perguntasSugeridas,
  podeUsar,
  aoAplicarSugestoes,
}: {
  cliente: ClienteDetalhe;
  desatualizado: boolean;
  perguntasSugeridas: string[];
  podeUsar: boolean;
  aoAplicarSugestoes: (cliente: ClienteDetalhe) => void;
}) {
  const [resumo, setResumo] = useState(cliente.resumo);
  const [bloqueado, setBloqueado] = useState<string | null>(null);
  const [semMaterial, setSemMaterial] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [velho, setVelho] = useState(desatualizado);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const gerar = async (forcar: boolean) => {
    setGerando(true);
    setErro(null);
    setBloqueado(null);
    try {
      const resultado = await clientesApi.resumo(cliente.id, forcar);

      setSemMaterial(Boolean(resultado.semMaterial));
      setBloqueado(resultado.bloqueado || null);
      setResumo({
        interno: resultado.interno,
        cliente: resultado.cliente,
        geradoEm: resultado.geradoEm,
        geradoPor: resultado.geradoPor,
      });
      setVelho(false);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao consegui gerar o resumo agora.');
    } finally {
      setGerando(false);
    }
  };

  const copiar = async () => {
    if (!resumo?.cliente) return;
    try {
      await navigator.clipboard.writeText(resumo.cliente);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      setErro('O navegador nao permitiu copiar. Selecione o texto e copie manualmente.');
    }
  };

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------ resumo inteligente */}
      <section className="rounded-2xl border border-gold-500/25 bg-gold-500/[0.03] p-5">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-gold-400" />
            <h2 className="font-display text-base tracking-wide text-cream">Resumo inteligente</h2>
          </div>

          <div className="flex items-center gap-3">
            {resumo?.geradoEm && (
              <span className="text-xs text-muted">
                gerado {dataHora(resumo.geradoEm)}
                {resumo.geradoPor ? ` · ${resumo.geradoPor}` : ''}
              </span>
            )}
            {podeUsar && (
              <Botao aparencia="discreto" aoClicar={() => gerar(true)} desabilitado={gerando}>
                {gerando ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {resumo ? 'Gerar novamente' : 'Gerar resumo'}
              </Botao>
            )}
          </div>
        </header>

        {velho && resumo && (
          <p className="mb-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/5 px-3.5 py-2.5 text-xs leading-relaxed text-amber-100/90">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            O caso mudou depois deste resumo. Gere novamente antes de usar com o cliente.
          </p>
        )}

        {erro && (
          <p className="mb-4 rounded-xl border border-red-500/30 bg-red-500/5 px-3.5 py-2.5 text-sm text-red-200">
            {erro}
          </p>
        )}

        {semMaterial ? (
          <p className="text-sm leading-relaxed text-muted">
            Ainda nao ha material suficiente nesta ficha para um resumo. Registre o status, a etapa
            ou uma observacao e gere novamente — o resumo nunca preenche lacuna com suposicao.
          </p>
        ) : !resumo ? (
          <p className="text-sm leading-relaxed text-muted">
            Nenhum resumo gerado ainda. A IA le a ficha, o historico e as conversas e escreve duas
            versoes: uma para a equipe e outra pronta para enviar ao cliente.
          </p>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {/* interno */}
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-[0.2em] text-muted">
                Para a equipe
              </h3>
              <p className="whitespace-pre-line rounded-xl border border-navy-800 bg-navy-900/60 p-4 text-sm leading-relaxed text-parchment">
                {resumo.interno || '—'}
              </p>
            </div>

            {/* cliente */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-xs uppercase tracking-[0.2em] text-gold-400/80">
                  Para enviar ao cliente
                </h3>
                {resumo.cliente && (
                  <button
                    onClick={copiar}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gold-500/40 px-2.5 py-1 text-xs text-gold-200 transition-colors hover:border-gold-400"
                  >
                    {copiado ? <Check size={12} /> : <Copy size={12} />}
                    {copiado ? 'Copiado' : 'Copiar'}
                  </button>
                )}
              </div>

              {bloqueado ? (
                <p className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-4 text-sm leading-relaxed text-amber-100/90">
                  {bloqueado}
                </p>
              ) : (
                <p className="whitespace-pre-line rounded-xl border border-gold-500/25 bg-navy-900/60 p-4 text-sm leading-relaxed text-parchment">
                  {resumo.cliente || '—'}
                </p>
              )}

              <p className="mt-2 text-xs leading-relaxed text-muted">
                Escrito sem nenhuma informacao interna. Revise antes de enviar — o texto e um
                rascunho, nao uma mensagem aprovada.
              </p>
            </div>
          </div>
        )}
      </section>

      {podeUsar && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Assistente cliente={cliente} perguntas={perguntasSugeridas} />
          <Sugestoes cliente={cliente} aoAplicar={aoAplicarSugestoes} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- assistente

function Assistente({ cliente, perguntas }: { cliente: ClienteDetalhe; perguntas: string[] }) {
  const [pergunta, setPergunta] = useState('');
  const [conversa, setConversa] = useState<Array<{ pergunta: string; resposta: string; aviso: string | null }>>([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const perguntar = async (texto: string) => {
    const limpo = texto.trim();
    if (!limpo || carregando) return;

    setPergunta('');
    setErro(null);
    setCarregando(true);
    try {
      const resultado = await clientesApi.assistente(cliente.id, limpo);
      setConversa((atual) => [
        ...atual,
        { pergunta: limpo, resposta: resultado.resposta, aviso: resultado.aviso },
      ]);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao consegui responder agora.');
      setPergunta(limpo);
    } finally {
      setCarregando(false);
    }
  };

  return (
    <section className="flex flex-col rounded-2xl border border-navy-800 p-5">
      <header className="mb-3 flex items-center gap-2">
        <MessageSquareQuote size={15} className="text-gold-400" />
        <h2 className="font-display text-base tracking-wide text-cream">Perguntar sobre este cliente</h2>
      </header>

      <p className="mb-4 text-xs leading-relaxed text-muted">
        Responde usando apenas os dados desta ficha. Se a informacao nao estiver registrada, diz que
        nao sabe — em vez de deduzir.
      </p>

      {conversa.length === 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {perguntas.slice(0, 4).map((p) => (
            <button
              key={p}
              onClick={() => perguntar(p)}
              className="rounded-lg border border-navy-800 px-2.5 py-1.5 text-left text-xs text-parchment/75 transition-colors hover:border-gold-500/40 hover:text-gold-200"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="scrollbar-thin mb-4 max-h-72 flex-1 space-y-4 overflow-y-auto">
        {conversa.map((turno, i) => (
          <div key={i} className="space-y-2">
            <p className="text-xs text-gold-300/80">{turno.pergunta}</p>
            <p className="whitespace-pre-line rounded-xl border border-navy-800 bg-navy-900/60 p-3.5 text-sm leading-relaxed text-parchment">
              {turno.resposta}
            </p>
            {turno.aviso && (
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-200/85">
                <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                {turno.aviso}
              </p>
            )}
          </div>
        ))}

        {carregando && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={13} className="animate-spin text-gold-400" />
            consultando a ficha…
          </div>
        )}
      </div>

      {erro && <p className="mb-3 text-sm text-red-200">{erro}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          perguntar(pergunta);
        }}
        className="flex items-center gap-2"
      >
        <input
          value={pergunta}
          onChange={(e) => setPergunta(e.target.value)}
          placeholder="O que estamos aguardando?"
          className="flex-1 rounded-xl border border-navy-800 bg-navy-900/60 px-3.5 py-2.5 text-sm text-cream placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none"
        />
        <Botao tipo="submit" aparencia="secundario" desabilitado={!pergunta.trim() || carregando}>
          <Send size={14} />
        </Botao>
      </form>
    </section>
  );
}

// -------------------------------------------------------------- sugestoes

function Sugestoes({
  cliente,
  aoAplicar,
}: {
  cliente: ClienteDetalhe;
  aoAplicar: (cliente: ClienteDetalhe) => void;
}) {
  const [sugestoes, setSugestoes] = useState<Sugestao[] | null>(null);
  const [justificativa, setJustificativa] = useState<string | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);
  const [escolhidas, setEscolhidas] = useState<Set<string>>(new Set());
  const [carregando, setCarregando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const analisar = async () => {
    setCarregando(true);
    setErro(null);
    setMotivo(null);
    try {
      const resultado = await clientesApi.sugestoes(cliente.id);
      setSugestoes(resultado.sugestoes);
      setJustificativa(resultado.justificativa);
      setMotivo(resultado.motivo || null);
      // Tudo marcado por padrao: o colaborador desmarca o que discorda, que e
      // mais rapido do que marcar uma a uma o que ja esta certo.
      setEscolhidas(new Set(resultado.sugestoes.map((s) => s.campo)));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao consegui analisar agora.');
    } finally {
      setCarregando(false);
    }
  };

  const aplicar = async () => {
    const selecionadas = (sugestoes || []).filter((s) => escolhidas.has(s.campo));
    if (!selecionadas.length) return;

    setAplicando(true);
    setErro(null);
    try {
      const { cliente: atualizado } = await clientesApi.aplicarSugestoes(cliente.id, selecionadas);
      aoAplicar(atualizado);
      setSugestoes(null);
      setJustificativa(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao consegui aplicar.');
    } finally {
      setAplicando(false);
    }
  };

  return (
    <section className="flex flex-col rounded-2xl border border-navy-800 p-5">
      <header className="mb-3 flex items-center gap-2">
        <Wand2 size={15} className="text-gold-400" />
        <h2 className="font-display text-base tracking-wide text-cream">Sugestoes de preenchimento</h2>
      </header>

      <p className="mb-4 text-xs leading-relaxed text-muted">
        A IA le a conversa recente e propoe como atualizar a ficha. Nada e aplicado sozinho: voce
        confirma o que concorda.
      </p>

      {erro && <p className="mb-3 text-sm text-red-200">{erro}</p>}

      {motivo && <p className="mb-3 text-sm text-muted">{motivo}</p>}

      {sugestoes && sugestoes.length === 0 && !motivo && (
        <p className="mb-3 text-sm text-muted">
          Nada a sugerir: a ficha ja reflete o que a conversa mostra.
        </p>
      )}

      {sugestoes && sugestoes.length > 0 && (
        <div className="mb-4 space-y-2">
          {justificativa && (
            <p className="border-l-2 border-gold-500/30 pl-3 text-xs italic leading-relaxed text-parchment/60">
              {justificativa}
            </p>
          )}

          {sugestoes.map((sugestao) => {
            const marcada = escolhidas.has(sugestao.campo);
            return (
              <button
                key={sugestao.campo}
                onClick={() =>
                  setEscolhidas((atual) => {
                    const copia = new Set(atual);
                    if (copia.has(sugestao.campo)) copia.delete(sugestao.campo);
                    else copia.add(sugestao.campo);
                    return copia;
                  })
                }
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                  marcada ? 'border-gold-500/40 bg-gold-500/5' : 'border-navy-800 opacity-60'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    marcada ? 'border-gold-500 bg-gold-500 text-navy-950' : 'border-navy-600'
                  }`}
                >
                  {marcada && <Check size={11} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs uppercase tracking-wider text-muted">
                    {sugestao.rotulo}
                  </span>
                  <span className="block text-sm leading-relaxed text-parchment">
                    {sugestao.exibicao}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-auto flex items-center gap-2">
        <Botao aparencia="discreto" aoClicar={analisar} desabilitado={carregando}>
          {carregando ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {sugestoes ? 'Analisar de novo' : 'Analisar conversa'}
        </Botao>

        {sugestoes && sugestoes.length > 0 && (
          <Botao
            aparencia="principal"
            aoClicar={aplicar}
            desabilitado={aplicando || escolhidas.size === 0}
          >
            {aplicando ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Aplicar {escolhidas.size}
          </Botao>
        )}
      </div>
    </section>
  );
}
