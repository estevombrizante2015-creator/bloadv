import React from 'react';
import Image from 'next/image';

/**
 * MARCA — Barbosa, Loli e Oliveira
 *
 * Dois arquivos, ambos gerados a partir do original do escritorio:
 *
 *   public/logo.webp     assinatura completa (emblema + nome + qualificacao).
 *                        O nome esta em BRANCO no arquivo, entao ela so funciona
 *                        sobre fundo escuro — que e o caso do painel inteiro.
 *
 *   public/emblema.webp  so o emblema, recortado do original e com as bordas
 *                        transparentes aparadas. Usado onde o lockup deitado
 *                        (2,5:1) nao cabe, como a barra do painel.
 *
 * Para atualizar a marca, substitua os dois arquivos mantendo os nomes.
 */
const LOGO = { src: '/logo.webp', width: 1011, height: 397 };
const EMBLEMA = { src: '/emblema.webp', width: 490, height: 241 };

export function Emblem({ className = '', priority = false }: { className?: string; priority?: boolean }) {
  return (
    <Image
      src={EMBLEMA.src}
      alt=""
      width={EMBLEMA.width}
      height={EMBLEMA.height}
      priority={priority}
      className={className}
      draggable={false}
    />
  );
}

/**
 * Assinatura completa. Nao acompanha texto proprio: o nome e a qualificacao
 * ja fazem parte do arquivo, e repeti-los duplicaria a marca.
 */
export function BrandLockup({ compact = false }: { compact?: boolean }) {
  if (compact) {
    // Na barra o lockup deitado ficaria minusculo: emblema + texto em HTML,
    // que acompanha o tamanho da fonte e continua legivel.
    return (
      <div className="flex items-center gap-3">
        <Emblem className="h-8 w-auto shrink-0" />
        <div className="leading-tight">
          <p className="font-display text-[13px] font-semibold tracking-[0.16em] text-cream sm:text-[14px]">
            BARBOSA, LOLI E OLIVEIRA
          </p>
          <p className="font-display text-[9px] uppercase tracking-[0.3em] text-gold-400 sm:text-[10px]">
            Sociedade de Advogados
          </p>
        </div>
      </div>
    );
  }

  return (
    <Image
      src={LOGO.src}
      alt="Barbosa, Loli e Oliveira — Sociedade de Advogados"
      width={LOGO.width}
      height={LOGO.height}
      priority
      className="h-auto w-full max-w-[26rem]"
      draggable={false}
    />
  );
}
