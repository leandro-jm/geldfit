import { describe, expect, it } from 'vitest';
import { parseAmount, parseMonth, parseRelativeDate, wordsToNumber } from '../src/ptbr.js';
import { maskSensitive } from '../src/security.js';
import { addMonths } from '../src/dates.js';

describe('parseAmount', () => {
  it.each([
    ['230', 23_000],
    ['230,50', 23_050],
    ['1.234,56', 123_456],
    ['R$ 3.600', 360_000],
    ['3.600,00', 360_000],
    ['2,3k', 230_000],
    ['2.3k', 230_000],
    ['3 mil', 300_000],
    ['1,5 mi', 150_000_000],
    ['duzentos e trinta', 23_000],
    ['dois mil e quinhentos', 250_000],
    ['8.500', 850_000],
    ['1234.56', 123_456],
  ])('%s → %i', (input, cents) => {
    expect(parseAmount(input)).toBe(cents);
  });
  it('rejeita lixo', () => {
    expect(parseAmount('abc')).toBeNull();
    expect(wordsToNumber('banana')).toBeNull();
  });
});

describe('parseRelativeDate', () => {
  const today = '2026-10-11'; // domingo
  it.each([
    ['hoje', '2026-10-11'],
    ['ontem', '2026-10-10'],
    ['anteontem', '2026-10-09'],
    ['amanhã', '2026-10-12'],
    ['dia 5', '2026-10-05'],
    ['5/10', '2026-10-05'],
    ['05/11/2026', '2026-11-05'],
    ['mês que vem', '2026-11-11'],
    ['dia 10 do mês que vem', '2026-11-10'],
    ['5 de março', '2026-03-05'],
    ['há 3 dias', '2026-10-08'],
    ['sexta', '2026-10-09'],
    ['próxima sexta', '2026-10-16'],
  ])('%s → %s', (input, iso) => {
    expect(parseRelativeDate(input, today)).toBe(iso);
  });
  it('futuro: dia que já passou vai para o próximo mês', () => {
    expect(parseRelativeDate('dia 5', today, { future: true })).toBe('2026-11-05');
  });
});

describe('parseMonth', () => {
  it('mês sem ano é o próximo com esse nome', () => {
    expect(parseMonth('março', '2026-10-11')).toBe('2027-03-01');
    expect(parseMonth('dezembro', '2026-10-11')).toBe('2026-12-01');
    expect(parseMonth('outubro', '2026-10-11')).toBe('2026-10-01');
    expect(parseMonth('set/2026', '2026-10-11')).toBe('2026-09-01');
  });
});

describe('addMonths', () => {
  it('limita ao fim do mês', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('maskSensitive', () => {
  it('mascara PAN válido e CPF', () => {
    expect(maskSensitive('cartão 4111 1111 1111 1111 ok')).toBe('cartão **** **** **** 1111 ok');
    expect(maskSensitive('CPF 529.982.247-25')).toBe('CPF ***.***.***-25');
  });
  it('não mexe em números comuns', () => {
    expect(maskSensitive('total 1234567890123')).toBe('total 1234567890123');
  });
});
