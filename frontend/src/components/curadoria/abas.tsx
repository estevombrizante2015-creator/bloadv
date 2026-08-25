'use client';

import React, { useState } from 'react';
import { GripVertical, Lock, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  Botao,
  Campo,
  EditorTexto,
  EntradaTexto,
  Interruptor,
  Secao,
  Selo,
} from '@/components/ui/base';
import type { ChaveMensagem, ConfiguracaoAgente, Empresa, Opcoes, Regra } from '@/lib/curadoria';

/**
 * ABAS DA CONFIGURACAO
 * --------------------
 * Cada aba e um assunto que a equipe reconhece do trabalho dela ("como ele
 * fala", "o que ele nao pode dizer"), nao uma secao do objeto de configuracao.
 * Foi por isso que prompt, tom, regras e contexto viraram campos separados no
 * backend: um textarea unico seria mais simples de programar e impossivel de
 * curar a quatro maos.
 */

export interface PropsAba {
  config: ConfiguracaoAgente;
  aoMudar: (patch: Partial<ConfiguracaoAgente>) => void;
  opcoes: Opcoes;
  podeEditar: boolean;
  padrao: ConfiguracaoAgente | null;
}

/** Volta um campo ao texto de fabrica, sem mexer no resto. */
function BotaoPadrao({ aoRestaurar, visivel }: { aoRestaurar: () => void; visivel: boolean }) {
  if (!visivel) return null;
  return (
    <button
      type="button"
      onClick={aoRestaurar}
      className="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-gold-300"
    >
      <RotateCcw size={12} />
      Voltar ao texto original
    </button>
  );
}

// -------------------------------------------------------------- instrucoes

export function AbaInstrucoes({ config, aoMudar, opcoes, podeEditar, padrao }: PropsAba) {
  return (
    <Secao
      titulo="Instrucoes principais"
      descricao="Explique o trabalho como se estivesse orientando alguem no primeiro dia: quem ele e, quem esta do outro lado e o que precisa conseguir na conversa. Tom, regras e informacoes da empresa tem abas proprias — aqui e so o papel."
    >
      <Campo
        titulo="O que este colaborador faz"
        explicacao="Escreva em texto corrido, do jeito que voce explicaria a uma pessoa. Listas e numeracoes ajudam a organizar a ordem das coisas. Nao ha limite de tamanho — escreva o quanto o trabalho exigir; o agente recebe tudo, palavra por palavra."
        contador={{ atual: config.promptPrincipal.length, maximo: opcoes.limites.promptPrincipal }}
        obrigatorio
      >
        <EditorTexto
          valor={config.promptPrincipal}
          aoMudar={(promptPrincipal) => aoMudar({ promptPrincipal })}
          minimoDeLinhas={14}
          desabilitado={!podeEditar}
          placeholder="Voce faz o atendimento inicial de quem procura o escritorio..."
        />
      </Campo>

      <BotaoPadrao
        visivel={Boolean(podeEditar && padrao && padrao.promptPrincipal !== config.promptPrincipal)}
        aoRestaurar={() => padrao && aoMudar({ promptPrincipal: padrao.promptPrincipal })}
      />

      <div className="rounded-xl border border-navy-800 bg-navy-900/40 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Lock size={14} className="text-gold-400" />
          <h3 className="font-display text-sm tracking-wide text-cream">
            Regras que valem sempre, escreva o que escrever
          </h3>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-muted">
          Estas protegem o cliente e o registro do escritorio. Elas entram no fim de toda conversa,
          depois do seu texto, e nao podem ser removidas por esta tela. Voce nao precisa repeti-las
          nas instrucoes.
        </p>
        <ul className="space-y-2">
          {opcoes.regrasInviolaveis.map((regra) => (
            <li key={regra} className="flex gap-2.5 text-xs leading-relaxed text-parchment/70">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-gold-500/60" />
              {regra}
            </li>
          ))}
        </ul>
      </div>
    </Secao>
  );
}

// ------------------------------------------------------------------- tom

