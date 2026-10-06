// For the tests of this folder: a signed-in data layer with a stand-in server and a clock that
// does not move. A test file puts it in place of web/src/data/index.ts:
//   vi.mock('../data/index.ts', async () => (await import('./testkit.ts')).layer);
import type { ID, ListRow, TaskRow } from '../../../shared/types.ts';
import { fakeClock, makeDevice, stubServer } from '../data/testkit.ts';

/** The default list of the signed-in person, Alex. */
export const MY_LIST: ID = 'list-1';

/** A list that the other person, Sam, owns and shares. */
export const SAM_LIST: ListRow = {
  id: 'list-sam',
  title: 'Sam list',
  owner: 'user-2',
  shared: true,
  isDefault: false,
  createdAt: 2,
  deleted: false,
  pos: 'a1',
  sort: 'my',
  hidden: false,
};

export const clock = fakeClock();
export const server = stubServer(clock.now);
server.onSync = (request, response) => {
  if (request.since === 0) response.lists.push(SAM_LIST);
};

export const device = makeDevice({ server, clock, locale: 'en-GB' });
await device.layer.start();
await clock.advance(0);

export const layer = device.layer;

let serial = 0;

/** Makes a list of Alex with a new name. */
export function makeList(title = `List ${++serial}`): ListRow {
  const id = layer.actions.createList({ title }).puts[0]!.id;
  return layer.getList(id)!;
}

/** Makes a task at the end of the list, or as the last subtask of `parentId`. */
export function makeTask(input: { listId: ID; title?: string; parentId?: ID; fields?: Partial<Pick<TaskRow, 'due' | 'time' | 'deadline' | 'repeat'>> }): TaskRow {
  const { listId, title = `Task ${++serial}`, parentId, fields } = input;
  const last = layer.listView(listId).groups.flatMap((group) => group.items).findLast((item) => item.depth === 0)?.task.id;
  const position = parentId ? ({ parentId, at: 'end' } as const) : last ? { after: last } : ({ at: 'top' } as const);
  const id = layer.actions.createTask({ listId, title, position, ...fields }).puts[0]!.id;
  return layer.getTask(id)!;
}

/** The titles of the open tasks of a list, in the order of the screen. */
export function titles(listId: ID): string[] {
  return layer.listView(listId).groups.flatMap((group) => group.items.map((item) => item.task.title));
}
