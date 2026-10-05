import type { ID } from './types.ts';

export function newId(): ID {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // A browser has randomUUID only on a page from HTTPS or from localhost. A phone that opens the
  // development server through the local network has only getRandomValues. The result has the
  // same form: a version 4 UUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
