'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Loader2, RotateCcw, Send, ShieldAlert, Sparkles } from 'lucide-react';
import { Botao, Selo } from '@/components/ui/base';
import { curadoriaApi, type ConfiguracaoAgente, type MensagemTeste, type RespostaTeste } from '@/lib/curadoria';

/**
 * TESTAR AGENTE
 * -------------
 * Conversa com a configuracao que esta NA TELA — inclusive alteracoes que
 * ainda nao viraram rascunho salvo. Exigir salvar antes de testar empurraria a
 * pessoa a salvar coisas pela metade so para poder experimentar.
 *
 * O servidor roda o mesmo pipeline do atendimento real (mesmo prompt, mesmas
 * regras, mesmos guardrails), sem gravar nada e sem falar com ninguem no
 * WhatsApp.
 */

interface Turno {
  role: 'user' | 'assistant';
  text: string;
  diagnostico?: RespostaTeste['diagnostico'];
  bloqueado?: boolean;
}

const SUGESTOES = [
  'Oi, tudo bem?',
  'Fui demitido e nao recebi nada, o que eu faco?',
  'Quanto voces cobram?',
  'Vou ganhar quanto no processo?',
];

export default function PainelTeste({
  agentId,
  config,
  temAlteracoesNaoSalvas,
}: {
  agentId: string;
  config: ConfiguracaoAgente;
  temAlteracoesNaoSalvas: boolean;
}) {
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [entrada, setEntrada] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ontologia, setOntologia] = useState<Record<string, unknown> | null>(null);
  const [instrucoes, setInstrucoes] = useState<string | null>(null);
  const [verInstrucoes, setVerInstrucoes] = useState(false);

  const fim = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turnos, carregando]);

  const enviar = async (texto: string) => {
    const mensagem = texto.trim();
    if (!mensagem || carregando) return;

    setEntrada('');
    setErro(null);
    setCarregando(true);
    setTurnos((atual) => [...atual, { role: 'user', text: mensagem }]);

    // O historico enviado e o de ANTES desta mensagem: o servidor recebe a
    // mensagem nova em separado, como acontece no WhatsApp.
    const historico: MensagemTeste[] = turnos.map((t) => ({ role: t.role, text: t.text }));

    try {
      const resposta = await curadoriaApi.testar(agentId, {
        config,
        mensagem,
        historico,
        ontologia,
      });

      setOntologia(resposta.ontologia || null);
      setInstrucoes(resposta.instrucoes || null);
      setTurnos((atual) => [
        ...atual,
        {
          role: 'assistant',
          text: resposta.resposta || '(sem resposta — o agente ficou em silencio de proposito)',
          diagnostico: resposta.diagnostico,
          bloqueado: resposta.bloqueado,
        },
      ]);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Nao foi possivel testar agora.');
      // A mensagem do curador volta para a caixa: ele nao perde o que escreveu.
      setTurnos((atual) => atual.slice(0, -1));
      setEntrada(mensagem);
    } finally {
      setCarregando(false);
    }
  };

  const recomecar = () => {
    setTurnos([]);
    setOntologia(null);
    setInstrucoes(null);
    setErro(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* ------------------------------------------------------ contexto */}
      <div className="flex flex-wrap items-center gap-2 border-b border-navy-800 pb-4">
        <Selo cor="atencao">
          <Sparkles size={12} />
          Conversa de teste
        </Selo>
        {temAlteracoesNaoSalvas && <Selo cor="espera">usando o que esta na tela agora</Selo>}
        {turnos.length > 0 && (
          <button
            onClick={recomecar}
            className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-gold-300"
          >
            <RotateCcw size={12} />
            Comecar de novo
          </button>
        )}
      </div>

      <p className="py-3 text-xs leading-relaxed text-muted">
        Ninguem de fora recebe estas mensagens e nada e gravado no historico de conversas. O agente
        responde com a configuracao que voce esta editando.
      </p>

      {/* ------------------------------------------------------ conversa */}
      <div className="scrollbar-thin min-h-64 flex-1 space-y-4 overflow-y-auto py-2">
        {turnos.length === 0 && (
          <div className="space-y-3 py-4">
            <p className="text-sm text-muted">Comece por uma destas, ou escreva a sua:</p>
            <div className="flex flex-wrap gap-2">
              {SUGESTOES.map((sugestao) => (
                <button
                  key={sugestao}
                  onClick={() => enviar(sugestao)}
                  className="rounded-xl border border-navy-800 px-3 py-2 text-left text-xs text-parchment/80 transition-colors hover:border-gold-500/40 hover:text-gold-200"
                >
                  {sugestao}
                </button>
              ))}
            </div>
          </div>
        )}

        {turnos.map((turno, indice) => (
          <div
            key={indice}
            className={`flex ${turno.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`max-w-[85%] space-y-2 ${turno.role === 'user' ? 'items-end' : ''}`}>
              <div
                className={`whitespace-pre-line rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  turno.role === 'user'
                    ? 'rounded-br-sm bg-gold-500/15 text-cream'
                    : turno.bloqueado
                      ? 'rounded-bl-sm border border-amber-400/25 bg-amber-400/5 text-amber-100'
                      : 'rounded-bl-sm border border-navy-800 bg-navy-900/70 text-parchment'
                }`}
              >
                {turno.text}
              </div>

              {turno.role === 'assistant' && turno.diagnostico && (
                <Diagnostico diagnostico={turno.diagnostico} bloqueado={turno.bloqueado} />
              )}
            </div>
          </div>
        ))}

        {carregando && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-navy-800 bg-navy-900/70 px-4 py-3">
              <Loader2 size={14} className="animate-spin text-gold-400" />
              <span className="text-xs text-muted">escrevendo…</span>
            </div>
          </div>
        )}

        <div ref={fim} />
      </div>

      {erro && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-200">
          {erro}
        </p>
      )}

      {/* -------------------------------------------------------- escrita */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          enviar(entrada);
        }}
        className="flex items-end gap-2 border-t border-navy-800 pt-4"
      >
        <textarea
          value={entrada}
          onChange={(e) => setEntrada(e.target.value)}
          onKeyDown={(e) => {
            // Enter envia, Shift+Enter quebra linha: e o que o WhatsApp faz, e
            // a pessoa esta justamente simulando uma conversa de WhatsApp.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              enviar(entrada);
            }
          }}
          rows={1}
          placeholder="Escreva como se fosse a pessoa do outro lado…"
          className="max-h-32 flex-1 resize-none rounded-xl border border-navy-800 bg-navy-900/60 px-4 py-3 text-sm text-cream placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none"
        />
        <Botao tipo="submit" aparencia="principal" desabilitado={!entrada.trim() || carregando}>
          <Send size={15} />
          Enviar
        </Botao>
      </form>

      {/* --------------------------------------------- instrucoes montadas */}
      {instrucoes && (
        <div className="mt-4 border-t border-navy-800 pt-4">
          <button
            onClick={() => setVerInstrucoes((v) => !v)}
            className="inline-flex items-center gap-2 text-xs text-muted transition-colors hover:text-gold-300"
          >
            {verInstrucoes ? <EyeOff size={13} /> : <Eye size={13} />}
            {verInstrucoes ? 'Esconder' : 'Ver'} tudo o que o agente recebeu nesta resposta
          </button>

          {verInstrucoes && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                E o texto completo que chegou ate ele: o que voce escreveu, mais o que o sistema
                acrescenta sozinho a cada conversa.
              </p>
              <pre className="scrollbar-thin mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-navy-800 bg-navy-950/60 p-4 text-xs leading-relaxed text-parchment/70">
                {instrucoes}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Por que o agente respondeu assim.
 *
 * Nada aqui e nome de modelo, custo ou tier: sao os fatos da conversa que
 * explicam a resposta. E o que permite ao curador ligar causa e efeito sem
 * precisar entender o motor.
 */
function Diagnostico({
  diagnostico,
  bloqueado,
}: {
  diagnostico: RespostaTeste['diagnostico'];
  bloqueado?: boolean;
}) {
  const marcas: Array<{ texto: string; cor: 'neutro' | 'atencao' | 'espera' }> = [];

  if (bloqueado) marcas.push({ texto: 'barrado antes de chegar ao agente', cor: 'atencao' });
  if (diagnostico.cuidadoRedobrado) marcas.push({ texto: 'caso sensivel: cuidado redobrado', cor: 'atencao' });
  if (diagnostico.reescrita) marcas.push({ texto: 'resposta reescrita pelas regras', cor: 'atencao' });
  if (diagnostico.encaminhado) marcas.push({ texto: 'marcado para atendimento humano', cor: 'atencao' });
  if (diagnostico.baseConsultada?.length) {
    marcas.push({ texto: `consultou: ${diagnostico.baseConsultada.join(', ')}`, cor: 'espera' });
  }
  if (diagnostico.faltaDescobrir?.length) {
    marcas.push({ texto: `ainda falta saber: ${diagnostico.faltaDescobrir.join(', ')}`, cor: 'neutro' });
  }

  if (!marcas.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {bloqueado && <ShieldAlert size={12} className="text-amber-300" />}
      {marcas.map((marca) => (
        <Selo key={marca.texto} cor={marca.cor}>
          {marca.texto}
        </Selo>
      ))}
    </div>
  );
}
