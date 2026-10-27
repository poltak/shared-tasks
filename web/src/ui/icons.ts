// The icons of the app, drawn for it on a 24 px grid. One style: an outline of 1.75 px with round
// ends and round corners.

/** A circle with radius `r`, as a path. With a small radius the outline fills it, and it is a dot. */
const circle =
  (r: number) =>
  (x: number, y: number): string =>
    `M${+(x - r).toFixed(2)} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const dot = circle(0.6);
const bigDot = circle(0.9);
const gripDot = circle(0.75);
const point = circle(0.3);
const face = circle(8.5)(12, 12);

const STAR =
  'M12 3.85l2.32 5.7 6.14.45-4.7 3.97 1.47 5.98L12 16.7l-5.23 3.25 1.47-5.98L3.54 10l6.14-.45z';
const CLOUD = 'M7.5 18.5a4.25 4.25 0 0 1-.6-8.46 5.5 5.5 0 0 1 10.57-.9A4.75 4.75 0 0 1 17 18.5z';
const LINES = 'M4 7h16M4 12h16';
// A push pin seen from the side: the head, the body that grows wider, the plate, and the needle.
const PIN = 'M8.5 3.5h7M9.75 3.5V9L7 12.25V14h10v-1.75L14.25 9V3.5M12 14v6.5';
// A box with its lid, for the archive of notes. The arrow tells the direction.
const BOX = 'M5 4.5h14a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1zM5.5 8.5v10A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-10';

export const ICONS = {
  check: 'M4.75 12.75l4.75 4.75L19.25 7',
  'check-small': 'M7 12.5l3.4 3.4L17 8.75',
  circle: face,
  plus: 'M12 5v14M5 12h14',
  // A circle that is open at the top right, where the plus sign is.
  'add-task': 'M19.5 12.5a8 8 0 1 1-5.26-7.52M8 12.5l2.5 2.5 4.5-5M19 2.5v5M16.5 5h5',
  star: STAR,
  'star-filled': STAR,
  more: bigDot(12, 5.5) + bigDot(12, 12) + bigDot(12, 18.5),
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M19.5 12h-15M10.5 6l-6 6 6 6',
  menu: LINES + 'M4 17h16',
  'chevron-up': 'M6 15l6-6 6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-left': 'M14.5 6l-6 6 6 6',
  'chevron-right': 'M9.5 6l6 6-6 6',
  caret: 'M8 10.25h8l-4 4.5z',
  clock: face + 'M12 7.5V12l3 2',
  repeat: 'M17 3.5l3 3-3 3M4 11.5v-1a4 4 0 0 1 4-4h12M7 20.5l-3-3 3-3M20 12.5v1a4 4 0 0 1-4 4H4',
  target: face + circle(4.5)(12, 12) + circle(0.7)(12, 12),
  notes: LINES + 'M4 17h10',
  bin: 'M4.5 6.5h15M9.5 6.5v-2h5v2M6.5 6.5l.75 12a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5l.75-12M10 10.5V16M14 10.5V16',
  drag: gripDot(9, 6) + gripDot(15, 6) + gripDot(9, 12) + gripDot(15, 12) + gripDot(9, 18) + gripDot(15, 18),
  people:
    circle(3.5)(9, 8) + 'M2.5 19.5a6.5 6.5 0 0 1 13 0M15.5 4.75a3.5 3.5 0 0 1 0 6.5M18.25 14.25a6.5 6.5 0 0 1 3.25 5.25',
  person: circle(4)(12, 8) + 'M4.5 20a7.5 7.5 0 0 1 15 0',
  sort: 'M8 4.5V19M4.5 15.5L8 19l3.5-3.5M16 19.5V5M12.5 8.5L16 5l3.5 3.5',
  list: 'M9 7h11M9 12h11M9 17h11' + dot(4.75, 7) + dot(4.75, 12) + dot(4.75, 17),
  'list-add': 'M4 7h13M4 12h8M4 17h6M17.5 12.5v7M14 16h7',
  print:
    'M7 8V4h10v4M7 17H5.5A1.5 1.5 0 0 1 4 15.5v-6A1.5 1.5 0 0 1 5.5 8h13A1.5 1.5 0 0 1 20 9.5v6a1.5 1.5 0 0 1-1.5 1.5H17M7 14h10v6H7z',
  settings:
    'M10.4 5.08l.31-2.29h2.58l.31 2.29a7.1 7.1 0 0 1 2.16.9l1.84-1.41 1.83 1.83-1.41 1.84a7.1 7.1 0 0 1 .9 2.16l2.29.31v2.58l-2.29.31a7.1 7.1 0 0 1-.9 2.16l1.41 1.84-1.83 1.83-1.84-1.41a7.1 7.1 0 0 1-2.16.9l-.31 2.29h-2.58l-.31-2.29a7.1 7.1 0 0 1-2.16-.9L6.4 19.43 4.57 17.6l1.41-1.84a7.1 7.1 0 0 1-.9-2.16l-2.29-.31v-2.58l2.29-.31a7.1 7.1 0 0 1 .9-2.16L4.57 6.4 6.4 4.57l1.84 1.41a7.1 7.1 0 0 1 2.16-.9z' +
    circle(3)(12, 12),
  bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 21a2.2 2.2 0 0 0 4 0',
  cloud: CLOUD,
  'cloud-done': CLOUD + 'M9 13.25l2.25 2.25 3.75-4',
  // The line goes from the top left through the cloud. The cloud has a gap there.
  'cloud-off':
    'M4 3.5l16.5 17M9.3 6.1a5.5 5.5 0 0 1 8.17 3.04A4.75 4.75 0 0 1 20.4 16.6M17 18.5H7.5a4.25 4.25 0 0 1-1.55-8.2',
  sync: 'M4.5 12a7.5 7.5 0 0 1 13.1-5M18 3.5v4h-4M19.5 12a7.5 7.5 0 0 1-13.1 5M6 20.5v-4h4',
  calendar:
    'M5.5 5.5h13A1.5 1.5 0 0 1 20 7v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5V7a1.5 1.5 0 0 1 1.5-1.5zM4 10h16M8 3.5v4M16 3.5v4',
  indent: 'M4 5.5h16M11 10h9M11 14h9M4 18.5h16M4 9.5L7.5 12 4 14.5',
  unindent: 'M4 5.5h16M11 10h9M11 14h9M4 18.5h16M7.5 9.5L4 12l3.5 2.5',
  subtask: 'M5 4.5v8a3 3 0 0 0 3 3h11M15 11.5l4 4-4 4',
  'to-top': 'M5 4.5h14M12 20V9M7 13.5L12 8.5l5 5',
  'arrow-up': 'M12 19.5v-15M6 10.5l6-6 6 6',
  'arrow-down': 'M12 4.5v15M6 13.5l6 6 6-6',
  'arrow-right': 'M4.5 12h15M13.5 6l6 6-6 6',
  keyboard:
    'M4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6zM8 14.5h8' +
    point(7, 10) +
    point(10.33, 10) +
    point(13.67, 10) +
    point(17, 10),
  help: face + 'M9.6 9.6a2.5 2.5 0 1 1 3.7 2.2c-.8.45-1.3 1-1.3 1.95' + point(12, 16.6),
  info: face + 'M12 11.25v5' + point(12, 7.9),
  logout: 'M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10M15 8l4 4-4 4M19 12H9.5',
  lock: 'M6.5 10.5h11A1.5 1.5 0 0 1 19 12v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5V12a1.5 1.5 0 0 1 1.5-1.5zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5',
  edit: 'M4.5 19.5l.9-3.9L15.6 5.4a1.6 1.6 0 0 1 2.26 0l.74.74a1.6 1.6 0 0 1 0 2.26L8.4 18.6zM13.75 7.25l3 3',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  // A light bulb, for the notes.
  bulb: 'M9 17.5h6M10 20.5h4M9 15c0-1.1-.5-1.9-1.2-2.6a6 6 0 1 1 8.4 0c-.7.7-1.2 1.5-1.2 2.6v.5H9z',
  pin: PIN,
  'pin-filled': PIN,
  archive: BOX + 'M12 11.5v5M9.5 14l2.5 2.5 2.5-2.5',
  unarchive: BOX + 'M12 16.5v-5M9.5 14l2.5-2.5 2.5 2.5',
  palette:
    'M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.75-.75 1.75-1.6 0-.45-.2-.8-.45-1.1-.25-.3-.45-.65-.45-1.1 0-.9.7-1.6 1.6-1.6h1.8a4.25 4.25 0 0 0 4.25-4.25C20.5 6.9 16.7 3.5 12 3.5z' +
    bigDot(7.5, 12) +
    bigDot(9, 7.75) +
    bigDot(13.5, 6.75) +
    bigDot(16.75, 9.75),
  search: circle(6)(10.5, 10.5) + 'M15 15l5 5',
  // A drop with a line through it: a note with no color.
  'color-off': 'M7.6 7.4C6.7 8.8 6 10.4 6 12a6 6 0 0 0 10.3 4.2M17.6 13.2c.3-.4.4-.8.4-1.2 0-3.6-6-9-6-9s-1.3 1.2-2.7 2.9M4 4l16 16',
  sun:
    circle(4)(12, 12) +
    'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
} as const;

export type IconName = keyof typeof ICONS;

/** These icons are a filled shape. All others are an outline. */
export const FILLED_ICONS: ReadonlySet<IconName> = new Set<IconName>(['star-filled', 'caret', 'pin-filled']);

export const ICON_NAMES = Object.keys(ICONS) as IconName[];
