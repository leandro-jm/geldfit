import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/secret-box.js';

describe('secret-box', () => {
  const key = randomBytes(32).toString('base64');

  it('cifra e decifra; o texto puro não aparece no valor salvo', () => {
    const blob = encryptSecret('sk-ant-chave-de-teste-1234', key);
    expect(blob).not.toContain('sk-ant');
    expect(blob).not.toBe(encryptSecret('sk-ant-chave-de-teste-1234', key)); // IV aleatório
    expect(decryptSecret(blob, key)).toBe('sk-ant-chave-de-teste-1234');
  });

  it('recusa outra chave e valor adulterado', () => {
    const blob = encryptSecret('segredo', key);
    expect(() => decryptSecret(blob, randomBytes(32).toString('base64'))).toThrow();
    const tampered = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});
