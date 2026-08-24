import { API_URL } from './api';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'operador';
  lastLoginAt: string | null;
}

/** Servidor inalcancavel ou com falha propria: a sessao continua valida. */
export class NetworkError extends Error {
  constructor(message = 'Servidor indisponivel') {
    super(message);
    this.name = 'NetworkError';
  }
}

const TOKEN_KEY = 'whatsagent.token';

/**
 * Onde o token mora depende da escolha de "manter conectado":
 *
 *   localStorage   -> sobrevive a fechar o navegador (ate o token expirar)
 *   sessionStorage -> morre junto com a aba
 *
 * A leitura consulta os dois, entao o resto do codigo nao precisa saber
 * qual foi a escolha.
 */
function stores(): Storage[] {
  if (typeof window === 'undefined') return [];
  const list: Storage[] = [];
  try {
    list.push(window.localStorage);
  } catch {
    /* storage bloqueado pelo navegador */
  }
  try {
    list.push(window.sessionStorage);
  } catch {
    /* idem */
  }
  return list;
}

export function getToken(): string | null {
  for (const store of stores()) {
    try {
      const token = store.getItem(TOKEN_KEY);
      if (token) return token;
    } catch {
      /* segue para o proximo */
    }
  }
  return null;
}

export function setToken(token: string | null, remember = true) {
  // Limpa nos dois antes de gravar: evita sobra do modo anterior.
  for (const store of stores()) {
    try {
      store.removeItem(TOKEN_KEY);
    } catch {
      /* ignora */
    }
  }
  if (!token || typeof window === 'undefined') return;

  try {
    const target = remember ? window.localStorage : window.sessionStorage;
    target.setItem(TOKEN_KEY, token);
  } catch {
    /* sem storage, a sessao dura o que durar a pagina */
  }
}

export const authHeader = (): Record<string, string> => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export async function login(email: string, password: string, remember = false) {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember }),
    });
  } catch {
    throw new NetworkError('Nao foi possivel falar com o servidor. Ele esta rodando?');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Nao foi possivel entrar');

  setToken(body.token, remember);
  return body.user as AuthUser;
}

/**
 * Valida a sessao guardada.
 *
 * @returns o usuario, ou null quando NAO ha sessao valida.
 * @throws NetworkError quando o servidor nao respondeu — nesse caso a sessao
 *         continua valida e o token NAO pode ser apagado. Apagar aqui era o
 *         motivo de o usuario ser deslogado toda vez que o backend reiniciava.
 */
export async function me(): Promise<AuthUser | null> {
  if (!getToken()) return null;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/auth/me`, {
      headers: authHeader(),
      cache: 'no-store',
    });
  } catch {
    throw new NetworkError();
  }

  // Só credencial recusada encerra a sessao.
  if (response.status === 401 || response.status === 403) {
    setToken(null);
    return null;
  }

  // 500, 502, 503: problema do servidor, nao do usuario. A sessao permanece.
  if (!response.ok) throw new NetworkError();

  const body = await response.json();
  return body.user as AuthUser;
}

/** Instalacao nova ainda sem nenhum usuario: o front avisa em vez de travar. */
export async function authStatus(): Promise<{ hasUsers: boolean }> {
  try {
    const response = await fetch(`${API_URL}/api/auth/status`, { cache: 'no-store' });
    if (!response.ok) return { hasUsers: true };
    return await response.json();
  } catch {
    return { hasUsers: true };
  }
}

export function logout() {
  setToken(null);
}
