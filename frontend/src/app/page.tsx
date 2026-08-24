'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowRight, Check, Eye, EyeOff, Loader2, Lock, Mail } from 'lucide-react';
import { BrandLockup, Emblem } from '@/components/Brand';
import { authStatus, getToken, login } from '@/lib/auth';
import { resetSocket } from '@/hooks/useSocket';

/**
 * Entrada do painel.
 *
 * Layout em duas colunas no desktop: a marca ocupa a esquerda e o formulario
 * a direita, sobre uma superficie um passo mais clara. No mobile vira uma
 * coluna so, com a marca reduzida no topo - o formulario nunca fica abaixo
 * da dobra.
 */
export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUsers, setHasUsers] = useState(true);
  const [checking, setChecking] = useState(true);

  // Sessao valida vai direto ao painel, sem passar pelo formulario.
  useEffect(() => {
    let alive = true;

    (async () => {
      if (getToken()) {
        const { me } = await import('@/lib/auth');
        const current = await me().catch(() => null);
        if (alive && current) {
          router.replace('/connections');
          return;
        }
      }

      const status = await authStatus();
      if (!alive) return;
      setHasUsers(status.hasUsers);
      setChecking(false);
    })();

    return () => {
      alive = false;
    };
  }, [router]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      await login(email.trim(), password, remember);
      resetSocket(); // a conexao seguinte leva o token novo
      router.replace('/connections');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nao foi possivel entrar');
      setPassword('');
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <main className="grid min-h-screen place-items-center bg-navy-950">
        <Emblem className="h-14 w-auto animate-pulse" priority />
      </main>
    );
  }

  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* ---------------- marca ---------------- */}
      <section className="relative hidden overflow-hidden bg-navy-900 lg:flex lg:flex-col lg:justify-between lg:px-16 lg:py-14">
        {/* brilho difuso e textura discreta, sem competir com o conteudo */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 top-1/4 h-[34rem] w-[34rem] rounded-full bg-gold-500/[0.07] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.045]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, #d4b36a 1px, transparent 0)',
            backgroundSize: '28px 28px',
          }}
        />

        <div className="relative flex flex-1 items-center justify-center">
          <BrandLockup />
        </div>

        <div className="relative">
          <div className="rule-gold h-px w-full opacity-40" />
          <p className="mt-6 max-w-md text-sm leading-relaxed text-muted">
            Atendimento por WhatsApp com triagem assistida, em conformidade com os
            limites do exercicio da advocacia.
          </p>
          <p className="mt-3 text-[11px] uppercase tracking-[0.22em] text-navy-600">
            Direito do Trabalho · SP · CE · MT
          </p>
        </div>
      </section>

      {/* ---------------- formulario ---------------- */}
      <section className="flex min-h-screen items-center justify-center bg-navy-950 px-6 py-12 sm:px-10 lg:min-h-0">
        <div className="w-full max-w-[26rem]">
          {/* marca reduzida: so aparece quando a coluna da esquerda some */}
          <div className="mb-10 flex justify-center lg:hidden">
            <BrandLockup />
          </div>

          <header className="mb-8">
            <h2 className="font-display text-2xl tracking-wide text-cream">Acessar o painel</h2>
            <p className="mt-2 text-sm text-muted">
              Use as credenciais fornecidas pelo escritorio.
            </p>
          </header>

          {!hasUsers && (
            <div className="mb-6 rounded-xl border border-gold-500/25 bg-gold-500/[0.07] px-4 py-3.5">
              <p className="text-xs font-semibold text-gold-300">Nenhum usuario cadastrado</p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Crie o primeiro acesso no servidor:
              </p>
              <code className="mt-2 block break-all rounded-lg bg-navy-950/60 px-3 py-2 font-mono text-[11px] text-gold-200">
                npm run create:user -- voce@escritorio.com &quot;senha&quot;
              </code>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <Field
              id="email"
              label="E-mail"
              icon={<Mail size={17} />}
              type="email"
              autoComplete="username"
              autoFocus
              placeholder="nome@escritorio.com.br"
              value={email}
              onChange={setEmail}
              disabled={submitting}
            />

            <Field
              id="password"
              label="Senha"
              icon={<Lock size={17} />}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Sua senha"
              value={password}
              onChange={setPassword}
              disabled={submitting}
              trailing={
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  className="rounded-md p-1 text-muted transition-colors hover:text-gold-300"
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              }
            />

            <label className="flex cursor-pointer select-none items-center gap-2.5">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="peer sr-only"
              />
              {/* `peer-checked:` so alcanca irmaos; o icone e descendente,
                  entao o seletor precisa descer ate ele com [&>svg]. */}
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-navy-700 bg-navy-900 transition-colors peer-checked:border-gold-500 peer-checked:bg-gold-500 peer-checked:[&>svg]:opacity-100 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gold-400">
                <Check
                  size={12}
                  strokeWidth={3}
                  className="text-navy-950 opacity-0 transition-opacity"
                />
              </span>
              <span className="text-[13px] text-muted">Manter conectado</span>
            </label>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.08] px-4 py-3 text-[13px] text-red-300"
              >
                <AlertCircle size={16} className="mt-px shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-gold-300 to-gold-500 px-6 py-3.5 text-sm font-semibold tracking-wide text-navy-950 shadow-lg shadow-gold-600/10 transition-all hover:from-gold-200 hover:to-gold-400 disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none"
            >
              {submitting ? (
                <>
                  <Loader2 size={17} className="animate-spin" />
                  Entrando
                </>
              ) : (
                <>
                  Entrar
                  <ArrowRight
                    size={17}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </>
              )}
            </button>
          </form>

          <p className="mt-10 border-t border-navy-800 pt-6 text-center text-[11px] leading-relaxed text-navy-600">
            Acesso restrito. Este painel conecta contas de WhatsApp do escritorio
            <br className="hidden sm:block" /> e alcanca comunicacoes protegidas por sigilo
            profissional.
          </p>
        </div>
      </section>
    </main>
  );
}

/** Campo de formulario com rotulo, icone e estado de foco em dourado. */
function Field({
  id,
  label,
  icon,
  trailing,
  value,
  onChange,
  ...props
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block text-[11px] font-medium uppercase tracking-[0.14em] text-muted"
      >
        {label}
      </label>

      <div className="group relative">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted transition-colors group-focus-within:text-gold-400">
          {icon}
        </span>

        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          className={`w-full rounded-xl border border-navy-800 bg-navy-900 py-3.5 pl-12 text-[15px] text-cream outline-none transition-colors placeholder:text-navy-600 hover:border-navy-700 focus:border-gold-500/70 focus:bg-navy-850 disabled:opacity-60 ${
            trailing ? 'pr-12' : 'pr-4'
          }`}
          {...props}
        />

        {trailing && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">{trailing}</span>
        )}
      </div>
    </div>
  );
}
