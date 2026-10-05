import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ID } from '../shared/types.ts';

const PING_MS = 25_000;
/** A defect in a client must not fill the server with open streams. */
const MAX_STREAMS_PER_USER = 32;

export interface StreamInfo {
  userId: ID;
  /** Names the session, so a sign-out can end its streams. */
  sessionKey: string;
  /** The device, if it gave its id. A device does not need a poke for its own change. */
  clientId: ID | null;
}

interface Stream extends StreamInfo {
  res: ServerResponse;
}

export interface Events {
  /** Makes the response an event stream and sends the current revision as the first poke. */
  open(input: StreamInfo & { req: IncomingMessage; res: ServerResponse; rev: number }): void;
  /** Tells the devices of the people that rows changed. `except` is the device that made the change. */
  poke(input: { users: readonly ID[] | 'all'; rev: number; except?: { userId: ID; clientId: ID } }): void;
  /** Ends the streams that the test selects. With no test: all streams. */
  close(test?: (stream: StreamInfo) => boolean): void;
  /** Ends all streams and the timer. */
  stop(): void;
  size(): number;
}

export function createEvents(pingMs: number = PING_MS): Events {
  const streams = new Set<Stream>();

  // A comment line keeps a proxy from closing a stream that is quiet.
  const ping = setInterval(() => {
    for (const stream of streams) stream.res.write(': ping\n\n');
  }, pingMs);
  ping.unref();

  const pokeText = (rev: number): string => `event: poke\ndata: {"rev":${rev}}\n\n`;

  function close(test?: (stream: StreamInfo) => boolean): void {
    for (const stream of [...streams]) {
      if (test && !test(stream)) continue;
      streams.delete(stream);
      stream.res.end();
    }
  }

  return {
    open({ req, res, rev, ...info }) {
      const own = [...streams].filter((s) => s.userId === info.userId);
      if (own.length >= MAX_STREAMS_PER_USER) {
        streams.delete(own[0]!);
        own[0]!.res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        // Tells a proxy in front of the server to pass each event on at once.
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });
      req.socket.setNoDelay(true);
      const stream: Stream = { ...info, res };
      streams.add(stream);
      res.on('close', () => streams.delete(stream));
      // The first poke tells a device that connects again what it missed while it was away.
      res.write(`retry: 3000\n\n${pokeText(rev)}`);
    },

    poke({ users, rev, except }) {
      const text = pokeText(rev);
      for (const stream of streams) {
        if (users !== 'all' && !users.includes(stream.userId)) continue;
        // A device id counts only for its own person. So a person who sends the device id of a
        // different person cannot stop the pokes to that device.
        if (except && stream.clientId === except.clientId && stream.userId === except.userId) continue;
        stream.res.write(text);
      }
    },

    close,

    stop() {
      clearInterval(ping);
      close();
    },

    size: () => streams.size,
  };
}
