import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { encryptPayload, makeVapidKeys, parseSubscription, sendPush, vapidAuthHeader } from './push.ts';
import type { PushSubscription, SendFn } from './scheduler.ts';
import { makeKit, startTestServer } from './testkit.ts';
import type { TestServer } from './testkit.ts';
import type { PushMessage } from '../shared/types.ts';

const b64u = (text: string): Buffer => Buffer.from(text, 'base64url');

// The example of RFC 8291, section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The receiver side of RFC 8291: what a browser does with a push message. */
function decrypt(input: { body: Buffer; uaPrivate: string; uaPublic: string; auth: string }): string {
  const { body } = input;
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength, body.length - 16);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b64u(input.uaPrivate));
  const hmac = (key: Uint8Array, ...parts: Uint8Array[]): Buffer => {
    const h = createHmac('sha256', key);
    for (const part of parts) h.update(part);
    return h.digest();
  };
  const one = Buffer.from([1]);
  const prkKey = hmac(b64u(input.auth), ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.from('WebPush: info\0'), b64u(input.uaPublic), asPublic, one);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), one).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), one).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

function receiver(): { subscription: PushSubscription; uaPrivate: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    subscription: {
      endpoint: 'https://push.example.net/push/abc',
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: Buffer.from('0123456789abcdef').toString('base64url'),
    },
    uaPrivate: ecdh.getPrivateKey().toString('base64url'),
  };
}

describe('message encryption (RFC 8291)', () => {
  test('gives the bytes of the example in the RFC', () => {
    const body = encryptPayload({
      payload: RFC.plaintext,
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
      salt: b64u(RFC.salt),
      localKeys: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
    });
    expect(body.equals(b64u(RFC.message))).toBe(true);
    expect(body.toString('base64url')).toBe(RFC.message);
    // The header of 86 bytes, the text of 41 bytes, the delimiter, and the tag of 16 bytes.
    expect(body.length).toBe(144);
  });

  test('the receiver can read the example and a message with random keys', () => {
    expect(decrypt({ body: b64u(RFC.message), uaPrivate: RFC.uaPrivate, uaPublic: RFC.uaPublic, auth: RFC.auth })).toBe(RFC.plaintext);

    const { subscription, uaPrivate } = receiver();
    const text = JSON.stringify({ title: 'Größe 🍉', body: 'x'.repeat(500) });
    const first = encryptPayload({ payload: text, p256dh: subscription.p256dh, auth: subscription.auth });
    const second = encryptPayload({ payload: text, p256dh: subscription.p256dh, auth: subscription.auth });
    expect(decrypt({ body: first, uaPrivate, uaPublic: subscription.p256dh, auth: subscription.auth })).toBe(text);
    // A new salt and a new key pair for each message.
    expect(first.equals(second)).toBe(false);
    expect(first.subarray(16, 21)).toEqual(Buffer.from([0, 0, 16, 0, 65]));
  });

  test('refuses a message that does not go into one record', () => {
    const { subscription } = receiver();
    const encrypt = (size: number): Buffer =>
      encryptPayload({ payload: 'x'.repeat(size), p256dh: subscription.p256dh, auth: subscription.auth });
    // A push service accepts 4096 bytes: the header of 86 bytes, the text, the delimiter, and the tag.
    expect(encrypt(3993).length).toBe(4096);
    expect(() => encrypt(3994)).toThrow();
  });
});

