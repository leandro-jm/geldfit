import { formatBRL, monthLabel, type ProjectionDTO, type ProjectionMonth } from '@sf/shared';
import { sql, type Tx } from '@sf/db';

export async function computeProjection(
  tx: Tx,
  ws: string,
  opts: { months?: number; accountId?: string | null; today?: string | null } = {},
): Promise<ProjectionDTO> {
  const rows = await sql<ProjectionMonth>`
    select * from project(${ws}::uuid, ${opts.months ?? 24}::int, ${opts.accountId ?? null}::uuid, ${opts.today ?? null}::date)
  `.execute(tx);
  const floor = await tx
    .selectFrom('workspaceSettings')
    .select('balanceFloorCents')
    .where('workspaceId', '=', ws)
    .executeTakeFirst();
  const months = rows.rows;
  const firstBelow = months.find((m) => m.belowFloor)?.month ?? null;
  const min = months.reduce<ProjectionMonth | null>(
    (acc, m) => (!acc || m.closingCents < acc.closingCents ? m : acc),
    null,
  );
  return {
    months,
    floorCents: floor?.balanceFloorCents ?? 0,
    firstBelowFloor: firstBelow,
    minClosing: min ? { month: min.month, cents: min.closingCents } : null,
    computedAt: new Date().toISOString(),
  };
}

/** Frase curta com o efeito de uma mudança na projeção ("março/2027 passa a fechar em −R$ 320,00"). */
export function projectionImpact(before: ProjectionDTO, after: ProjectionDTO): string | null {
  const pairs = after.months.map((m, i) => ({ m, b: before.months[i] })).filter((p) => p.b);
  // 1) mês que cruzou o piso
  const crossed = pairs.find((p) => p.m.belowFloor !== p.b!.belowFloor);
  if (crossed) {
    const label = monthLabel(crossed.m.month, true);
    return crossed.m.belowFloor
      ? `Atenção: ${label} passa a fechar em ${formatBRL(crossed.m.closingCents)}, abaixo do piso.`
      : `${label} volta a fechar acima do piso (${formatBRL(crossed.m.closingCents)}).`;
  }
  // 2) maior variação absoluta
  let best: (typeof pairs)[number] | null = null;
  for (const p of pairs) {
    const d = Math.abs(p.m.closingCents - p.b!.closingCents);
    if (d > 0 && (!best || d > Math.abs(best.m.closingCents - best.b!.closingCents))) best = p;
  }
  if (!best) return null;
  const delta = best.m.closingCents - best.b!.closingCents;
  const last = after.months[after.months.length - 1]!;
  const lastBefore = before.months[before.months.length - 1]!;
  const sameDeltaToEnd = last.closingCents - lastBefore.closingCents === delta;
  const sign = delta > 0 ? '+' : '−';
  if (sameDeltaToEnd && best === pairs[0]) {
    return `Seu saldo projetado muda ${sign}${formatBRL(Math.abs(delta))} a partir de ${monthLabel(best.m.month, true)}.`;
  }
  return `${cap(monthLabel(best.m.month, true))} passa a fechar em ${formatBRL(best.m.closingCents)} (${sign}${formatBRL(Math.abs(delta))}).`;
}

function cap(s: string) {
  return s[0]!.toUpperCase() + s.slice(1);
}
