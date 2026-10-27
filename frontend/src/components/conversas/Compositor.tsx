'use client';

import React, { useEffect, useRef, useState } from 'react';
import { FileText, Loader2, Mic, Paperclip, Send, Smile, Square, Trash2, X } from 'lucide-react';
import { tamanhoLegivel } from './Midia';

/**
 * CAIXA DE ENVIO DO ATENDENTE
 * ---------------------------
 * Texto, emoji, arquivo e audio — o que a equipe faria pelo celular, sem
 * precisar dele. O envio em si e do chamador (`aoEnviar`): aqui so se monta o
 * que vai sair e se limpa a caixa quando deu certo.
 *
 * O componente e montado de novo a cada conversa (via `key`), entao rascunho,
 * anexo e gravacao em andamento nunca vazam de uma pessoa para outra.
 */

export interface Envio {
  texto?: string;
  arquivo?: {
    blob: Blob;
    nome: string;
    mimetype: string;
    /** Audio gravado aqui: vira nota de voz no WhatsApp. */
    voz?: boolean;
    segundos?: number;
  };
}

/** Teto de midia do WhatsApp; o servidor recusa acima disso. */
const LIMITE_BYTES = 16 * 1024 * 1024;
/** Mesmo teto de audio que o servidor aceita transcrever. */
const LIMITE_GRAVACAO_S = 300;

/** Em ordem de preferencia: OGG/Opus ja e o formato da nota de voz. */
const FORMATOS_GRAVACAO = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

/** Abre o microfone e comeca a gravar. Null se a pessoa negou o acesso. */
async function abrirGravador() {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return null;
  }

  const formato = FORMATOS_GRAVACAO.find((f) => MediaRecorder.isTypeSupported(f));
  const recorder = new MediaRecorder(stream, formato ? { mimeType: formato } : undefined);
  const pedacos: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) pedacos.push(e.data);
  };
  recorder.start(250);

  return { recorder, stream, pedacos, inicio: Date.now() };
}

const ACEITOS =
  'image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar';

