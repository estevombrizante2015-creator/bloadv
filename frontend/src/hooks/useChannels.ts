'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './useSocket';
import { api, type ChannelState } from '@/lib/api';

/**
 * Estado dos 3 numeros.
 * O snapshot inicial vem por HTTP; QR e mudancas de status chegam por socket,
 * porque o QR do Baileys expira em ~60s e precisa ser substituido na hora.
 */
export function useChannels() {
  const { socket, isConnected } = useSocket();
  const [channels, setChannels] = useState<ChannelState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const { channels: list } = await api.channels();
      setChannels(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar canais');
    } finally {
      setLoading(false);
    }
  }, []);

  // carga inicial por HTTP; o socket assume dali em diante
  useEffect(() => {
    let alive = true;
    api
      .channels()
      .then(({ channels: list }) => {
        if (!alive) return;
        setChannels(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Falha ao carregar canais');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onSnapshot = (list: ChannelState[]) => {
      setChannels((prev) =>
        list.map((incoming) => ({ ...prev.find((c) => c.id === incoming.id), ...incoming }))
      );
      setLoading(false);
    };

    const onUpdate = (state: ChannelState) => {
      setChannels((prev) => {
        const exists = prev.some((c) => c.id === state.id);
        if (!exists) return [...prev, state];
        return prev.map((c) => (c.id === state.id ? { ...c, ...state } : c));
      });
    };

    socket.on('channels:snapshot', onSnapshot);
    socket.on('channel:update', onUpdate);
    socket.emit('channels:list');

    return () => {
      socket.off('channels:snapshot', onSnapshot);
      socket.off('channel:update', onUpdate);
    };
  }, [socket]);

  const dismissError = useCallback(() => setError(null), []);

  // O aviso some sozinho: preso na tela ele viraria ruido permanente.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const run = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      setBusy((b) => ({ ...b, [id]: true }));
      setError(null);
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Acao falhou');
      } finally {
        setBusy((b) => ({ ...b, [id]: false }));
      }
    },
    []
  );

  return {
    channels,
    loading,
    error,
    busy,
    socketConnected: isConnected,
    refresh,
    dismissError,
    connect: (id: string) => run(id, () => api.connect(id)),
    disconnect: (id: string) => run(id, () => api.disconnect(id)),
    logout: (id: string) => run(id, () => api.logout(id)),
    rename: (id: string, label: string) =>
      run(id, async () => {
        const updated = await api.rename(id, label);
        setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...updated } : c)));
      }),
    assignAgent: (id: string, agentId: string) =>
      run(id, async () => {
        const updated = await api.assignAgent(id, agentId);
        setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...updated } : c)));
      }),
    toggleAgent: (id: string, enabled: boolean) =>
      run(id, async () => {
        await api.toggleAgent(id, enabled);
        setChannels((prev) =>
          prev.map((c) => (c.id === id ? { ...c, agentEnabled: enabled } : c))
        );
      }),
  };
}