describe('VAPID token (RFC 8292)', () => {
  test('the token verifies with the public key and has the right claims', () => {
    const keys = makeVapidKeys();
    expect(b64u(keys.publicKey).length).toBe(65);
    expect(b64u(keys.publicKey)[0]).toBe(4);
    expect(b64u(keys.privateKey).length).toBe(32);

    const now = Date.UTC(2026, 9, 6, 8, 0, 0);
    const header = vapidAuthHeader({
      endpoint: 'https://fcm.googleapis.com/fcm/send/some-device-token',
      subject: 'https://s22.example.ts.net:8443',
      keys,
      now,
    });
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b64u(head!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b64u(claims!).toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://s22.example.ts.net:8443',
    });

    const point = b64u(keys.publicKey);
    const publicKey = createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    });
    const signed = Buffer.from(`${head}.${claims}`);
    expect(b64u(signature!).length).toBe(64);
    expect(verify('sha256', signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64u(signature!))).toBe(true);
    expect(verify('sha256', Buffer.from(`${head}.${claims}x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64u(signature!))).toBe(false);

    // A different key pair does not verify the token.
    const other = makeVapidKeys();
    const otherPoint = b64u(other.publicKey);
    const otherKey = createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: otherPoint.subarray(1, 33).toString('base64url'), y: otherPoint.subarray(33).toString('base64url') },
    });
    expect(verify('sha256', signed, { key: otherKey, dsaEncoding: 'ieee-p1363' }, b64u(signature!))).toBe(false);
  });
});

describe('sendPush', () => {
  const seen: { headers: Record<string, string | string[] | undefined>; body: Buffer; path: string }[] = [];
  let answer = 201;
  const service = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url ?? '' });
      res.writeHead(answer).end();
    });
  });
  let endpoint = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}/push/device-1`;
  });
  afterAll(() => new Promise((resolve) => service.close(resolve)));

  test('sends the encrypted message with the headers of the protocol', async () => {
    const keys = makeVapidKeys();
    const { subscription, uaPrivate } = receiver();
    const message: PushMessage = { title: 'Call the dentist', body: 'My Tasks, 14:30', taskId: 't1', listId: 'l1', tag: 'due-t1' };
    const result = await sendPush({ subscription: { ...subscription, endpoint }, message, keys, subject: 'mailto:a@example.com' });
    expect(result).toEqual({ status: 201 });
    const got = seen.pop()!;
    expect(got.path).toBe('/push/device-1');
    expect(got.headers.ttl).toBe('43200');
    expect(got.headers.urgency).toBe('high');
    expect(got.headers['content-encoding']).toBe('aes128gcm');
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers.authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
    expect(JSON.parse(decrypt({ body: got.body, uaPrivate, uaPublic: subscription.p256dh, auth: subscription.auth }))).toEqual(message);
  });

  test('gives the status of the push service, and 0 for a network error', async () => {
    const keys = makeVapidKeys();
    const { subscription } = receiver();
    const message: PushMessage = { title: 'a', body: 'b', taskId: null, listId: null, tag: 'test' };
    answer = 410;
    expect(await sendPush({ subscription: { ...subscription, endpoint }, message, keys, subject: 'mailto:a@example.com' })).toEqual({ status: 410 });
    answer = 201;
    const dead = { ...subscription, endpoint: 'http://127.0.0.1:1/push' };
    expect(await sendPush({ subscription: dead, message, keys, subject: 'mailto:a@example.com' })).toEqual({ status: 0 });
  });
});

