import { describe, expect, it } from 'vitest';
import { commitmentLevel, formatPct, visualToText } from '../src/commitment.js';
import type { ChatVisual } from '../src/api-types.js';

describe('renda comprometida', () => {
  it('níveis: até 20% ok, até 30% atenção, acima alto', () => {
    expect(commitmentLevel(null)).toBe('ok');
    expect(commitmentLevel(0.2)).toBe('ok');
    expect(commitmentLevel(0.21)).toBe('atencao');
    expect(commitmentLevel(0.3)).toBe('atencao');
    expect(commitmentLevel(0.31)).toBe('alto');
    expect(formatPct(0.384)).toBe('38%');
  });

  it('gráfico em texto para o WhatsApp: barras, alerta acima de 30% e antes → depois', () => {
    const v: ChatVisual = {
      type: 'commitment',
      title: 'Renda comprometida com parcelas',
      threshold: 0.3,
      months: [
        { month: '2026-11-01', pct: 0.38, committedCents: 228_000, incomeCents: 600_000 },
        { month: '2026-12-01', pct: 0.1, committedCents: 60_000, incomeCents: 600_000, addedCents: 30_000 },
        { month: '2027-01-01', pct: 0, committedCents: 0, incomeCents: 600_000 },
        { month: '2027-02-01', pct: null, committedCents: 10_000, incomeCents: 0 },
      ],
    };
    expect(visualToText(v)).toBe(
      [
        '📊 *Renda comprometida com parcelas*',
        '```',
        'nov ▇▇▇▇▇▇▇▇▇▇▇▇ 38% ⚠️',
        'dez ▇▇▇ 5% → 10%',
        'jan 0%',
        'fev sem renda prevista',
        '```',
      ].join('\n'),
    );
  });
});
