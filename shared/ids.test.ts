import { afterEach, expect, test, vi } from 'vitest';
import { newId } from './ids.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

test('newId gives a different UUID each time', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newId()));
  expect(ids.size).toBe(1000);
  for (const id of ids) expect(id).toMatch(UUID);
});

test('newId works on a page that is not from HTTPS, where randomUUID is not there', () => {
  const real = crypto.randomUUID;
  // The browser leaves the function out. A spy cannot do that, so the property is replaced.
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  try {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(UUID);
    // The id is a legal row id for the server.
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  } finally {
    Object.defineProperty(crypto, 'randomUUID', { value: real, configurable: true, writable: true });
  }
  expect(newId()).toMatch(UUID);
});

test('newId uses each random byte: the fixed bits are only the version and the variant', () => {
  const real = crypto.randomUUID;
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  try {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint8Array).fill(0xff);
      return array;
    });
    expect(newId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint8Array).fill(0);
      return array;
    });
    expect(newId()).toBe('00000000-0000-4000-8000-000000000000');
  } finally {
    Object.defineProperty(crypto, 'randomUUID', { value: real, configurable: true, writable: true });
  }
});