describe('push subscriptions', () => {
  test('parseSubscription accepts only an https endpoint with valid keys', () => {
    const { subscription } = receiver();
    const body = (change: Record<string, unknown> = {}, keys: Record<string, unknown> = {}): Record<string, unknown> => ({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth, ...keys },
      ...change,
    });
    expect(parseSubscription(body())).toEqual(subscription);
    expect(parseSubscription(body({ endpoint: 'http://push.example.net/x' }))).toBeNull();
    expect(parseSubscription(body({ endpoint: 'not an address' }))).toBeNull();
    expect(parseSubscription(body({ endpoint: 5 }))).toBeNull();
    expect(parseSubscription(body({}, { p256dh: 'AAAA' }))).toBeNull();
    expect(parseSubscription(body({}, { auth: 'AAAA' }))).toBeNull();
    expect(parseSubscription(body({ keys: null }))).toBeNull();
    // 65 bytes with the right first byte, but not a point of the curve.
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    expect(parseSubscription(body({}, { p256dh: offCurve }))).toBeNull();
  });

  test('a message that cannot be made gives a status with no second try, and no request', async () => {
    const { subscription } = receiver();
    const keys = makeVapidKeys();
    let requests = 0;
    const fetchFn = (async () => {
      requests += 1;
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    const small: PushMessage = { title: 'a', body: 'b', taskId: null, listId: null, tag: 'test' };
    const input = { keys, subject: 'mailto:a@example.com', fetchFn };
    expect(await sendPush({ ...input, subscription: { ...subscription, p256dh: offCurve }, message: small })).toEqual({ status: 400 });
    expect(await sendPush({ ...input, subscription, message: { ...small, body: 'x'.repeat(5000) } })).toEqual({ status: 400 });
    expect(requests).toBe(0);
    expect(await sendPush({ ...input, subscription, message: small })).toEqual({ status: 201 });
    expect(requests).toBe(1);
  });

  describe('routes', () => {
    let server: TestServer;
    const sent: { subscription: PushSubscription; message: PushMessage }[] = [];
    let status = 201;
    const send: SendFn = async (input) => {
      sent.push(input);
      return { status };
    };

    beforeAll(async () => {
      server = await startTestServer({ name: 'push', options: { send } });
    });
    afterAll(() => server.stop());

    test('subscribe, test message, unsubscribe, and the end of a session', async () => {
      const kit = makeKit(server);
      const alex = await kit.register('Alex');
      const phone = await kit.login('Alex');
      const one = receiver().subscription;
      const two = { ...receiver().subscription, endpoint: 'https://push.example.net/push/two' };
      const asBody = (s: PushSubscription): unknown => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });

      expect((await kit.call({ path: '/api/push/subscribe', body: asBody(one) })).status).toBe(401);
      expect((await alex.call('/api/push/subscribe', { endpoint: 'http://x.example/1', keys: {} })).status).toBe(400);
      expect((await alex.call('/api/push/subscribe', asBody(one))).data).toEqual({ ok: true });
      // The same subscription a second time is not a second row.
      expect((await alex.call('/api/push/subscribe', asBody(one))).status).toBe(200);
      expect((await phone.call('/api/push/subscribe', asBody(two))).status).toBe(200);
      const count = (): number => (server.app.db.q('SELECT COUNT(*) AS n FROM push_subs').get() as { n: number }).n;
      expect(count()).toBe(2);

      const reply = await alex.call('/api/push/test', {});
      expect(reply.data).toEqual({ sent: 2, failed: 0 });
      expect(sent.map((s) => s.subscription.endpoint).sort()).toEqual([one.endpoint, two.endpoint].sort());
      expect(sent[0]!.message).toEqual({
        title: 'Shared Tasks',
        body: 'Notifications work on this device',
        taskId: null,
        listId: null,
        tag: 'test',
      });

      // A sign-out ends the notifications of that device.
      await phone.call('/api/logout', {});
      expect(count()).toBe(1);

      // The push service tells that the subscription is gone: the server deletes it.
      status = 410;
      expect((await alex.call('/api/push/test', {})).data).toEqual({ sent: 0, failed: 1 });
      expect(count()).toBe(0);
      status = 201;

      await alex.call('/api/push/subscribe', asBody(one));
      expect(count()).toBe(1);
      expect((await alex.call('/api/push/unsubscribe', { endpoint: one.endpoint })).data).toEqual({ ok: true });
      expect(count()).toBe(0);
      expect((await alex.call('/api/push/test', {})).data).toEqual({ sent: 0, failed: 0 });
    });

    test('the server keeps one key pair and gives its public key to the client', async () => {
      const kit = makeKit(server);
      const me = await kit.call({ path: '/api/me' });
      expect(b64u(me.data.vapidPublicKey).length).toBe(65);
      expect(JSON.parse(server.app.db.getMeta('vapid')!).publicKey).toBe(me.data.vapidPublicKey);
    });
  });
});
