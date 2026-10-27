'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Loader2, TriangleAlert, X } from 'lucide-react';
import { conversationsApi, type MidiaInfo } from '@/lib/api';

/**
 * O ARQUIVO DA MENSAGEM, NO PAINEL
 * --------------------------------
 * O servidor baixa e guarda todo arquivo assim que ele chega (ver
 * backend/src/whatsapp/media.store.js). Aqui ele vira o que a pessoa
 * esperaria ver no WhatsApp: player de audio, foto, video, documento para
 * baixar — sem precisar do celular na mao.
 *
 * O arquivo vem por fetch autenticado e vira um `blob:` local. Carrega quando
 * a bolha aparece na tela, nao quando a conversa abre: uma conversa longa nao
 * baixa duzentos audios de uma vez.
 */

/** Quantos arquivos ficam em memoria. Os mais antigos sao liberados. */
const LIMITE_CACHE = 80;
const cache = new Map<string, Promise<string>>();

function urlDaMidia(id: string): Promise<string> {
  const existente = cache.get(id);
  if (existente) {
    // Reinsere para marcar como recente.
    cache.delete(id);
    cache.set(id, existente);
    return existente;
  }

  const promessa = conversationsApi.midia(id).then((blob) => URL.createObjectURL(blob));
  // Falhou: sai do cache, para a proxima tentativa buscar de novo.
  promessa.catch(() => cache.delete(id));
  cache.set(id, promessa);

  while (cache.size > LIMITE_CACHE) {
    const [maisAntigo, url] = cache.entries().next().value as [string, Promise<string>];
    cache.delete(maisAntigo);
    url.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  }

  return promessa;
}

const EXTENSAO: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

/** Nome para salvar no computador, mesmo quando o WhatsApp nao mandou um. */
export function nomeDoArquivo(midia: MidiaInfo, tipo: string) {
  if (midia.nome && !/^(audio|image|video|sticker|document)\.\w+$/.test(midia.nome)) {
    return midia.nome;
  }
  const base = (midia.mimetype || '').split(';')[0].trim();
  const extensao = EXTENSAO[base] || base.split('/')[1] || 'bin';
  return `${tipo}-${midia.id.slice(-6)}.${extensao}`;
}

export function tamanhoLegivel(bytes: number | null) {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

/** Salva o arquivo no computador. */
export async function baixarMidia(midia: MidiaInfo, tipo: string) {
  const url = await urlDaMidia(midia.id);
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeDoArquivo(midia, tipo);
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** URL local do arquivo, buscada quando o elemento entra na tela. */
function useMidiaVisivel(id: string, automatico: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [pedido, setPedido] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!automatico || !el) return;

    const observador = new IntersectionObserver(
      (entradas) => {
        if (entradas.some((e) => e.isIntersecting)) {
          setPedido(true);
          observador.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observador.observe(el);
    return () => observador.disconnect();
  }, [automatico]);

  useEffect(() => {
    if (!pedido) return;
    let cancelado = false;
    urlDaMidia(id)
      .then((u) => !cancelado && setUrl(u))
      .catch((e) => !cancelado && setErro(e instanceof Error ? e.message : 'Arquivo indisponivel'));
    return () => {
      cancelado = true;
    };
  }, [id, pedido]);

  return { ref, url, erro };
}

function BotaoBaixar({ midia, tipo, rotulo }: { midia: MidiaInfo; tipo: string; rotulo?: string }) {
  const [baixando, setBaixando] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        setBaixando(true);
        await baixarMidia(midia, tipo).catch(() => {});
        setBaixando(false);
      }}
      title="Baixar para o computador"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-white/5 hover:text-cream"
    >
      {baixando ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
      {rotulo ?? 'Baixar'}
    </button>
  );
}

export function MidiaDaMensagem({ midia, tipo }: { midia: MidiaInfo; tipo: string }) {
  const visual = tipo === 'image' || tipo === 'sticker' || tipo === 'video';
  const tocavel = tipo === 'audio' || visual;
  const { ref, url, erro } = useMidiaVisivel(midia.id, tocavel);
  const [ampliada, setAmpliada] = useState(false);
  const tamanho = tamanhoLegivel(midia.bytes);

  if (!tocavel) {
    return (
      <div className="flex min-w-[14rem] items-center gap-2.5 rounded-xl border border-white/10 bg-navy-950/40 px-3 py-2.5">
        <FileText size={22} className="shrink-0 text-gold-300/80" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-cream" title={nomeDoArquivo(midia, tipo)}>
            {nomeDoArquivo(midia, tipo)}
          </p>
          <p className="text-[10px] text-muted">
            {[tamanho, (midia.mimetype || '').split(';')[0]].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <BotaoBaixar midia={midia} tipo={tipo} />
          <button
            type="button"
            onClick={() =>
              urlDaMidia(midia.id)
                .then((u) => window.open(u, '_blank', 'noopener'))
                .catch(() => {})
            }
            title="Abrir numa nova aba"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-white/5 hover:text-cream"
          >
            <ExternalLink size={11} />
            Abrir
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="flex flex-col gap-1">
      {erro ? (
        <p className="flex items-center gap-1 text-[11px] text-amber-300">
          <TriangleAlert size={11} />
          Não foi possível carregar o arquivo.
        </p>
      ) : !url ? (
        <div
          className={`grid place-items-center rounded-lg bg-navy-950/40 ${
            tipo === 'audio' ? 'h-10 w-64' : 'h-40 w-56'
          }`}
        >
          <Loader2 size={14} className="animate-spin text-muted" />
        </div>
      ) : tipo === 'audio' ? (
        <audio controls preload="metadata" src={url} className="h-10 w-64 max-w-full" />
      ) : tipo === 'video' ? (
        <video controls preload="metadata" src={url} className="max-h-72 max-w-full rounded-lg" />
      ) : (
        <button type="button" onClick={() => setAmpliada(true)} className="block cursor-zoom-in">
          {/* blob: local, fora do otimizador do Next */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={tipo === 'sticker' ? 'Figurinha enviada' : 'Imagem enviada'}
            className={`rounded-lg object-contain ${tipo === 'sticker' ? 'max-h-32' : 'max-h-72 max-w-full'}`}
          />
        </button>
      )}

      <div className="flex items-center gap-2 text-[10px] text-muted">
        {midia.segundos ? <span className="tabular-nums">{duracao(midia.segundos)}</span> : null}
        {tamanho && <span>{tamanho}</span>}
        <BotaoBaixar midia={midia} tipo={tipo} />
      </div>

      {ampliada && url && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setAmpliada(false)}
          onKeyDown={(e) => e.key === 'Escape' && setAmpliada(false)}
          className="fixed inset-0 z-50 grid place-items-center bg-navy-950/90 p-6 backdrop-blur-sm"
        >
          <div className="absolute right-4 top-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
            <BotaoBaixar midia={midia} tipo={tipo} />
            <button
              type="button"
              autoFocus
              onClick={() => setAmpliada(false)}
              aria-label="Fechar"
              className="rounded-md p-1 text-muted transition-colors hover:bg-white/5 hover:text-cream"
            >
              <X size={18} />
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Imagem ampliada" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  );
}

const duracao = (segundos: number) =>
  `${Math.floor(segundos / 60)}:${String(Math.round(segundos % 60)).padStart(2, '0')}`;
