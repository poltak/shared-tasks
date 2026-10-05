import { describe, expect, it } from 'vitest';
import { eventStreamOver } from './events.ts';
import { fakeClock, settle } from './testkit.ts';

/** A server answer whose body the test writes piece by piece. */
function streamed(status = 200) {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (controller) => void (feed = controller) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } }),
    write: (text: string) => feed.enqueue(encoder.encode(text)),
    end: () => feed.close(),
  };
}

function setup(answer: Response | Error) {
  const clock = fakeClock();
  const seen: string[] = [];
  const requests: { path: string; init?: RequestInit }[] = [];
  const open = eventStreamOver({
    fetch: async (path, init) => {
      requests.push({ path, init });
      if (answer instanceof Error) throw answer;
      // A real fetch ends the body when the caller aborts.
      init?.signal?.addEventListener('abort', () => void answer.body?.cancel().catch(() => undefined));
      return answer;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const stream = open('/api/events?client=c1', {
    onOpen: () => seen.push('open'),
    onPoke: (rev) => seen.push(`poke ${rev}`),
    onClose: (status) => seen.push(`close ${status}`),
  });
  return { clock, seen, requests, stream };
}

describe('event stream', () => {
  it('reads the pokes of the server, also when an event comes in pieces', async () => {
    const source = streamed();
    const { seen, requests } = setup(source.response);
    await settle();
    expect(seen).toEqual(['open']);
    expect(requests[0]!.path).toBe('/api/events?client=c1');
    expect(new Headers(requests[0]!.init?.headers).get('Accept')).toBe('text/event-stream');

    source.write('retry: 3000\n\nevent: poke\ndata: {"rev":7}\n\n');
    await settle();
    expect(seen).toEqual(['open', 'poke 7']);

    source.write(': ping\n\nevent: po');
    source.write('ke\ndata: {"re');
    await settle();
    expect(seen).toEqual(['open', 'poke 7']);
    source.write('v":8}\n');
    source.write('\nevent: poke\ndata: {"rev":9}\n\nevent: poke\ndata: {"rev":10}\n\n');
    await settle();
    expect(seen).toEqual(['open', 'poke 7', 'poke 8', 'poke 9', 'poke 10']);
  });

  it('ignores events that are not a poke and data that it cannot read', async () => {
    const source = streamed();
    const { seen } = setup(source.response);
    source.write('event: other\ndata: {"rev":1}\n\ndata: {"rev":2}\n\nevent: poke\ndata: not json\n\nevent: poke\ndata: {"rev":"3"}\n\n');
    source.write('event: poke\ndata: {"rev":4}\n\n');
    await settle();
    expect(seen).toEqual(['open', 'poke 4']);
  });

  it('tells the caller when the server ends the stream', async () => {
    const source = streamed();
    const { seen } = setup(source.response);
    await settle();
    source.end();
    await settle();
    expect(seen).toEqual(['open', 'close 0']);
  });

  it('gives the status of an answer that is not a stream', async () => {
    const { seen } = setup(new Response('{"error":{"code":"unauthorized","message":"Sign in first"}}', { status: 401 }));
    await settle();
    expect(seen).toEqual(['close 401']);
  });

  it('gives 0 for a request that fails', async () => {
    const { seen } = setup(new TypeError('fetch failed'));
    await settle();
    expect(seen).toEqual(['close 0']);
  });

  it('ends a stream that is quiet for longer than two pings', async () => {
    const source = streamed();
    const { seen, clock, requests } = setup(source.response);
    await clock.advance(60_000);
    source.write(': ping\n\n');
    await clock.advance(69_000);
    expect(seen).toEqual(['open']);
    await clock.advance(1100);
    expect(seen).toEqual(['open', 'close 0']);
    expect(requests[0]!.init?.signal?.aborted).toBe(true);
    // One time only.
    await clock.advance(200_000);
    expect(seen).toEqual(['open', 'close 0']);
  });

  it('gives no close and no poke after the caller closed the stream', async () => {
    const source = streamed();
    const { seen, stream, clock, requests } = setup(source.response);
    await settle();
    stream.close();
    expect(requests[0]!.init?.signal?.aborted).toBe(true);
    try {
      source.write('event: poke\ndata: {"rev":5}\n\n');
    } catch {
      // The body is closed already.
    }
    await clock.advance(200_000);
    expect(seen).toEqual(['open']);
    expect(clock.waiting()).toBe(0);
  });
});