export function AbaTom({ config, aoMudar, opcoes, podeEditar }: PropsAba) {
  const personalizado = config.tomDeVoz.preset === 'personalizado';

  return (
    <Secao
      titulo="Tom de voz"
      descricao="Como ele fala. O assunto e o mesmo; muda a maneira de dizer."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {opcoes.tons.map((tom) => {
          const escolhido = config.tomDeVoz.preset === tom.id;
          return (
            <button
              key={tom.id}
              type="button"
              disabled={!podeEditar}
              onClick={() => aoMudar({ tomDeVoz: { ...config.tomDeVoz, preset: tom.id } })}
              className={`rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed ${
                escolhido
                  ? 'border-gold-500/60 bg-gold-500/10'
                  : 'border-navy-800 bg-navy-900/40 hover:border-gold-500/30'
              }`}
            >
              <span
                className={`block font-display text-sm tracking-wide ${escolhido ? 'text-gold-200' : 'text-cream'}`}
              >
                {tom.label}
              </span>
              <span className="mt-1.5 block text-xs leading-relaxed text-muted">{tom.descricao}</span>
            </button>
          );
        })}
      </div>

      <Campo
        titulo={personalizado ? 'Descreva o tom desejado' : 'Ajustes de tom'}
        obrigatorio={personalizado}
        explicacao={
          personalizado
            ? 'Voce escolheu tom personalizado: vale exatamente o que estiver escrito aqui.'
            : 'Somado ao tom escolhido acima. Use para os detalhes que so o escritorio conhece — o que soa bem e o que nunca soa.'
        }
        exemplo="Responda de maneira profissional, proxima e consultiva. Evite respostas excessivamente formais e nao utilize linguagem robotica."
        contador={{ atual: config.tomDeVoz.descricao.length, maximo: opcoes.limites.tomDescricao }}
      >
        <EditorTexto
          valor={config.tomDeVoz.descricao}
          aoMudar={(descricao) => aoMudar({ tomDeVoz: { ...config.tomDeVoz, descricao } })}
          minimoDeLinhas={7}
          desabilitado={!podeEditar}
          placeholder="Frases curtas. Nada de juridiques..."
        />
      </Campo>
    </Secao>
  );
}

// ---------------------------------------------------------------- regras

