'use client';

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { API_URL } from '@/lib/api';
import { getToken } from '@/lib/auth';

/** Uma unica conexao socket compartilhada por toda a aplicacao. */
let shared: Socket | null = null;

/** Chamado no login e no logout: a proxima conexao leva o token novo. */
export function resetSocket() {
  if (shared) {
    shared.disconnect();
    shared = null;
  }
}

function getSocket(): Socket | null {
  if (typeof window === 'undefined') return null;
  if (!shared) {
    shared = io(API_URL, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // O socket carrega QR de pareamento: o servidor recusa sem token.
      auth: { token: getToken() },
    });
  }
  return shared;
}

export function useSocket() {
  const [socket] = useState(getSocket);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!socket) return;

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // o socket pode ja estar conectado quando outro componente montou antes
    if (socket.connected) queueMicrotask(onConnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket]);

  return { socket, isConnected };
}
