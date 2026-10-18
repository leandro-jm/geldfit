import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function keyOf(keyB64: string) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('chave de cifragem deve ter 32 bytes (base64)');
  return key;
}

/** Cifra um segredo curto (chave de API) com AES-256-GCM: `v1:` + base64(IV(12) | TAG(16) | ciphertext). */
export function encryptSecret(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(keyB64), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

/** Decifra o que `encryptSecret` gerou. Lança erro se a chave for outra ou o valor foi adulterado. */
export function decryptSecret(blob: string, keyB64: string): string {
  if (!blob.startsWith(`${VERSION}:`)) throw new Error('formato de segredo desconhecido');
  const buf = Buffer.from(blob.slice(VERSION.length + 1), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(keyB64), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
