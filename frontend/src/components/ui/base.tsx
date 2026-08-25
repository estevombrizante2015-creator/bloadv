'use client';

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, HelpCircle, TriangleAlert, X } from 'lucide-react';

/**
 * PECAS BASICAS DA CURADORIA
 * --------------------------
 * Quem usa esta tela nao programa. Duas decisoes de forma valem para todas as
 * pecas aqui:
 *
 *   1. TODO CAMPO EXPLICA O QUE FAZ, embaixo, em texto corrido. Nao existe
 *      campo cujo unico rotulo seja o nome tecnico dele.
 *   2. NADA DE MONOESPACADO em campo de conteudo. Fonte de codigo comunica
 *      "isto e programacao, cuidado" - exatamente a sensacao que a interface
 *      precisa evitar.
 */

// ------------------------------------------------------------------- campo

export function Dica({ texto }: { texto: string }) {
  const [aberta, setAberta] = useState(false);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="O que e isto?"
        onClick={() => setAberta((v) => !v)}
        onBlur={() => setAberta(false)}
        className="text-muted transition-colors hover:text-gold-300"
      >
        <HelpCircle size={14} />
      </button>
      {aberta && (
        <span className="absolute left-1/2 top-6 z-30 w-64 -translate-x-1/2 rounded-xl border border-navy-700 bg-navy-850 p-3 text-xs leading-relaxed text-parchment shadow-xl">
          {texto}
        </span>
      )}
    </span>
  );
}

