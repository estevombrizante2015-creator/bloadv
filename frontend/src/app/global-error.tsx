'use client';

import './globals.css';

/**
 * Fronteira de erro da raiz.
 *
 * Substitui o layout inteiro quando a falha acontece acima de qualquer page -
 * por isso precisa emitir <html> e <body> por conta propria, e por isso as
 * fontes do next/font nao valem aqui: elas sao injetadas pelo layout que
 * acabou de ser descartado.
 *
 * O arquivo tambem existe por um motivo de build: sem ele o Next gera a
 * pagina /_global-error padrao, que e a que falhava no prerender do Railway.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt-BR" className="h-full">
      <body className="min-h-full bg-navy-950 text-cream antialiased">
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-gold-400">whatsAgent</p>

          <h1 className="text-2xl text-cream">Algo quebrou no painel</h1>

          <p className="text-sm leading-relaxed text-muted">
            O atendimento no WhatsApp segue rodando: ele nao depende desta tela. Recarregue
            e, se persistir, avise quem cuida do sistema.
          </p>

          {/* O digest e o unico fio que liga esta tela a linha certa do log do servidor. */}
          {error.digest && (
            <code className="rounded border border-gold-500/30 px-3 py-1 text-xs text-parchment">
              {error.digest}
            </code>
          )}

          <button
            type="button"
            onClick={reset}
            className="rounded bg-gold-400 px-5 py-2 text-sm font-medium text-navy-950 transition hover:bg-gold-300"
          >
            Tentar de novo
          </button>
        </main>
      </body>
    </html>
  );
}
