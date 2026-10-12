import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Armazenamento de anexos. Hoje em disco local; um S3FileStorage pode implementar a mesma interface. */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** URL assinada de curta duração para download via API. */
  signedUrl(attachmentId: string, ttlSeconds?: number): string;
  verifySignature(attachmentId: string, exp: number, sig: string): boolean;
}

const MAGIC = Buffer.from('SF1'); // versão do formato: MAGIC | IV(12) | TAG(16) | ciphertext

/**
 * Arquivos criptografados em repouso com AES-256-GCM. O nome no disco é <workspace>/<attachment>;
 * o nome original fica só no banco. O diretório nunca é servido como estático.
 */
export class LocalFileStorage implements FileStorage {
  private key: Buffer;

  constructor(
    private rootDir: string,
    encryptionKeyB64: string,
    private urlSecret: string,
    private publicApiUrl: string,
  ) {
    this.key = Buffer.from(encryptionKeyB64, 'base64');
    if (this.key.length !== 32) throw new Error('FILES_ENCRYPTION_KEY deve ter 32 bytes (base64)');
  }

  private resolve(key: string): string {
    const full = path.resolve(this.rootDir, key);
    if (!full.startsWith(path.resolve(this.rootDir) + path.sep)) throw new Error('chave de arquivo inválida');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    const out = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]);
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, out, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    const buf = await readFile(this.resolve(key));
    if (!buf.subarray(0, 3).equals(MAGIC)) throw new Error('formato de arquivo desconhecido');
    const iv = buf.subarray(3, 15);
    const tag = buf.subarray(15, 31);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(31)), decipher.final()]);
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }

  private sign(attachmentId: string, exp: number): string {
    return createHmac('sha256', this.urlSecret).update(`${attachmentId}.${exp}`).digest('base64url');
  }

  signedUrl(attachmentId: string, ttlSeconds = 300): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.publicApiUrl}/api/files/${attachmentId}?exp=${exp}&sig=${this.sign(attachmentId, exp)}`;
  }

  verifySignature(attachmentId: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(attachmentId, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