export function Compositor({
  enviando,
  aoEnviar,
  aoErro,
}: {
  enviando: boolean;
  aoEnviar: (envio: Envio) => Promise<boolean>;
  aoErro: (mensagem: string | null) => void;
}) {
  const [rascunho, setRascunho] = useState('');
  const [anexo, setAnexo] = useState<File | null>(null);
  const [previa, setPrevia] = useState<string | null>(null);
  const [emojisAbertos, setEmojisAbertos] = useState(false);
  const [arrastando, setArrastando] = useState(false);

  const [gravando, setGravando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const gravacao = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    pedacos: Blob[];
    inicio: number;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);

  const caixa = useRef<HTMLTextAreaElement>(null);
  const seletor = useRef<HTMLInputElement>(null);

  // Microfone e cronometro nao podem sobreviver a troca de conversa.
  useEffect(
    () => () => {
      const g = gravacao.current;
      if (!g) return;
      clearInterval(g.timer);
      g.recorder.onstop = null;
      if (g.recorder.state !== 'inactive') g.recorder.stop();
      g.stream.getTracks().forEach((t) => t.stop());
    },
    []
  );

  // A previa de imagem e um blob: local; sai da memoria quando o anexo sai.
  useEffect(
    () => () => {
      if (previa) URL.revokeObjectURL(previa);
    },
    [previa]
  );

  const anexar = (arquivo: File | null | undefined) => {
    if (!arquivo) return;
    if (arquivo.size > LIMITE_BYTES) {
      aoErro(`O arquivo tem ${tamanhoLegivel(arquivo.size)}; o WhatsApp aceita até 16 MB.`);
      return;
    }
    aoErro(null);
    setAnexo(arquivo);
    setPrevia(arquivo.type.startsWith('image/') ? URL.createObjectURL(arquivo) : null);
    caixa.current?.focus();
  };

  const removerAnexo = () => {
    setAnexo(null);
    setPrevia(null);
    if (seletor.current) seletor.current.value = '';
  };

  const enviar = async () => {
    if (enviando) return;
    const texto = rascunho.trim();

    if (anexo) {
      const ok = await aoEnviar({
        texto: texto || undefined,
        arquivo: {
          blob: anexo,
          nome: anexo.name,
          mimetype: anexo.type || 'application/octet-stream',
        },
      });
      if (ok) {
        setRascunho('');
        removerAnexo();
      }
      return;
    }

    if (!texto) return;
    if (await aoEnviar({ texto })) setRascunho('');
  };

  /** Emoji entra onde esta o cursor, nao no fim do texto. */
  const inserirEmoji = (emoji: string) => {
    const el = caixa.current;
    const inicio = el?.selectionStart ?? rascunho.length;
    const fim = el?.selectionEnd ?? rascunho.length;
    setRascunho(rascunho.slice(0, inicio) + emoji + rascunho.slice(fim));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(inicio + emoji.length, inicio + emoji.length);
    });
  };

  // ------------------------------------------------------------- gravacao

  const iniciarGravacao = async () => {
    aoErro(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      aoErro('Este navegador não grava áudio. Use o Chrome, o Edge ou o Firefox.');
      return;
    }

    const gravador = await abrirGravador();
    if (!gravador) {
      aoErro('Sem acesso ao microfone. Libere o microfone para este site no navegador.');
      return;
    }

    const timer = setInterval(() => {
      const decorridos = Math.floor((Date.now() - gravador.inicio) / 1000);
      setSegundos(decorridos);
      if (decorridos >= LIMITE_GRAVACAO_S) concluirGravacao(true);
    }, 250);

    gravacao.current = { ...gravador, timer };
    setSegundos(0);
    setGravando(true);
  };

  /** Para o microfone; envia o audio ou descarta. */
  const concluirGravacao = (enviar: boolean) => {
    const g = gravacao.current;
    if (!g) return;
    gravacao.current = null;
    clearInterval(g.timer);

    g.recorder.onstop = async () => {
      g.stream.getTracks().forEach((t) => t.stop());
      setGravando(false);
      if (!enviar) return;

      const duracao = (Date.now() - g.inicio) / 1000;
      if (duracao < 1) {
        aoErro('Áudio curto demais. Segure a gravação por pelo menos um segundo.');
        return;
      }

      const mimetype = g.recorder.mimeType || g.pedacos[0]?.type || 'audio/webm';
      const extensao = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'm4a' : 'webm';
      await aoEnviar({
        arquivo: {
          blob: new Blob(g.pedacos, { type: mimetype }),
          nome: `audio.${extensao}`,
          mimetype,
          voz: true,
          segundos: duracao,
        },
      });
    };

    if (g.recorder.state !== 'inactive') g.recorder.stop();
    else g.recorder.onstop?.(new Event('stop'));
  };

  // ------------------------------------------------------------- tela

  if (gravando) {
    return (
      <div className="flex h-[58px] items-center gap-3 rounded-xl border border-red-400/30 bg-red-400/[0.06] px-3">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-400" />
        <span className="text-sm tabular-nums text-cream">
          {Math.floor(segundos / 60)}:{String(segundos % 60).padStart(2, '0')}
        </span>
        <span className="flex-1 text-[11px] text-muted">
          Gravando áudio — vai como mensagem de voz.
        </span>
        <button
          type="button"
          onClick={() => concluirGravacao(false)}
          title="Descartar"
          className="inline-flex items-center gap-1.5 rounded-lg border border-navy-700 px-3 py-1.5 text-xs text-muted transition-colors hover:border-red-400/40 hover:text-red-300"
        >
          <Trash2 size={13} />
          Descartar
        </button>
        <button
          type="button"
          onClick={() => concluirGravacao(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-gold-300 to-gold-500 px-3 py-1.5 text-xs font-semibold text-navy-950 transition-all hover:from-gold-200 hover:to-gold-400"
        >
          <Square size={11} className="fill-current" />
          Parar e enviar
        </button>
      </div>
    );
  }

  const podeEnviar = !enviando && (Boolean(anexo) || Boolean(rascunho.trim()));

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setArrastando(true);
      }}
      onDragLeave={() => setArrastando(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setArrastando(false);
        anexar(e.dataTransfer.files[0]);
      }}
      className={`rounded-xl transition-colors ${arrastando ? 'bg-gold-500/[0.06] ring-1 ring-gold-500/40' : ''}`}
    >
      {anexo && (
        <div className="mb-2 flex items-center gap-3 rounded-xl border border-navy-800 bg-navy-950/60 p-2">
          {previa ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previa} alt="" className="h-12 w-12 rounded-md object-cover" />
          ) : (
            <span className="grid h-12 w-12 place-items-center rounded-md bg-navy-800">
              <FileText size={18} className="text-gold-300/80" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-cream">{anexo.name}</p>
            <p className="text-[10px] text-muted">
              {tamanhoLegivel(anexo.size)}
              {anexo.type.startsWith('audio/')
                ? ' · o texto, se houver, vai numa mensagem à parte'
                : ' · o texto escrito vai como legenda'}
            </p>
          </div>
          <button
            type="button"
            onClick={removerAnexo}
            aria-label="Remover anexo"
            className="rounded-md p-1 text-muted transition-colors hover:bg-white/5 hover:text-cream"
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="relative flex flex-1 items-end rounded-xl border border-navy-800 bg-navy-950 transition-colors focus-within:border-gold-500/60">
          <div className="flex items-center gap-0.5 pb-2 pl-1.5">
            <BotaoIcone
              rotulo="Emojis"
              ativo={emojisAbertos}
              onClick={() => setEmojisAbertos((v) => !v)}
            >
              <Smile size={17} />
            </BotaoIcone>
            <BotaoIcone rotulo="Anexar arquivo" onClick={() => seletor.current?.click()}>
              <Paperclip size={17} />
            </BotaoIcone>
          </div>

          <textarea
            ref={caixa}
            value={rascunho}
            onChange={(e) => setRascunho(e.target.value)}
            onKeyDown={(e) => {
              // Enter envia; Shift+Enter quebra linha.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                enviar();
              }
            }}
            // Print colado (Ctrl+V) vira anexo, como no WhatsApp Web. Texto
            // copiado do Word ou do Excel leva uma imagem junto: ai vale o texto.
            onPaste={(e) => {
              const arquivo = e.clipboardData.files?.[0];
              if (arquivo && !e.clipboardData.getData('text/plain')) {
                e.preventDefault();
                anexar(arquivo);
              }
            }}
            rows={2}
            maxLength={anexo ? 1024 : 4000}
            placeholder={anexo ? 'Legenda (opcional)...' : 'Escreva como atendente...'}
            className="scrollbar-thin flex-1 resize-none bg-transparent px-2 py-2.5 text-sm text-cream outline-none"
          />

          {emojisAbertos && (
            <SeletorDeEmoji
              aoEscolher={inserirEmoji}
              aoFechar={() => setEmojisAbertos(false)}
            />
          )}

          <input
            ref={seletor}
            type="file"
            accept={ACEITOS}
            onChange={(e) => anexar(e.target.files?.[0])}
            className="hidden"
          />
        </div>

        {podeEnviar || enviando ? (
          <button
            onClick={enviar}
            disabled={!podeEnviar}
            className="inline-flex h-[42px] items-center gap-2 rounded-xl bg-gradient-to-b from-gold-300 to-gold-500 px-4 text-sm font-semibold text-navy-950 transition-all hover:from-gold-200 hover:to-gold-400 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {enviando ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            Enviar
          </button>
        ) : (
          <button
            onClick={iniciarGravacao}
            title="Gravar áudio"
            className="inline-flex h-[42px] items-center gap-2 rounded-xl border border-gold-500/40 px-4 text-sm font-semibold text-gold-200 transition-colors hover:border-gold-400 hover:bg-gold-500/10"
          >
            <Mic size={15} />
            Áudio
          </button>
        )}
      </div>
    </div>
  );
}

