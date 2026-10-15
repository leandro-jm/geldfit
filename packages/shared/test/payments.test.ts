import { describe, expect, it } from 'vitest';
import { crc16, dueDateFromFactor, hasPaymentCode, parsePaymentCode } from '../src/payments.js';

// Linhas geradas por uma implementação independente das regras FEBRABAN (mod 10 / mod 11)
const BOLETO_LINE = '34191.75702 00123.456782 90123.456783 6 16050000023050'; // Itaú, R$ 230,50, 20/10/2026
const BOLETO_BAR = '34196160500000230501757000123456789012345678';
const CONVENIO_MOD10 = '836900000016873400572020610150000004000000000018'; // energia, R$ 187,34
const CONVENIO_MOD11 = '838500000008999000572027610150000001000000000019'; // energia, R$ 99,90
// Exemplo do Manual de Padrões para Iniciação do Pix (BCB)
const PIX_BCB =
  '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

function withPixAmount(amount: string): string {
  const body =
    PIX_BCB.slice(0, PIX_BCB.indexOf('5802BR')) + `54${String(amount.length).padStart(2, '0')}${amount}`;
  const rest = PIX_BCB.slice(PIX_BCB.indexOf('5802BR'), -4);
  return body + rest + crc16(body + rest);
}

describe('boleto bancário', () => {
  it('linha digitável formatada: banco, valor e vencimento', () => {
    const r = parsePaymentCode(BOLETO_LINE, '2026-10-12');
    expect(r).toEqual({
      ok: true,
      code: {
        kind: 'boleto',
        barcode: BOLETO_BAR,
        bankCode: '341',
        payee: 'Itaú',
        amountCents: 23_050,
        dueDate: '2026-10-20',
      },
    });
  });
  it('código de barras (44 dígitos) e texto em volta', () => {
    const r = parsePaymentCode(`paga esse boleto pra mim: ${BOLETO_BAR} obrigado`, '2026-10-12');
    expect(r.ok && r.code.amountCents).toBe(23_050);
  });
  it('recusa dígito trocado em vez de inventar valor', () => {
    const wrong = BOLETO_LINE.replace('00123', '00124');
    const r = parsePaymentCode(wrong, '2026-10-12');
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/dígito/);
  });
  it('fator de vencimento: ciclo antigo e novo (reinício em 22/02/2025)', () => {
    expect(dueDateFromFactor(9999, '2025-02-20')).toBe('2025-02-21');
    expect(dueDateFromFactor(1000, '2025-03-01')).toBe('2025-02-22');
    expect(dueDateFromFactor(1000, '2000-07-01')).toBe('2000-07-03');
    expect(dueDateFromFactor(0, '2026-10-12')).toBeNull();
  });
});

describe('convênio (contas de consumo)', () => {
  it('valor efetivo com DV módulo 10', () => {
    const r = parsePaymentCode(CONVENIO_MOD10, '2026-10-12');
    expect(r).toMatchObject({
      ok: true,
      code: { kind: 'convenio', payee: 'Energia elétrica e gás', amountCents: 18_734, dueDate: null },
    });
  });
  it('valor efetivo com DV módulo 11', () => {
    const r = parsePaymentCode(CONVENIO_MOD11, '2026-10-12');
    expect(r).toMatchObject({ ok: true, code: { kind: 'convenio', amountCents: 9_990 } });
  });
  it('bloco com DV errado é recusado', () => {
    const wrong = `${CONVENIO_MOD10.slice(0, 11)}${(Number(CONVENIO_MOD10[11]) + 1) % 10}${CONVENIO_MOD10.slice(12)}`;
    expect(parsePaymentCode(wrong, '2026-10-12').ok).toBe(false);
  });
});

describe('Pix copia e cola', () => {
  it('exemplo do BCB: chave, recebedor e cidade; sem valor', () => {
    const r = parsePaymentCode(PIX_BCB, '2026-10-12');
    expect(r).toEqual({
      ok: true,
      code: {
        kind: 'pix',
        pixKey: '123e4567-e12b-12d1-a456-426655440000',
        pixUrl: null,
        dynamic: false,
        amountCents: null,
        dueDate: null,
        payee: 'Fulano de Tal',
        city: 'BRASILIA',
        txid: null,
      },
    });
  });
  it('com valor (campo 54)', () => {
    const r = parsePaymentCode(withPixAmount('150.90'), '2026-10-12');
    expect(r.ok && r.code.amountCents).toBe(15_090);
  });
  it('CRC errado é recusado', () => {
    expect(parsePaymentCode(PIX_BCB.replace('Fulano', 'Fulana'), '2026-10-12')).toMatchObject({
      ok: false,
    });
  });
  it('crc16 confere com o exemplo oficial', () => {
    expect(crc16(PIX_BCB.slice(0, -4))).toBe('1D3D');
  });
});

describe('hasPaymentCode', () => {
  it('detecta só códigos plausíveis', () => {
    expect(hasPaymentCode(BOLETO_LINE)).toBe(true);
    expect(hasPaymentCode(PIX_BCB)).toBe(true);
    expect(hasPaymentCode('paguei 230 de luz no BB')).toBe(false);
    expect(hasPaymentCode('meu telefone é 48 99999 0000')).toBe(false);
  });
});
