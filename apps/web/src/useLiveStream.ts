import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface SSEIncomingEvent {
  kind: 'event' | 'incident' | 'device' | 'activity' | 'stats' | 'ping' | 'resync';
  id?: string;
  data: any;
  timestamp: string;
}

export function useLiveStream() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');
  const [lastLiveAt, setLastLiveAt] = useState<Date | null>(null);
  const [liveEvents, setLiveEvents] = useState<any[]>([]);
  const [isPaused, setIsPaused] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const lastCursorRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (!navigator.onLine) {
      setState('offline');
      return;
    }

    setState((prev) => (prev === 'offline' ? 'connecting' : 'reconnecting'));

    const token =
      (import.meta as unknown as { env: Record<string, string> }).env?.VITE_OPERATOR_TOKEN ??
      'rtops_operator_secret_token_123';

    let url = `/api/stream?token=${encodeURIComponent(token)}`;
    if (lastCursorRef.current) {
      url += `&last_event_id=${encodeURIComponent(lastCursorRef.current)}`;
    }

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setState('live');
      setLastLiveAt(new Date());
      reconnectAttemptRef.current = 0;

      // Invalidate queries to catch up on any delta
      void queryClient.invalidateQueries();
    };

    es.onmessage = (event) => {
      setLastLiveAt(new Date());

      if (event.lastEventId) {
        lastCursorRef.current = event.lastEventId;
      }

      try {
        const msg = JSON.parse(event.data) as SSEIncomingEvent;

        if (msg.kind === 'ping') return;

        if (msg.kind === 'resync') {
          // Re-fetch all snapshots via REST
          void queryClient.invalidateQueries();
          return;
        }

        if (msg.kind === 'event') {
          if (!isPaused && msg.data) {
            setLiveEvents((prev) => {
              const incoming = Array.isArray(msg.data) ? msg.data : [msg.data];
              const combined = [...incoming, ...prev];
              // Keep memory bounded to 500 events
              return combined.slice(0, 500);
            });
          }
        } else if (msg.kind === 'incident') {
          void queryClient.invalidateQueries({ queryKey: ['incidents'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
        } else if (msg.kind === 'device') {
          void queryClient.invalidateQueries({ queryKey: ['devices'] });
          void queryClient.invalidateQueries({ queryKey: ['stats'] });
        } else if (msg.kind === 'activity') {
          void queryClient.invalidateQueries({ queryKey: ['activity'] });
        } else if (msg.kind === 'stats') {
          queryClient.setQueryData(['stats'], msg.data);
        }
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      if (!navigator.onLine) {
        setState('offline');
        return;
      }

      setState('reconnecting');
      // Exponential backoff with jitter (1s, 2s, 4s, ... max 15s)
      const attempt = reconnectAttemptRef.current++;
      const jitter = Math.random() * 500;
      const delay = Math.min(1000 * Math.pow(1.5, attempt) + jitter, 15000);

      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };
  };

  useEffect(() => {
    connect();

    const handleOnline = () => {
      connect();
    };

    const handleOffline = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setState('offline');
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && state !== 'live') {
        connect();
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, []);

  const manualReconnect = () => {
    reconnectAttemptRef.current = 0;
    connect();
  };

  return {
    state,
    lastLiveAt,
    liveEvents,
    isPaused,
    setIsPaused,
    clearEvents: () => setLiveEvents([]),
    manualReconnect,
  };
}
