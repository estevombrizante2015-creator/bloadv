'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { resetSocket } from './useSocket';
import * as auth from '@/lib/auth';

type Status = 'checking' | 'authenticated' | 'anonymous' | 'offline';

/**
 * Sessao do painel.
 *
 * A distincao que importa:
 *
 *   anonymous -> nao ha sessao valida. Vai para o login.
 *   offline   -> o servidor nao respondeu. A sessao continua de pe e o
 *                usuario NAO e mandado para o login; o painel mostra o
 *                aviso e tenta de novo.
 *
 * Tratar as duas como a mesma coisa era o que deslogava o usuario toda vez
 * que o backend reiniciava ou o banco engasgava.
 *
 * @param requireAuth true nas telas protegidas.
 */
export function useAuth({ requireAuth = false } = {}) {
  const router = useRouter();
  const [user, setUser] = useState<auth.AuthUser | null>(null);
  const [status, setStatus] = useState<Status>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;

    auth
      .me()
      .then((current) => {
        if (!alive) return;
        setUser(current);
        setStatus(current ? 'authenticated' : 'anonymous');
        if (!current && requireAuth) router.replace('/');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof auth.NetworkError) {
          // Sessao preservada: so o servidor esta fora do ar.
          setStatus('offline');
          return;
        }
        setStatus('anonymous');
        if (requireAuth) router.replace('/');
      });

    return () => {
      alive = false;
    };
  }, [requireAuth, router, attempt]);

  // Servidor fora: tenta de novo sozinho, sem derrubar quem esta logado.
  useEffect(() => {
    if (status !== 'offline') return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), 5000);
    return () => clearTimeout(timer);
  }, [status]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const signOut = useCallback(() => {
    auth.logout();
    resetSocket(); // a proxima conexao nao pode reaproveitar o token antigo
    setUser(null);
    setStatus('anonymous');
    router.replace('/');
  }, [router]);

  return {
    user,
    status,
    signOut,
    retry,
    isAuthenticated: status === 'authenticated',
    isOffline: status === 'offline',
  };
}
