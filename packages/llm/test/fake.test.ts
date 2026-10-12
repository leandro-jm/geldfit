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
});