export function AbaRegras({ config, aoMudar, opcoes, podeEditar }: PropsAba) {
  const [nova, setNova] = useState('');

  const atualizar = (regras: Regra[]) => aoMudar({ regras });

  const adicionar = () => {
    const texto = nova.trim();
    if (!texto) return;
    atualizar([...config.regras, { id: `nova-${Date.now()}`, texto, ativa: true }]);
    setNova('');
  };

  const ativas = config.regras.filter((r) => r.ativa).length;

  return (
    <Secao
      titulo="Regras de comportamento"
      descricao="Combinados que ele segue em toda conversa. Desativar uma regra a mantem guardada aqui, sem valer — util para testar sem perder o texto."
    >
      <div className="flex items-center gap-2">
        <Selo cor={ativas ? 'ativo' : 'atencao'}>
          {ativas} {ativas === 1 ? 'regra ativa' : 'regras ativas'}
        </Selo>
        {config.regras.length > ativas && (
          <Selo cor="espera">{config.regras.length - ativas} desativadas</Selo>
        )}
      </div>

      <ul className="space-y-2">
        {config.regras.map((regra, indice) => (
          <li
            key={regra.id}
            className={`group flex items-start gap-3 rounded-xl border p-3 transition-colors ${
              regra.ativa ? 'border-navy-800 bg-navy-900/40' : 'border-navy-800/60 bg-navy-900/20'
            }`}
          >
            <span className="mt-2.5 text-navy-600">
              <GripVertical size={14} />
            </span>

            <button
              type="button"
              role="switch"
              aria-checked={regra.ativa}
              aria-label={regra.ativa ? 'Desativar regra' : 'Ativar regra'}
              disabled={!podeEditar}
              onClick={() =>
                atualizar(config.regras.map((r, i) => (i === indice ? { ...r, ativa: !r.ativa } : r)))
              }
              className={`mt-2 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                regra.ativa ? 'bg-gold-500' : 'bg-navy-700'
              }`}
            >
              <span
                className={`h-3 w-3 rounded-full bg-navy-950 transition-transform ${regra.ativa ? 'translate-x-3' : ''}`}
              />
            </button>

            <textarea
              value={regra.texto}
              disabled={!podeEditar}
              rows={1}
              onChange={(e) =>
                atualizar(
                  config.regras.map((r, i) =>
                    i === indice ? { ...r, texto: e.target.value.slice(0, opcoes.limites.regraTexto) } : r
                  )
                )
              }
              className={`min-h-9 flex-1 resize-y rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed transition-colors focus:border-navy-700 focus:outline-none ${
                regra.ativa ? 'text-cream' : 'text-muted line-through decoration-navy-600'
              }`}
            />

            <button
              type="button"
              aria-label="Remover regra"
              disabled={!podeEditar}
              onClick={() => atualizar(config.regras.filter((_, i) => i !== indice))}
              className="mt-1.5 rounded-lg p-1.5 text-navy-600 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      {podeEditar && (
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <EntradaTexto
              valor={nova}
              aoMudar={setNova}
              placeholder="Nunca solicitar novamente informacoes que a pessoa ja forneceu"
            />
          </div>
          <Botao aoClicar={adicionar} aparencia="secundario" desabilitado={!nova.trim()}>
            <Plus size={15} />
            Adicionar
          </Botao>
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted">
        Escreva uma ordem por regra, começando pelo verbo. Regras curtas sao seguidas melhor do que
        paragrafos: prefira tres regras a uma regra com tres partes.
      </p>
    </Secao>
  );
}

// -------------------------------------------------------------- mensagens

export function AbaMensagens({ config, aoMudar, opcoes, podeEditar }: PropsAba) {
  const alterar = (chave: ChaveMensagem, texto: string) =>
    aoMudar({ mensagens: { ...config.mensagens, [chave]: texto } });

  return (
    <Secao
      titulo="Mensagens para situacoes recorrentes"
      descricao="O que ele deve fazer nos momentos que se repetem em todo atendimento."
    >
      <div className="space-y-6">
        {opcoes.mensagens.map((mensagem) => (
          <Campo
            key={mensagem.id}
            titulo={mensagem.label}
            explicacao={mensagem.usoReal}
            dica={mensagem.descricao}
            obrigatorio={!mensagem.comoModelo}
            contador={{
              atual: (config.mensagens[mensagem.id] || '').length,
              maximo: opcoes.limites.mensagem,
            }}
          >
            <EditorTexto
              valor={config.mensagens[mensagem.id] || ''}
              aoMudar={(texto) => alterar(mensagem.id, texto)}
              minimoDeLinhas={3}
              desabilitado={!podeEditar}
            />

            {/* A distincao muda o que a pessoa deve escrever: uma orientacao ou
                a frase exata. Sem isso, todo campo vira frase pronta e o
                atendimento inteiro passa a soar gravado. */}
            <p className="mt-2 text-xs text-muted">
              {mensagem.comoModelo ? (
                <>
                  <span className="text-gold-400/80">Orientacao.</span> Ele escreve com as palavras
                  dele, variando entre conversas — nao envia este texto ao pe da letra.
                </>
              ) : (
                <>
                  <span className="text-gold-400/80">Texto exato.</span> Esta e enviada literalmente,
                  porque nessa situacao ele nao esta no ar para improvisar.
                  {mensagem.id === 'fora_do_horario' && (
                    <> Escreva <code className="text-parchment/80">{'{horario}'}</code> onde deve aparecer o
                    horario de atendimento e <code className="text-parchment/80">{'{retorno}'}</code> onde
                    deve aparecer quando o escritorio volta.</>
                  )}
                </>
              )}
            </p>
          </Campo>
        ))}
      </div>
    </Secao>
  );
}

// ------------------------------------------------------------------ midia

export function AbaMidia({ config, aoMudar, opcoes, podeEditar }: PropsAba) {
  const segundos = config.tempoDeEspera.segundos;

  return (
    <Secao
      titulo="Imagem, audio, web e tempo de resposta"
      descricao="O que ele consegue entender alem de texto, o que pode consultar na internet e quanto espera antes de responder."
    >
      {/* ------------------------------------------------------- audio */}
      <div className="space-y-4 rounded-2xl border border-navy-800 p-5">
        <Interruptor
          ligado={config.audio.habilitado}
          desabilitado={!podeEditar}
          aoMudar={(habilitado) => aoMudar({ audio: { ...config.audio, habilitado } })}
          titulo="Entender audios"
          explicacao="Ele ouve o audio, transforma em texto e responde ao conteudo. Desligado, avisa que nao consegue ouvir e pede o relato por escrito — a mensagem nunca fica sem resposta."
        />

        {config.audio.habilitado && (
          <>
            <Campo
              titulo="Instrucoes para audios"
              explicacao="O que ele deve observar ao ouvir. Util para nomes e termos que a transcricao costuma errar."
              contador={{ atual: config.audio.instrucoes.length, maximo: opcoes.limites.midiaInstrucoes }}
            >
              <EditorTexto
                valor={config.audio.instrucoes}
                aoMudar={(instrucoes) => aoMudar({ audio: { ...config.audio, instrucoes } })}
                minimoDeLinhas={3}
                desabilitado={!podeEditar}
              />
            </Campo>

            <Interruptor
              ligado={config.audio.responderSempreEmTexto}
              desabilitado={!podeEditar}
              aoMudar={(responderSempreEmTexto) =>
                aoMudar({ audio: { ...config.audio, responderSempreEmTexto } })
              }
              titulo="Responder sempre em texto"
              explicacao="Mesmo recebendo audio, a resposta sai escrita. Fica registrada e pode ser lida por qualquer pessoa do escritorio depois."
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------------ imagem */}
      <div className="space-y-4 rounded-2xl border border-navy-800 p-5">
        <Interruptor
          ligado={config.imagem.habilitado}
          desabilitado={!podeEditar}
          aoMudar={(habilitado) => aoMudar({ imagem: { ...config.imagem, habilitado } })}
          titulo="Entender imagens"
          explicacao="Ele descreve fotos, prints e documentos e usa a descricao na conversa. Desligado, avisa que nao consegue ver e pede o conteudo por escrito."
        />

        {config.imagem.habilitado && (
          <Campo
            titulo="Instrucoes para imagens"
            explicacao="Como tratar o que aparece na foto."
            exemplo="Descreva o documento e registre. Nunca interprete juridicamente: avise que o time vai analisar."
            contador={{ atual: config.imagem.instrucoes.length, maximo: opcoes.limites.midiaInstrucoes }}
          >
            <EditorTexto
              valor={config.imagem.instrucoes}
              aoMudar={(instrucoes) => aoMudar({ imagem: { ...config.imagem, instrucoes } })}
              minimoDeLinhas={3}
              desabilitado={!podeEditar}
            />
          </Campo>
        )}
      </div>

      {/* ---------------------------------------------------------- web */}
      {/*
        A pesquisa fica ao lado de audio e imagem porque, para quem cura, as
        tres respondem a mesma pergunta: o que este agente consegue consultar?
        A diferenca e que esta busca custa segundos de espera do contato — por
        isso o gatilho e estreito e esta escrito na explicacao, nao escondido.
      */}
      <div className="space-y-4 rounded-2xl border border-navy-800 p-5">
        <Interruptor
          ligado={config.web.habilitado}
          desabilitado={!podeEditar}
          aoMudar={(habilitado) => aoMudar({ web: { ...config.web, habilitado } })}
          titulo="Consultar a internet"
          explicacao="Só entra em cena quando a pergunta depende de dado que muda: valor vigente, tabela do ano, endereço ou horário de órgão público. Nunca para opinar sobre o caso da pessoa, e nunca em saudação ou triagem. Desligado, o agente responde com o que o escritório cadastrou."
        />

        {config.web.habilitado && (
          <Campo
            titulo="Instrucoes para a pesquisa"
            explicacao="Como usar o que voltar da internet. O agente ja e proibido de citar link ou fonte na conversa — a origem fica registrada para o advogado."
            exemplo="Diga desde quando o dado vale. Nunca transforme dado geral em conclusao sobre o caso da pessoa."
            contador={{ atual: config.web.instrucoes.length, maximo: opcoes.limites.midiaInstrucoes }}
          >
            <EditorTexto
              valor={config.web.instrucoes}
              aoMudar={(instrucoes) => aoMudar({ web: { ...config.web, instrucoes } })}
              minimoDeLinhas={3}
              desabilitado={!podeEditar}
            />
          </Campo>
        )}
      </div>

      {/* ------------------------------------------------------- tempo */}
      <div className="space-y-4 rounded-2xl border border-navy-800 p-5">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="font-display text-sm tracking-wide text-cream">Tempo de espera</h3>
          <span className="font-display text-2xl tabular-nums text-gold-300">{segundos}s</span>
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Quanto ele espera antes de responder a quem esta escrevendo. Serve para juntar mensagens
          seguidas da mesma pessoa e responder tudo de uma vez, em vez de responder cada pedaco.
        </p>

        <input
          type="range"
          min={1}
          max={30}
          step={1}
          value={segundos}
          disabled={!podeEditar}
          onChange={(e) => aoMudar({ tempoDeEspera: { segundos: Number(e.target.value) } })}
          className="w-full accent-[var(--color-gold-500)] disabled:opacity-40"
        />

        <div className="flex justify-between text-xs text-muted">
          <span>1s — responde na hora</span>
          <span className={segundos === 8 ? 'text-gold-300' : ''}>8s — recomendado</span>
          <span>30s — espera muito</span>
        </div>

        {segundos !== 8 && (
          <button
            type="button"
            disabled={!podeEditar}
            onClick={() => aoMudar({ tempoDeEspera: { segundos: 8 } })}
            className="text-xs text-muted transition-colors hover:text-gold-300"
          >
            Voltar para 8 segundos
          </button>
        )}
      </div>
    </Secao>
  );
}

// ---------------------------------------------------------------- empresa

export function AbaEmpresa({ config, aoMudar, opcoes, podeEditar }: PropsAba) {
  const alterar = (campo: keyof Empresa, valor: string) =>
    aoMudar({ empresa: { ...config.empresa, [campo]: valor } });

  const faq = config.empresa.faq;
  const alterarFaq = (novo: typeof faq) => aoMudar({ empresa: { ...config.empresa, faq: novo } });

  return (
    <Secao
      titulo="Informacoes da empresa"
      descricao="A fonte de verdade do agente. Ele so pode afirmar o que estiver aqui — o resto ele encaminha para o time. Manter isto em dia e o que mais reduz resposta errada."
    >
      <div className="space-y-6">
        {opcoes.camposEmpresa.map((campo) => (
          <Campo
            key={campo.id}
            titulo={campo.label}
            explicacao={campo.dica}
            obrigatorio={campo.obrigatorio}
            contador={{
              atual: String(config.empresa[campo.id] || '').length,
              maximo: opcoes.limites.empresaCampo,
            }}
          >
            <EditorTexto
              valor={String(config.empresa[campo.id] || '')}
              aoMudar={(v) => alterar(campo.id, v)}
              minimoDeLinhas={campo.id === 'descricao' || campo.id === 'servicos' ? 5 : 3}
              desabilitado={!podeEditar}
            />
          </Campo>
        ))}
      </div>

      {/* ---------------------------------------- perguntas frequentes */}
      <div className="space-y-4 rounded-2xl border border-navy-800 p-5">
        <div>
          <h3 className="font-display text-sm tracking-wide text-cream">Perguntas frequentes</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Pergunta e resposta prontas para o que mais aparece. Ele usa como base, com as palavras
            dele.
          </p>
        </div>

        {faq.map((item, indice) => (
          <div key={indice} className="space-y-2 rounded-xl border border-navy-800 bg-navy-900/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs uppercase tracking-[0.2em] text-gold-400/70">
                Pergunta {indice + 1}
              </span>
              {podeEditar && (
                <button
                  type="button"
                  aria-label="Remover pergunta"
                  onClick={() => alterarFaq(faq.filter((_, i) => i !== indice))}
                  className="rounded-lg p-1 text-navy-600 transition-colors hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            <EntradaTexto
              valor={item.pergunta}
              aoMudar={(pergunta) =>
                alterarFaq(faq.map((f, i) => (i === indice ? { ...f, pergunta } : f)))
              }
              placeholder="Voces atendem online?"
              desabilitado={!podeEditar}
            />
            <EditorTexto
              valor={item.resposta}
              aoMudar={(resposta) =>
                alterarFaq(faq.map((f, i) => (i === indice ? { ...f, resposta } : f)))
              }
              minimoDeLinhas={2}
              desabilitado={!podeEditar}
            />
          </div>
        ))}

        {podeEditar && faq.length < opcoes.limites.faq && (
          <Botao
            aparencia="secundario"
            aoClicar={() => alterarFaq([...faq, { pergunta: '', resposta: '' }])}
          >
            <Plus size={15} />
            Adicionar pergunta
          </Botao>
        )}
      </div>
    </Secao>
  );
}
