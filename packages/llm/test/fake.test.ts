import { describe, expect, it } from 'vitest';
import { fakeRoute } from '../src/index.js';

describe('FakeProvider: roteamento de frases do PRD', () => {
  it('lançamento simples com conta e data', () => {
    expect(fakeRoute('paguei 230 de luz no BB ontem')).toEqual({
      name: 'draft_transactions',
      input: {
        items: [
          {
            description: 'Luz',
            amount: '230',
            direction: 'out',
            date: 'ontem',
            account: 'bb',
            card: null,
            installments: 1,
          },
        ],
      },
    });
  });
  it('compra parcelada no cartão', () => {
    expect(fakeRoute('comprei uma TV de 3.600 em 10x no cartão Santander')).toMatchObject({
      name: 'draft_transactions',
      input: { items: [{ description: 'Tv', amount: '3.600', installments: 10, card: 'santander' }] },
    });
  });
  it('recorrência', () => {
    expect(fakeRoute('todo dia 5 entra 8.500 de salário no BB')).toMatchObject({
      name: 'draft_recurrence',
      input: { amount: '8.500', direction: 'in', day_of_month: 5, account: 'bb' },
    });
  });
  it('consultas', () => {
    expect(fakeRoute('quanto sobra em dezembro?')).toEqual({
      name: 'get_projection',
      input: { month: 'dezembro' },
    });
    expect(fakeRoute('quanto gastei com mercado em setembro?')).toMatchObject({
      name: 'query_transactions',
      input: { category_or_text: 'mercado', month: 'setembro' },
    });
  });
  it('edição e exclusão', () => {
    expect(fakeRoute('corrige o último lançamento para 250')).toEqual({
      name: 'draft_edit',
      input: { target: 'last', changes: { amount: '250' } },
    });
    expect(fakeRoute('apaga a compra da farmácia')).toEqual({
      name: 'draft_delete',
      input: { search: 'farmacia' },
    });
  });
  it('conta e cartão', () => {
    expect(fakeRoute('abri uma conta no Cresol com 2.000')).toMatchObject({
      name: 'draft_account',
      input: { institution: 'cresol', opening_balance: '2.000' },
    });
    expect(fakeRoute('cartão Santander fecha dia 5 e vence dia 12, limite 10 mil')).toMatchObject({
      name: 'draft_card',
      input: { closing_day: 5, due_day: 12, limit: '10 mil' },
    });
  });
  it('boleto, folga e "posso comprar?"', () => {
    expect(fakeRoute('34191.75702 00123.456782 90123.456783 6 16050000023050 no BB')).toMatchObject({
      name: 'draft_bill',
      input: { account: 'bb' },
    });
    expect(fakeRoute('quanto posso gastar?')).toEqual({ name: 'get_safe_to_spend', input: {} });
    expect(fakeRoute('quanto tempo aguento se eu for demitido?')).toEqual({
      name: 'get_emergency_reserve',
      input: {},
    });
    expect(fakeRoute('posso comprar uma TV de 4.000 em 10x com 8% de desconto à vista?')).toEqual({
      name: 'evaluate_purchase',
      input: { description: 'Tv', price: '4.000', installments: 10, cash_discount_pct: 8 },
    });
    expect(fakeRoute('quanto da minha renda está comprometida?')).toEqual({
      name: 'get_income_commitment',
      input: {},
    });
    expect(fakeRoute('quando minhas parcelas acabam?')?.name).toBe('get_income_commitment');
    // "paguei" continua sendo lançamento comum
    expect(fakeRoute('paguei 230 de luz no BB')?.name).toBe('draft_transactions');
  });
  it('calendário anual', () => {
    expect(fakeRoute('quando vem o IPVA?')).toEqual({ name: 'get_calendar', input: { item: 'ipva' } });
    expect(fakeRoute('qual mês estoura no ano que vem?')?.name).toBe('get_calendar');
    expect(fakeRoute('e o 13º, quando cai?')).toEqual({ name: 'get_calendar', input: { item: '13º' } });
    expect(fakeRoute('confirma o IPVA de 2.500')).toEqual({
      name: 'draft_seasonal',
      input: { action: 'edit', item: 'ipva', amount: '2.500' },
    });
    expect(fakeRoute('pode colocar o IPTU')).toMatchObject({ input: { action: 'confirm', item: 'iptu' } });
    expect(fakeRoute('confirma o seguro de 2.600')).toMatchObject({
      input: { item: 'seguro', amount: '2.600' },
    });
    expect(fakeRoute('ignora o seguro auto')).toMatchObject({
      input: { action: 'dismiss', item: 'seguro auto' },
    });
  });
});
