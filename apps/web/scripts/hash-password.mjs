#!/usr/bin/env node
/**
 * Prints the OWNER_PASSWORD_HASH value for a password:
 *
 *   node scripts/hash-password.mjs 'my password'
 *   printf 'my password' | node scripts/hash-password.mjs
 *
 * Output format: scrypt$N=16384,r=8,p=1$<base64url salt>$<base64url 32-byte hash>
 */
import { randomBytes, scryptSync } from 'node:crypto';

const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 32;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const fromArg = process.argv[2];
const password = (fromArg !== undefined ? fromArg : await readStdin()).replace(/\r?\n$/, '');
if (password.length === 0) {
  console.error('usage: hash-password.mjs <password>  (or pipe the password on stdin)');
  process.exit(2);
}
const salt = randomBytes(16);
const hash = scryptSync(password, salt, KEY_LEN, { N, r, p });
process.stdout.write(`scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64url')}$${hash.toString('base64url')}\n`);
