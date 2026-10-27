// For the tests of this folder: a signed-in data layer of Alex with a stand-in server and a clock
// that does not move. Sam is the second account. A test file puts it in place of the data layer:
//   vi.mock('../data/index.ts', async () => (await import('./testkit.ts')).layer);
import { newId } from '../../../shared/ids.ts';
import type { ID, NoteFields, NoteRow } from '../../../shared/types.ts';
import { fakeClock, makeDevice, stubServer } from '../data/testkit.ts';

/** The default list of Alex. */
export const MY_LIST: ID = 'list-1';
export const ALEX: ID = 'user-1';
export const SAM: ID = 'user-2';

export const clock = fakeClock();
export const server = stubServer(clock.now);
export const device = makeDevice({ server, clock, locale: 'en-GB' });
await device.layer.start();
await clock.advance(0);

export const layer = device.layer;

let serial = 0;

/** Makes a note of Alex. */
export function makeNote(fields: { title?: string; body?: string; pinned?: boolean; shared?: boolean } = {}): NoteRow {
  const id = layer.actions.createNote({ title: `Note ${++serial}`, ...fields }).puts[0]!.id;
  return layer.getNote(id)!;
}

/** Sends the outbox and gets the changes of the server. */
export async function syncNow(): Promise<void> {
  void layer.sync.now();
  await clock.advance(100);
}

/** Sam makes a note on the server and shares it. Alex gets it at the sync. */
export async function samNote(fields: NoteFields = {}): Promise<NoteRow> {
  const id = newId();
  server.putNote({ user: SAM, id, fields: { title: `Sam note ${++serial}`, shared: true, editedBy: SAM, createdAt: clock.now(), ...fields } });
  await syncNow();
  return layer.getNote(id)!;
}

/** A change of Sam on the server. Alex gets it at the sync. */
export async function samChanges(id: ID, fields: NoteFields): Promise<void> {
  server.putNote({ user: SAM, id, fields: { editedAt: clock.now(), editedBy: SAM, ...fields } });
  await syncNow();
}
