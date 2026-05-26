import { useEffect, useRef, useState } from 'react';
import { safeParseHarnessEvent, type HarnessEvent } from '@wisp/schemas';

export type WsStatus = 'idle' | 'open' | 'closed' | 'error';

export interface UseRunEventsResult {
  events: HarnessEvent[];
  status: WsStatus;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
// Bound the retained event buffer so long autonomous runs don't grow the
// array (and React reconciliation cost) unboundedly. The Kanban + run-view
// only need the most recent activity; older events stay in the server DB
// and can be fetched on demand.
const MAX_EVENTS = 2000;

function buildWsUrl(runId: string): string {
  if (typeof window === 'undefined') return `/ws/runs/${runId}`;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/runs/${runId}`;
}

export function useRunEvents(runId: string | null): UseRunEventsResult {
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [status, setStatus] = useState<WsStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cancelledRef.current = false;
    backoffRef.current = INITIAL_BACKOFF_MS;
    setEvents([]);

    if (!runId) {
      setStatus('idle');
      return () => {
        cancelledRef.current = true;
      };
    }

    const connect = () => {
      if (cancelledRef.current) return;
      const url = buildWsUrl(runId);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        backoffRef.current = INITIAL_BACKOFF_MS;
        setStatus('open');
      };

      ws.onmessage = (ev: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(String(ev.data));
        } catch (err) {
          console.warn('[ws] non-JSON message dropped', err);
          return;
        }
        const result = safeParseHarnessEvent(parsed);
        if (!result.success) {
          console.warn('[ws] invalid HarnessEvent dropped', result.error.issues);
          return;
        }
        setEvents((prev) => {
          const next = [...prev, result.data];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });
      };

      ws.onerror = () => {
        setStatus('error');
      };

      ws.onclose = () => {
        if (cancelledRef.current) {
          setStatus('closed');
          return;
        }
        setStatus('closed');
        const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS);
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [runId]);

  return { events, status };
}