function BotaoIcone({
  rotulo,
  ativo,
  onClick,
  children,
}: {
  rotulo: string;
  ativo?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={rotulo}
      aria-label={rotulo}
      className={`rounded-lg p-1.5 transition-colors hover:bg-navy-800 hover:text-gold-300 ${
        ativo ? 'text-gold-300' : 'text-muted'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Emojis do dia a dia de um atendimento — sem biblioteca: um seletor completo
 * pesaria mais que a pagina inteira. O teclado do sistema (Win + .) continua
 * funcionando para o resto.
 */
const EMOJIS: Array<{ grupo: string; itens: string[] }> = [
  {
    grupo: 'Rostos',
    itens: [
      '😀', '😃', '😄', '😁', '😊', '🙂', '😉', '😍', '🥰', '😘', '😅', '😂',
      '🤣', '😇', '🤗', '🤔', '🤨', '😐', '😶', '🙄', '😬', '😌', '😔', '😢',
      '😭', '😤', '😠', '😡', '😱', '😨', '😰', '😳', '🥺', '😴', '🤐', '😷',
    ],
  },
  {
    grupo: 'Gestos',
    itens: [
      '👍', '👎', '👌', '✌️', '🤞', '🤝', '🙏', '👏', '🙌', '👋', '✋', '👊',
      '💪', '👉', '👈', '👆', '👇', '☝️', '✍️', '🫡',
    ],
  },
  {
    grupo: 'Atendimento',
    itens: [
      '✅', '☑️', '✔️', '❌', '⚠️', '❗', '❓', '⏳', '⌛', '⏰', '📅', '📆',
      '📌', '📎', '📄', '📃', '📑', '📋', '📁', '🗂️', '✉️', '📧', '📞', '📱',
      '💬', '🔔', '🔒', '🔑', '⚖️', '🏛️', '💼', '🏢', '💰', '💵', '🧾', '📊',
    ],
  },
  {
    grupo: 'Símbolos',
    itens: [
      '❤️', '💙', '💚', '💛', '🧡', '💜', '🤍', '💯', '⭐', '🌟', '✨', '🎉',
      '🎊', '🔥', '👀', '➡️', '⬅️', '⬆️', '⬇️', '🔸', '🔹', '▪️', '🆗', '🆕',
    ],
  },
];

function SeletorDeEmoji({
  aoEscolher,
  aoFechar,
}: {
  aoEscolher: (emoji: string) => void;
  aoFechar: () => void;
}) {
  const painel = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora ou apertar Esc — continua aberto entre um emoji e
  // outro, para quem quer mandar mais de um.
  useEffect(() => {
    const fora = (e: MouseEvent) => {
      const alvo = e.target as Node;
      if (painel.current?.contains(alvo)) return;
      // O proprio botao de emoji alterna sozinho.
      if ((alvo as HTMLElement).closest?.('[aria-label="Emojis"]')) return;
      aoFechar();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && aoFechar();
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [aoFechar]);

  return (
    <div
      ref={painel}
      className="scrollbar-thin absolute bottom-full left-0 z-30 mb-2 max-h-72 w-[19rem] overflow-y-auto rounded-xl border border-navy-700 bg-navy-850 p-2 shadow-xl"
    >
      {EMOJIS.map(({ grupo, itens }) => (
        <div key={grupo} className="mb-1.5 last:mb-0">
          <p className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted">{grupo}</p>
          <div className="grid grid-cols-9 gap-0.5">
            {itens.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => aoEscolher(emoji)}
                className="grid h-8 w-8 place-items-center rounded-md text-lg transition-colors hover:bg-navy-700"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
