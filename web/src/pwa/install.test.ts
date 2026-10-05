import { afterEach, expect, test, vi } from 'vitest';
import { isIos, isStandalone } from './install.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

function device({ userAgent = MAC, maxTouchPoints = 0, standalone, displayMode = 'browser' }: { userAgent?: string; maxTouchPoints?: number; standalone?: boolean; displayMode?: string }) {
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints, standalone });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === `(display-mode: ${displayMode})` }));
}

afterEach(() => vi.unstubAllGlobals());

test('isIos: an iPhone, and an iPad that says it is a Mac, but not a Mac or an Android phone', () => {
  device({ userAgent: IPHONE, maxTouchPoints: 5 });
  expect(isIos()).toBe(true);
  device({ userAgent: MAC, maxTouchPoints: 5 });
  expect(isIos()).toBe(true);
  device({ userAgent: MAC });
  expect(isIos()).toBe(false);
  device({ userAgent: ANDROID, maxTouchPoints: 5 });
  expect(isIos()).toBe(false);
});

test('isStandalone: from the display mode, or from the property of Safari', () => {
  device({});
  expect(isStandalone()).toBe(false);
  device({ displayMode: 'standalone' });
  expect(isStandalone()).toBe(true);
  device({ standalone: true });
  expect(isStandalone()).toBe(true);
});
