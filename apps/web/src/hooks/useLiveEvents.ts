import type { LiveEvent } from '@agent-pool/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { liveEventsUrl, parseLiveEvent } from '../lib/api';

export type StreamState = 'connecting' | 'live' | 'retrying' | 'stopped';

const EVENT_NAMES: LiveEvent['type'][] = [
  'pool.updated',
  'unit.updated',
  'wallet.updated',
  'runner.updated',
  'system.pulse',
];

export function useLiveEvents(onEvent: (event: LiveEvent) => void, enabled = true) {
  const [state, setState] = useState<StreamState>(enabled ? 'connecting' : 'stopped');
  const callbackRef = useRef(onEvent);
  const cursorRef = useRef<string | undefined>(undefined);
  const retryRef = useRef(0);

  useEffect(() => {
    callbackRef.current = onEvent;
  }, [onEvent]);

  const reset = useCallback(() => {
    cursorRef.current = undefined;
    retryRef.current = 0;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState('stopped');
      return;
    }

    let source: EventSource | undefined;
    let retryTimer: number | undefined;
    let disposed = false;

    const open = () => {
      if (disposed) return;
      setState(retryRef.current > 0 ? 'retrying' : 'connecting');
      source = new EventSource(liveEventsUrl(cursorRef.current), { withCredentials: true });

      source.onopen = () => {
        retryRef.current = 0;
        setState('live');
      };

      const receive = (raw: Event) => {
        if (!(raw instanceof MessageEvent)) return;
        const event = parseLiveEvent(raw as MessageEvent<string>);
        if (!event) return;
        cursorRef.current = event.id || raw.lastEventId || cursorRef.current;
        callbackRef.current(event);
      };

      source.onmessage = receive;
      EVENT_NAMES.forEach((name) => source?.addEventListener(name, receive));

      source.onerror = () => {
        source?.close();
        if (disposed) return;
        retryRef.current += 1;
        setState('retrying');
        const delay = Math.min(15_000, 750 * 2 ** Math.min(retryRef.current, 5));
        retryTimer = window.setTimeout(open, delay);
      };
    };

    open();
    return () => {
      disposed = true;
      source?.close();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [enabled]);

  return { state, reset };
}
