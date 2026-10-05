// Web Push with no library: the VAPID token of RFC 8292 and the message encryption of RFC 8291.
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import type { PushMessage } from '../shared/types.ts';
import type { PushSubscription } from './scheduler.ts';

/** A P-256 key pair in base64url: the public key as a 65-byte point, the private key as a 32-byte number. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const CURVE = 'prime256v1';
const TTL_SECONDS = 12 * 3600;
const RECORD_SIZE = 4096;
/** The salt, the record size, and the public key of the sender, before the encrypted record. */
const HEADER_SIZE = 16 + 4 + 1 + 65;
/**
 * A push service accepts a body of 4096 bytes. The body holds the header, the text, one delimiter
 * byte, and the 16-byte tag.
 */
const PAYLOAD_MAX = RECORD_SIZE - HEADER_SIZE - 17;
const SEND_TIMEOUT_MS = 15_000;

const b64u = (data: Uint8Array | string): string => Buffer.from(data).toString('base64url');
const fromB64u = (text: string): Buffer => Buffer.from(text, 'base64url');

export function makeVapidKeys(): VapidKeys {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  // A private key that starts with a zero byte comes out shorter. The token needs the full 32 bytes.
  const d = ecdh.getPrivateKey();
  const privateKey = Buffer.concat([Buffer.alloc(32 - d.length), d]);
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(privateKey) };
}

/** The value of the Authorization header for a request to the push service of the endpoint. */
export function vapidAuthHeader(input: { endpoint: string; subject: string; keys: VapidKeys; now: number }): string {
  const { keys } = input;
  const point = fromB64u(keys.publicKey);
  const key = createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)), d: keys.privateKey },
  });
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(
    JSON.stringify({
      aud: new URL(input.endpoint).origin,
      exp: Math.floor(input.now / 1000) + TTL_SECONDS,
      sub: input.subject,
    }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

function hmac(key: Uint8Array, ...parts: Uint8Array[]): Buffer {
  const h = createHmac('sha256', key);
  for (const part of parts) h.update(part);
  return h.digest();
}

/**
 * Encrypts a message for one subscription. Returns the body for `Content-Encoding: aes128gcm`.
 * `salt` and `localKeys` are random if not given. A test gives them to get a known result.
 */
export function encryptPayload(input: {
  payload: string | Uint8Array;
  p256dh: string;
  auth: string;
  salt?: Uint8Array;
  localKeys?: VapidKeys;
}): Buffer {
  const plaintext = Buffer.from(input.payload);
  if (plaintext.length > PAYLOAD_MAX) throw new Error(`A push message can have ${PAYLOAD_MAX} bytes at most`);
  const uaPublic = fromB64u(input.p256dh);
  const salt = input.salt ?? randomBytes(16);

  const ecdh = createECDH(CURVE);
  if (input.localKeys) ecdh.setPrivateKey(fromB64u(input.localKeys.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();

  // The names are those of RFC 8291, section 3.4. Each key needs one block of HKDF output only,
  // so one HMAC with the block number 1 at the end is the full expand step.
  const one = Buffer.from([1]);
  const prkKey = hmac(fromB64u(input.auth), ecdh.computeSecret(uaPublic));
  const ikm = hmac(prkKey, Buffer.from('WebPush: info\0'), uaPublic, asPublic, one);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), one).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), one).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // The byte 2 marks the end of the last record.
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext, cipher.getAuthTag()]);
}

/** Checks a subscription that a browser sent. null if it is not usable. */
export function parseSubscription(value: Record<string, unknown>): PushSubscription | null {
  const { endpoint, keys } = value;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || typeof keys !== 'object' || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  // The server sends requests to this address, so it must be a public service with encryption.
  if (url.protocol !== 'https:') return null;
  const point = fromB64u(p256dh);
  if (point.length !== 65 || point[0] !== 4 || fromB64u(auth).length !== 16) return null;
  try {
    // Throws if the point is not on the curve. Such a key would make each message to this device fail.
    const ecdh = createECDH(CURVE);
    ecdh.generateKeys();
    ecdh.computeSecret(point);
  } catch {
    return null;
  }
  return { endpoint, p256dh: b64u(point), auth: b64u(fromB64u(auth)) };
}

/** Sends one message. `status` is the status of the push service: 201 is success, 404 and 410 tell that the subscription is gone, 0 is a network error. */
export async function sendPush(input: {
  subscription: PushSubscription;
  message: PushMessage;
  keys: VapidKeys;
  subject: string;
  now?: number;
  fetchFn?: typeof fetch;
}): Promise<{ status: number }> {
  const { subscription } = input;
  let body: Buffer;
  try {
    body = encryptPayload({
      payload: JSON.stringify(input.message),
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    });
  } catch {
    // A message that cannot be made is the same as a message that the service refuses: a second
    // try gives the same result.
    return { status: 400 };
  }
  try {
    const response = await (input.fetchFn ?? fetch)(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthHeader({
          endpoint: subscription.endpoint,
          subject: input.subject,
          keys: input.keys,
          now: input.now ?? Date.now(),
        }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
        Urgency: 'high',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // The body is of no use, but the connection is free again only after it is read.
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status };
  } catch {
    return { status: 0 };
  }
}
