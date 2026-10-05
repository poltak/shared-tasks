import type { Env, PokeStream, StreamHandlers } from './env.ts';

/** The server sends a ping each 25 seconds. A stream that is quiet for this long is dead. */
const QUIET_MS = 70_000;

/**
 * The event stream of the server, read through fetch.
 *
 * EventSource would do the same with less code, but it hides the HTTP status (a session that
 * ended looks like a network error) and the pings, so a connection that died with no sign stays
 * "open" until the system gives up.
 */
export function eventStreamOver(io: Pick<Env, 'fetch' | 'setTimeout' | 'clearTimeout'>): Env['openEvents'] {
  return (path: string, handlers: StreamHandlers): PokeStream => {
    const abort = new AbortController();
    let ended = false;
    let watchdog: unknown = null;

    const stop = (): boolean => {
      if (ended) return false;
      ended = true;
      io.clearTimeout(watchdog);
      abort.abort();
      return true;
    };
    const end = (status: number): void => {
      if (stop()) handlers.onClose(status);
    };
    const alive = (): void => {
      io.clearTimeout(watchdog);
      watchdog = io.setTimeout(() => end(0), QUIET_MS);
    };

    function read(event: string): void {
      let name = 'message';
      let data = '';
      for (const line of event.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (name !== 'poke') return;
      try {
        const rev = (JSON.parse(data) as { rev?: unknown }).rev;
        if (typeof rev === 'number') handlers.onPoke(rev);
      } catch {
        // A poke that cannot be read is ignored. The poll finds the change.
      }
    }

    async function run(): Promise<void> {
      alive();
      const response = await io.fetch(path, {
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: abort.signal,
      });
      if (!response.ok || !response.body) return end(response.ok ? 0 : response.status);
      if (ended) return;
      handlers.onOpen();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || ended) break;
        alive();
        buffer += decoder.decode(value, { stream: true });
        // An empty line ends an event.
        for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
          read(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
        }
      }
      end(0);
    }

    run().catch(() => end(0));
    // A close by the caller gives no onClose.
    return { close: () => void stop() };
  };
}