export function Campo({
  titulo,
  explicacao,
  dica,
  exemplo,
  obrigatorio,
  contador,
  children,
}: {
  titulo: string;
  explicacao?: string;
  dica?: string;
  exemplo?: string;
  obrigatorio?: boolean;
  contador?: { atual: number; maximo: number | null };
  children: React.ReactNode;
}) {
  // Aviso de espaco so quando ele passa a importar. Um contador sempre visivel
  // faz a pessoa escrever para caber, em vez de escrever para explicar.
  //
  // `maximo` nulo e campo SEM TETO (hoje, as instrucoes principais). Ali nao ha
  // espaco para acabar: o numero so aparece quando o texto ja e longo o
  // bastante para a pessoa querer saber o tamanho, e sem cor de alarme —
  // pintar de vermelho um campo que nao tem limite seria mentir.
  const semTeto = Boolean(contador) && !contador?.maximo;
  const apertado = contador?.maximo ? contador.atual > contador.maximo * 0.8 : false;
  const longo = semTeto && (contador?.atual ?? 0) > 4000;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-1.5 font-display text-sm tracking-wide text-cream">
          {titulo}
          {obrigatorio && <span className="text-gold-400">*</span>}
          {dica && <Dica texto={dica} />}
        </label>
        {contador && apertado && contador.maximo && (
          <span className={`text-xs tabular-nums ${contador.atual >= contador.maximo ? 'text-red-300' : 'text-amber-300/80'}`}>
            {contador.atual.toLocaleString('pt-BR')} de {contador.maximo.toLocaleString('pt-BR')}
          </span>
        )}
        {contador && longo && (
          <span className="text-xs tabular-nums text-muted" title="Este campo nao tem limite de tamanho">
            {contador.atual.toLocaleString('pt-BR')} caracteres
          </span>
        )}
      </div>

      {children}

      {explicacao && <p className="text-xs leading-relaxed text-muted">{explicacao}</p>}
      {exemplo && (
        <p className="border-l-2 border-gold-500/30 pl-3 text-xs italic leading-relaxed text-parchment/60">
          Exemplo: {exemplo}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ editor

const CAMPO_BASE =
  'w-full rounded-xl border border-navy-800 bg-navy-900/60 px-4 py-3 text-sm leading-relaxed ' +
  'text-cream transition-colors placeholder:text-muted/50 focus:border-gold-500/40 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Editor de texto longo que cresce com o conteudo.
 *
 * Uma caixa de altura fixa com rolagem propria e o que faz um prompt de 30
 * linhas parecer um formulario tecnico. Crescendo, ele parece um documento -
 * que e o que ele e.
 */
export function EditorTexto({
  valor,
  aoMudar,
  placeholder,
  minimoDeLinhas = 4,
  desabilitado,
}: {
  valor: string;
  aoMudar: (v: string) => void;
  placeholder?: string;
  minimoDeLinhas?: number;
  desabilitado?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // useLayoutEffect: ajustar depois da pintura faz a caixa "pular" a cada tecla.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [valor]);

  return (
    <textarea
      ref={ref}
      value={valor}
      disabled={desabilitado}
      onChange={(e) => aoMudar(e.target.value)}
      placeholder={placeholder}
      rows={minimoDeLinhas}
      className={`${CAMPO_BASE} resize-none overflow-hidden`}
    />
  );
}

export function EntradaTexto({
  valor,
  aoMudar,
  placeholder,
  tipo = 'text',
  desabilitado,
}: {
  valor: string;
  aoMudar: (v: string) => void;
  placeholder?: string;
  tipo?: string;
  desabilitado?: boolean;
}) {
  return (
    <input
      type={tipo}
      value={valor}
      disabled={desabilitado}
      onChange={(e) => aoMudar(e.target.value)}
      placeholder={placeholder}
      className={CAMPO_BASE}
    />
  );
}

// ------------------------------------------------------------ interruptor

export function Interruptor({
  ligado,
  aoMudar,
  titulo,
  explicacao,
  desabilitado,
}: {
  ligado: boolean;
  aoMudar: (v: boolean) => void;
  titulo: string;
  explicacao?: string;
  desabilitado?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={ligado}
      disabled={desabilitado}
      onClick={() => aoMudar(!ligado)}
      className="flex w-full items-start gap-3 rounded-xl border border-navy-800 bg-navy-900/40 p-4 text-left transition-colors hover:border-gold-500/30 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          ligado ? 'bg-gold-500' : 'bg-navy-700'
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-navy-950 transition-transform ${ligado ? 'translate-x-4' : ''}`}
        />
      </span>
      <span className="min-w-0">
        <span className="block font-display text-sm tracking-wide text-cream">{titulo}</span>
        {explicacao && <span className="mt-1 block text-xs leading-relaxed text-muted">{explicacao}</span>}
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ botoes

type Aparencia = 'principal' | 'secundario' | 'discreto' | 'perigo';

const APARENCIAS: Record<Aparencia, string> = {
  principal: 'bg-gold-500 text-navy-950 hover:bg-gold-400 font-medium',
  secundario: 'border border-gold-500/40 text-gold-300 hover:border-gold-400 hover:text-gold-200',
  discreto: 'border border-navy-800 text-muted hover:border-gold-500/30 hover:text-gold-300',
  perigo: 'border border-red-500/30 text-red-300 hover:border-red-400/60 hover:bg-red-500/10',
};

export function Botao({
  children,
  aoClicar,
  aparencia = 'discreto',
  desabilitado,
  tipo = 'button',
  titulo,
}: {
  children: React.ReactNode;
  aoClicar?: () => void;
  aparencia?: Aparencia;
  desabilitado?: boolean;
  tipo?: 'button' | 'submit';
  titulo?: string;
}) {
  return (
    <button
      type={tipo}
      title={titulo}
      onClick={aoClicar}
      disabled={desabilitado}
      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${APARENCIAS[aparencia]}`}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------- modal

export function Modal({
  titulo,
  subtitulo,
  aoFechar,
  children,
  rodape,
  largura = 'max-w-2xl',
}: {
  titulo: string;
  subtitulo?: string;
  aoFechar: () => void;
  children: React.ReactNode;
  rodape?: React.ReactNode;
  largura?: string;
}) {
  // Esc fecha: quem nao usa o mouse (ou se assustou com o que abriu) precisa de saida.
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => e.key === 'Escape' && aoFechar();
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [aoFechar]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/80 p-4 backdrop-blur-sm">
      <div
        className={`flex max-h-[88vh] w-full ${largura} flex-col overflow-hidden rounded-2xl border border-navy-700 bg-navy-900 shadow-2xl`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-navy-800 px-6 py-4">
          <div>
            <h2 className="font-display text-lg tracking-wide text-cream">{titulo}</h2>
            {subtitulo && <p className="mt-1 text-sm text-muted">{subtitulo}</p>}
          </div>
          <button
            onClick={aoFechar}
            aria-label="Fechar"
            className="rounded-lg p-1 text-muted transition-colors hover:bg-navy-800 hover:text-cream"
          >
            <X size={18} />
          </button>
        </header>

        <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {rodape && (
          <footer className="flex items-center justify-end gap-3 border-t border-navy-800 bg-navy-900/80 px-6 py-4">
            {rodape}
          </footer>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- problemas

/**
 * Um problema apontado pela validacao.
 *
 * Sempre com as tres partes: o que esta errado, por que importa e o que fazer.
 * Mensagem de erro que so diz o que esta errado deixa a pessoa parada.
 */
export function Problema({
  nivel,
  titulo,
  mensagem,
  comoCorrigir,
}: {
  nivel: 'erro' | 'aviso';
  titulo: string;
  mensagem: string;
  comoCorrigir: string;
}) {
  const erro = nivel === 'erro';
  const Icone = erro ? CircleAlert : TriangleAlert;

  return (
    <div
      className={`rounded-xl border p-4 ${
        erro ? 'border-red-500/30 bg-red-500/5' : 'border-amber-400/25 bg-amber-400/5'
      }`}
    >
      <div className="flex items-start gap-3">
        <Icone size={16} className={`mt-0.5 shrink-0 ${erro ? 'text-red-300' : 'text-amber-300'}`} />
        <div className="min-w-0 space-y-1.5">
          <p className={`font-display text-sm tracking-wide ${erro ? 'text-red-200' : 'text-amber-200'}`}>
            {titulo}
          </p>
          <p className="whitespace-pre-line text-sm leading-relaxed text-parchment/85">{mensagem}</p>
          <p className="text-xs leading-relaxed text-muted">
            <span className="text-parchment/70">Como resolver: </span>
            {comoCorrigir}
          </p>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- selos

export function Selo({
  children,
  cor = 'neutro',
}: {
  children: React.ReactNode;
  cor?: 'neutro' | 'ativo' | 'espera' | 'atencao';
}) {
  const cores = {
    neutro: 'border-navy-700 text-muted',
    ativo: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    espera: 'border-navy-600 bg-navy-800/60 text-parchment/70',
    atencao: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium ${cores[cor]}`}
    >
      {children}
    </span>
  );
}

export function Secao({
  titulo,
  descricao,
  children,
}: {
  titulo: string;
  descricao?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="font-display text-xl tracking-wide text-cream">{titulo}</h2>
        {descricao && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{descricao}</p>}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- seletor

export interface OpcaoSeletor {
  valor: string;
  label: string;
  /** Linha secundaria, para escolhas que precisam de explicacao. */
  descricao?: string;
  /** Ponto colorido a esquerda. Quem chama decide a cor — a base nao conhece a paleta do modulo. */
  enfeite?: React.ReactNode;
}

/**
 * SELETOR
 * -------
 * Substitui o `<select>` nativo.
 *
 * O motivo e visual e nao tem contorno por CSS: a lista de opcoes de um
 * `<select>` e desenhada pelo SISTEMA OPERACIONAL, nao pela pagina. Nenhuma
 * regra de estilo a alcanca. Num painel escuro, abrir o seletor jogava na tela
 * um retangulo branco com texto preto — o unico ponto da interface que nao
 * pertencia a ela.
 *
 * O que se ganha de quebra: ponto colorido do status, descricao por opcao e uma
 * lista que rola sem sair do tema.
 *
 * POSICIONAMENTO. A lista e `fixed`, posicionada a partir do botao, em vez de
 * `absolute` dentro dele. Dentro de um modal — que tem rolagem propria — uma
 * lista absoluta seria cortada na borda, e o seletor de status vive exatamente
 * dentro de um. Ela acompanha a rolagem e sobe sozinha quando nao cabe embaixo.
 */
export function Seletor({
  valor,
  opcoes,
  aoMudar,
  desabilitado,
  placeholder = 'Selecione',
}: {
  valor: string;
  opcoes: OpcaoSeletor[];
  aoMudar: (valor: string) => void;
  desabilitado?: boolean;
  placeholder?: string;
}) {
  const [aberto, setAberto] = useState(false);
  const [emFoco, setEmFoco] = useState(0);
  const [posicao, setPosicao] = useState<{ top: number; left: number; width: number }>();

  const botao = useRef<HTMLButtonElement>(null);
  const lista = useRef<HTMLUListElement>(null);
  const digitado = useRef({ texto: '', em: 0 });

  // O foco do teclado nunca sai do botao: quem navega com as setas move o
  // `aria-activedescendant`, e e assim que o leitor de tela anuncia a opcao
  // percorrida sem perder o campo de vista.
  const idLista = useId();

  const escolhida = opcoes.find((o) => o.valor === valor);

  const medir = useCallback(() => {
    const el = botao.current;
    if (!el) return;

    const r = el.getBoundingClientRect();
    const altura = Math.min(288, opcoes.length * 40 + 8);
    const cabeEmbaixo = window.innerHeight - r.bottom > altura + 8;

    setPosicao({
      top: cabeEmbaixo ? r.bottom + 4 : Math.max(8, r.top - altura - 4),
      left: r.left,
      width: r.width,
    });
  }, [opcoes.length]);

  const abrir = () => {
    if (desabilitado) return;
    medir();
    setEmFoco(Math.max(0, opcoes.findIndex((o) => o.valor === valor)));
    setAberto(true);
  };

  const escolher = (opcao: OpcaoSeletor) => {
    aoMudar(opcao.valor);
    setAberto(false);
    botao.current?.focus();
  };

  // Acompanha rolagem e redimensionamento. `capture` alcanca tambem a rolagem
  // do modal, que nao borbulha ate a janela.
  useEffect(() => {
    if (!aberto) return;

    const reposicionar = () => medir();
    window.addEventListener('scroll', reposicionar, true);
    window.addEventListener('resize', reposicionar);

    const foraDaLista = (e: MouseEvent) => {
      const alvo = e.target as Node;
      if (!botao.current?.contains(alvo) && !lista.current?.contains(alvo)) setAberto(false);
    };
    document.addEventListener('mousedown', foraDaLista);

    return () => {
      window.removeEventListener('scroll', reposicionar, true);
      window.removeEventListener('resize', reposicionar);
      document.removeEventListener('mousedown', foraDaLista);
    };
  }, [aberto, medir]);

  // Mantem visivel a opcao em foco quando se navega pelo teclado.
  useEffect(() => {
    if (!aberto) return;
    lista.current
      ?.querySelector<HTMLElement>(`[data-indice="${emFoco}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [aberto, emFoco]);

  const aoTeclar = (e: React.KeyboardEvent) => {
    if (desabilitado) return;

    if (!aberto) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        abrir();
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setAberto(false);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (opcoes[emFoco]) escolher(opcoes[emFoco]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setEmFoco((i) => Math.min(opcoes.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setEmFoco((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setEmFoco(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setEmFoco(opcoes.length - 1);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Busca por digitacao, como no seletor nativo: teclas seguidas somam.
      const agora = Date.now();
      digitado.current.texto =
        agora - digitado.current.em > 700 ? e.key : digitado.current.texto + e.key;
      digitado.current.em = agora;

      const alvo = digitado.current.texto.toLowerCase();
      const i = opcoes.findIndex((o) => o.label.toLowerCase().startsWith(alvo));
      if (i >= 0) setEmFoco(i);
    }
  };

  return (
    <>
      <button
        ref={botao}
        type="button"
        role="combobox"
        aria-expanded={aberto}
        aria-haspopup="listbox"
        aria-controls={idLista}
        aria-activedescendant={aberto ? `${idLista}-${emFoco}` : undefined}
        disabled={desabilitado}
        onClick={() => (aberto ? setAberto(false) : abrir())}
        onKeyDown={aoTeclar}
        className={`flex w-full items-center gap-2 rounded-xl border bg-navy-900/60 px-3.5 py-2.5 text-left text-sm text-cream transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          aberto ? 'border-gold-500/50' : 'border-navy-800 hover:border-navy-700'
        }`}
      >
        {escolhida?.enfeite}
        <span className={`min-w-0 flex-1 truncate ${escolhida ? '' : 'text-muted'}`}>
          {escolhida?.label || placeholder}
        </span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-muted transition-transform ${aberto ? 'rotate-180' : ''}`}
        />
      </button>

      {aberto && posicao && (
        <ul
          ref={lista}
          id={idLista}
          role="listbox"
          style={{ top: posicao.top, left: posicao.left, width: posicao.width }}
          className="scrollbar-thin fixed z-[60] max-h-72 overflow-y-auto rounded-xl border border-navy-700 bg-navy-850 p-1 shadow-2xl shadow-navy-950/80"
        >
          {opcoes.map((opcao, indice) => {
            const atual = opcao.valor === valor;
            return (
              <li key={opcao.valor || `vazio-${indice}`}>
                <button
                  type="button"
                  role="option"
                  id={`${idLista}-${indice}`}
                  aria-selected={atual}
                  data-indice={indice}
                  onClick={() => escolher(opcao)}
                  onMouseEnter={() => setEmFoco(indice)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    indice === emFoco ? 'bg-gold-500/25 text-gold-200' : 'text-parchment'
                  }`}
                >
                  {opcao.enfeite}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{opcao.label}</span>
                    {opcao.descricao && (
                      <span className="block truncate text-xs text-muted">{opcao.descricao}</span>
                    )}
                  </span>
                  {atual && <Check size={14} className="shrink-0 text-gold-400" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
