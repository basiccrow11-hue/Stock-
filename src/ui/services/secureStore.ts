/**
 * Encrypted-at-rest storage for API credentials (WebCrypto AES-GCM, key derived from a passphrase
 * with PBKDF2-SHA256, 310k iterations, random salt and IV). The passphrase is never stored.
 *
 * Honest limits: anything running in this page can read keys once they are unlocked into memory.
 * The most secure option is keeping keys server-side in .env.local (see README), which this app
 * also supports.
 */
import { idb } from './idb';
import type { VendorCredentials } from '../../core/data/vendorProviders';

const KEY = 'encrypted-credentials';
const ITERATIONS = 310_000;

interface Sealed {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function saveEncrypted(creds: VendorCredentials, passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plain = new TextEncoder().encode(JSON.stringify({ polygonApiKey: creds.polygonApiKey, alpacaKeyId: creds.alpacaKeyId, alpacaSecret: creds.alpacaSecret, alpacaFeed: creds.alpacaFeed }));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  const sealed: Sealed = { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
  await idb.set('kv', KEY, sealed);
}

export async function hasEncrypted(): Promise<boolean> {
  try {
    return !!(await idb.get<Sealed>('kv', KEY));
  } catch {
    return false;
  }
}

export async function loadEncrypted(passphrase: string): Promise<VendorCredentials> {
  const sealed = await idb.get<Sealed>('kv', KEY);
  if (!sealed) throw new Error('No saved credentials.');
  const key = await deriveKey(passphrase, unb64(sealed.salt));
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) as BufferSource }, key, unb64(sealed.data) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('Wrong passphrase.');
  }
}

export async function deleteEncrypted(): Promise<void> {
  await idb.delete('kv', KEY);
}
