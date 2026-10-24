/**
 * Small crypto helpers on node:crypto: password hashing in the OWNER_PASSWORD_HASH format, constant-time
 * comparisons, random ids and tokens, SHA-256, and AES-256-GCM under a key derived from SESSION_SECRET.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Constant-time comparison of two strings (false when lengths differ, without leaking which). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Compare against itself to keep timing flat, then fail.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** "scrypt$N=16384,r=8,p=1$<base64url salt>$<base64url 32-byte hash>" (same format as scripts/hash-password.mjs). */
export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const { N, r, p, keyLen } = SCRYPT_PARAMS;
  const hash = scryptSync(password, salt, keyLen, { N, r, p });
  return `scrypt$N=${N},r=${r},p=${p}$${b64url(salt)}$${b64url(hash)}`;
}

/** Verify a password against the stored hash; never throws on malformed input (returns false). */
export function verifyPassword(password: string, stored: string): boolean {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (m === null) return false;
  const [, nStr, rStr, pStr, saltStr, hashStr] = m;
  if (nStr === undefined || rStr === undefined || pStr === undefined || saltStr === undefined || hashStr === undefined) return false;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = fromB64url(saltStr);
  const expected = fromB64url(hashStr);
  if (salt.length < 8 || expected.length < 16) return false;
  try {
    const actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** A device id: "d_" + 12 hex characters (matches the shared DEVICE_ID_PATTERN). */
export function newDeviceId(): string {
  return `d_${randomHex(6)}`;
}

/** 32 random bytes, base64url (43 characters). */
export function newSecret(): string {
  return b64url(randomBytes(32));
}

/** Six decimal digits, zero-padded, from a CSPRNG. */
export function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// AES-256-GCM under a key derived from SESSION_SECRET (server-side Anthropic key at rest)
// ---------------------------------------------------------------------------

export interface SealedBox {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
}

function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('jammarly-web', 'utf8'), Buffer.from(info, 'utf8'), 32));
}

export function sealString(plaintext: string, secret: string, info = 'server-key'): SealedBox {
  const key = deriveKey(secret, info);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 1, iv: b64url(iv), ct: b64url(ct), tag: b64url(cipher.getAuthTag()) };
}

/** Returns null when the box cannot be opened (wrong secret or tampering). */
export function openString(box: SealedBox, secret: string, info = 'server-key'): string | null {
  try {
    const key = deriveKey(secret, info);
    const decipher = createDecipheriv('aes-256-gcm', key, fromB64url(box.iv));
    decipher.setAuthTag(fromB64url(box.tag));
    return Buffer.concat([decipher.update(fromB64url(box.ct)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
