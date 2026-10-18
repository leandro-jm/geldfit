import {
  addMonths,
  descriptionKey,
  diffDays,
  fold,
  formatBRL,
  formatDateBR,
  monthDay,
  MONTHS_SHORT,
  normalizeDescription,
  parseISO,
  startOfMonth,
  type CalendarDTO,
  type SeasonalConfidence,
  type SeasonalEvidence,
  type SeasonalItemDTO,
  type SeasonalKind,
  type SeasonalOccurrenceDTO,
  type SeasonalScheduleEntry,
  type SeasonalStatus,
} from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import { ADJUSTABLE_RE, CATALOG, CATALOG_BY_KEY, COME_COTAS, SALARY_13_RE } from './seasonal-catalog.js';

/*
 * Calendário financeiro: itens anuais aprendidos do histórico (IPVA, IPTU, matrícula, 13º, IRPF,
 * reajustes de recorrências e anuais genéricos como seguro do carro).
 *
 * Cada item tem uma agenda anual ([{month, day, amountCents}]) agrupada por "temporada": o ano do
 * pagamento, exceto quando a temporada começa antes de janeiro (matrícula de novembro conta para o
 * ano letivo seguinte). Só itens confirmados entram na projeção, via planned_cashflows 'seasonal'.
 */

/** Quantos anos de histórico a detecção lê. */
const HISTORY_YEARS = 3;
/** Valor mínimo de um anual genérico (abaixo disso não pesa no mês). */
const MIN_ANNUAL_CENTS = 10_000;
/** Degrau mínimo e máximo de reajuste numa recorrência. */
const MIN_STEP = 0.03;
const MAX_STEP = 0.6;
/** Horizonte da projeção (meses). */
const PLANNED_MONTHS = 24;

interface HistTx {
  id: string;
  date: string;
  cents: number;
  direction: 'in' | 'out';
  description: string;
  norm: string;
  key: string;
  categoryId: string | null;
  recurrenceId: string | null;
  installment: boolean;
  seasonalItemId: string | null;
}

interface RecRow {
  id: string;
  description: string;
  amountCents: number;
  direction: 'in' | 'out';
  categoryId: string | null;
  categoryName: string | null;
  rule: string;
  amountMode: string;
  endDate: string | null;
}

interface ItemRow extends SeasonalItemDTO {
  matchPattern: string | null;
  recurrenceId: string | null;
  scheduleYear: number | null;
}

// ---------------------------------------------------------------------------
// Temporadas e agenda
// ---------------------------------------------------------------------------

/**
 * Formato da temporada de um item: mês em que começa e mês em que termina, deduzidos dos meses de
 * pagamento (o maior intervalo sem pagamento separa uma temporada da outra). IPVA em dez–fev começa
 * em dezembro; matrícula em nov e jan começa em novembro.
 */
export interface Season {
  start: number;
  last: number;
}

export function seasonShape(months: number[]): Season {
  const ms = [...new Set(months)].sort((a, b) => a - b);
  if (!ms.length || ms.length === 12) return { start: 1, last: 12 };
  let best = 0;
  let gap = -1;
  ms.forEach((m, i) => {
    const prev = ms[(i - 1 + ms.length) % ms.length]!;
    const g = (m - prev + 12) % 12 || 12;
    if (g > gap) {
      gap = g;
      best = i;
    }
  });
  return { start: ms[best]!, last: ms[(best - 1 + ms.length) % ms.length]! };
}

const shapeOf = (schedule: SeasonalScheduleEntry[]) => seasonShape(schedule.map((e) => e.month));
/** A temporada que cruza o ano leva o ano em que termina (IPVA dez/2025–fev/2026 é o de 2026). */
const crossesYear = (sh: Season) => sh.last < sh.start;

/** Ano da temporada de uma data. */
export function seasonOf(date: string, sh: Season): number {
  const { y, m } = parseISO(date);
  return (m >= sh.start ? y : y - 1) + (crossesYear(sh) ? 1 : 0);
}

function dateIn(season: number, e: SeasonalScheduleEntry, sh: Season): string {
  const startYear = season - (crossesYear(sh) ? 1 : 0);
  return monthDay(e.month >= sh.start ? startYear : startYear + 1, e.month, e.day);
}

/** Ordem do mês dentro da temporada (dezembro vem antes de janeiro quando a temporada começa em dezembro). */
const seasonOrder = (month: number, sh: Season) => (month - sh.start + 12) % 12;

/** Pagamentos de uma temporada viram a agenda: um item por mês (dia do primeiro pagamento, soma do mês). */
function scheduleFrom(txs: HistTx[], sh: Season): SeasonalScheduleEntry[] {
  const byMonth = new Map<number, SeasonalScheduleEntry>();
  for (const t of txs) {
    const { m, d } = parseISO(t.date);
    const e = byMonth.get(m);
    if (e) {
      e.amountCents += t.cents;
      e.day = Math.min(e.day, d);
    } else byMonth.set(m, { month: m, day: d, amountCents: t.cents });
  }
  return [...byMonth.values()].sort((a, b) => seasonOrder(a.month, sh) - seasonOrder(b.month, sh));
}

const total = (s: SeasonalScheduleEntry[]) => s.reduce((acc, e) => acc + e.amountCents, 0);

interface Learned {
  key: string;
  label: string;
  kind: SeasonalKind;
  direction: 'in' | 'out' | null;
  categoryId: string | null;
  leadDays: number;
  confidence: SeasonalConfidence;
  schedule: SeasonalScheduleEntry[];
  scheduleYear: number | null;
  evidence: SeasonalEvidence[];
  txIds: string[];
  recurrenceId?: string | null;
  adjustmentPct?: number | null;
}

/**
 * Aprende a agenda a partir dos pagamentos: a base é a última temporada completa. Se a temporada
 * corrente ainda está em andamento (pagou 1 de 3 parcelas), usa a anterior.
 */
export function learnSchedule(
  txs: HistTx[],
  today: string,
  maxMonths = 12,
): Pick<Learned, 'schedule' | 'scheduleYear' | 'evidence' | 'confidence'> | null {
  const sh = seasonShape(txs.map((t) => parseISO(t.date).m));
  const bySeason = new Map<number, HistTx[]>();
  for (const t of txs) {
    const s = seasonOf(t.date, sh);
    bySeason.set(s, [...(bySeason.get(s) ?? []), t]);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  if (!seasons.length) return null;
  const monthsOf = (s: number) => new Set(bySeason.get(s)!.map((t) => parseISO(t.date).m));
  if (seasons.some((s) => monthsOf(s).size > maxMonths)) return null;

  const cur = seasonOf(today, sh);
  let tpl = seasons.at(-1)!;
  if (tpl === cur && seasons.length > 1) {
    const prev = seasons.at(-2)!;
    const prevSchedule = scheduleFrom(bySeason.get(prev)!, sh);
    const curTotal = bySeason.get(cur)!.reduce((a, t) => a + t.cents, 0);
    const lastExpected = dateIn(cur, prevSchedule.at(-1)!, sh);
    const complete = curTotal >= 0.9 * total(prevSchedule) || diffDays(today, lastExpected) > 30;
    if (!complete) tpl = prev;
  }
  return {
    schedule: scheduleFrom(bySeason.get(tpl)!, sh),
    scheduleYear: tpl,
    confidence: seasons.length >= 2 ? 'alta' : 'media',
    evidence: seasons.map((s) => ({
      year: s,
      totalCents: bySeason.get(s)!.reduce((a, t) => a + t.cents, 0),
      months: [...monthsOf(s)].sort((a, b) => seasonOrder(a, sh) - seasonOrder(b, sh)),
      n: bySeason.get(s)!.length,
    })),
  };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

async function loadHistory(tx: Tx, ws: string, from: string, today: string): Promise<HistTx[]> {
  const rows = await tx
    .selectFrom('transactions')
    .select([
      'id',
      'date',
      'amountBrlCents',
      'direction',
      'description',
      'categoryId',
      'recurrenceId',
      'installmentGroupId',
      'seasonalItemId',
    ])
    .where('workspaceId', '=', ws)
    .where('status', '=', 'posted')
    .where('kind', '=', 'regular')
    .where('date', '>=', from)
    .where('date', '<=', today)
    .orderBy('date')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    cents: Number(r.amountBrlCents),
    direction: r.direction as 'in' | 'out',
    description: r.description,
    norm: normalizeDescription(r.description),
    key: descriptionKey(r.description),
    categoryId: r.categoryId,
    recurrenceId: r.recurrenceId,
    installment: r.installmentGroupId !== null,
    seasonalItemId: r.seasonalItemId,
  }));
}

async function loadRecurrences(tx: Tx, ws: string): Promise<RecRow[]> {
  const rows = await tx
    .selectFrom('recurrences as r')
    .leftJoin('categories as c', 'c.id', 'r.categoryId')
    .select([
      'r.id',
      'r.description',
      'r.amountCents',
      'r.direction',
      'r.categoryId',
      'c.name as categoryName',
      'r.rule',
      'r.amountMode',
      'r.endDate',
    ])
    .where('r.workspaceId', '=', ws)
    .where('r.pausedAt', 'is', null)
    .execute();
  return rows.map((r) => ({
    ...r,
    amountCents: Number(r.amountCents),
    direction: r.direction as 'in' | 'out',
  }));
}

async function loadItems(tx: Tx, ws: string): Promise<ItemRow[]> {
  const rows = await tx
    .selectFrom('seasonalItems as s')
    .leftJoin('categories as c', 'c.id', 's.categoryId')
    .selectAll('s')
    .select('c.name as categoryName')
    .where('s.workspaceId', '=', ws)
    .orderBy('s.createdAt')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    kind: r.kind as SeasonalKind,
    direction: r.direction as 'in' | 'out' | null,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    schedule: r.schedule as unknown as SeasonalScheduleEntry[],
    adjustmentPct: r.adjustmentPct === null ? null : Number(r.adjustmentPct),
    leadDays: r.leadDays,
    confidence: r.confidence as SeasonalConfidence,
    evidence: r.evidence as unknown as SeasonalEvidence[],
    status: r.status as SeasonalStatus,
    source: r.source as 'detected' | 'manual',
    matchPattern: r.matchPattern,
    recurrenceId: r.recurrenceId,
    scheduleYear: r.scheduleYear,
  }));
}

/** Lançamentos que pagam o item (padrão do catálogo, chave do anual genérico ou trecho do item manual). */
function matcher(item: Pick<ItemRow, 'id' | 'key' | 'direction' | 'matchPattern'>): (t: HistTx) => boolean {
  const cat = CATALOG_BY_KEY.get(item.key);
  const dir = item.direction;
  const byRule: (t: HistTx) => boolean = cat
    ? (t) => cat.pattern.test(t.norm)
    : item.key.startsWith('annual:')
      ? (t) => !t.recurrenceId && t.key === item.key.slice('annual:'.length)
      : item.matchPattern
        ? (t) => t.norm.includes(item.matchPattern!)
        : () => false;
  return (t) => t.seasonalItemId === item.id || (t.direction === dir && byRule(t));
}

// ---------------------------------------------------------------------------
// Reajustes de recorrências
// ---------------------------------------------------------------------------

interface Step {
  date: string;
  pct: number;
}

/** Degraus de valor que persistem (não é um pico isolado) numa série mensal. */
function stepsOf(series: HistTx[]): Step[] {
  const out: Step[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.cents;
    const cur = series[i]!.cents;
    if (prev <= 0) continue;
    const r = cur / prev - 1;
    if (r < MIN_STEP || r > MAX_STEP) continue;
    const next = series[i + 1];
    if (next && next.cents < prev * 1.01) continue; // pico isolado, voltou ao valor antigo
    out.push({ date: series[i]!.date, pct: r });
  }
  return out;
}

function recurrenceSeries(rec: RecRow, hist: HistTx[]): HistTx[] {
  const key = descriptionKey(rec.description);
  return hist.filter(
    (t) =>
      t.direction === 'out' &&
      (t.recurrenceId === rec.id || (!t.recurrenceId && !t.installment && t.key === key)),
  );
}

function learnAdjustment(rec: RecRow, hist: HistTx[]): Learned | null {
  // conta de consumo (luz, água) varia todo mês: degrau não é reajuste
  if (rec.direction !== 'out' || rec.amountMode !== 'fixed' || !rec.rule.startsWith('FREQ=MONTHLY'))
    return null;
  const series = recurrenceSeries(rec, hist);
  const stable = series.slice(1).filter((t, i) => Math.abs(t.cents / series[i]!.cents - 1) < 0.01).length;
  if (series.length < 4 || stable < 0.7 * (series.length - 1)) return null;
  const steps = stepsOf(series);
  if (!steps.length) return null;
  const byMonth = new Map<number, Step[]>();
  for (const s of steps) {
    const m = parseISO(s.date).m;
    byMonth.set(m, [...(byMonth.get(m) ?? []), s]);
  }
  // mês que se repete em anos diferentes; senão, um degrau único em recorrência típica de reajuste
  const repeated = [...byMonth.entries()].find(
    ([, ss]) => new Set(ss.map((s) => parseISO(s.date).y)).size >= 2,
  );
  const text = normalizeDescription(`${rec.description} ${rec.categoryName ?? ''}`);
  let chosen: Step[];
  let confidence: SeasonalConfidence;
  if (repeated) {
    chosen = repeated[1];
    confidence = 'alta';
  } else if (steps.length === 1 && ADJUSTABLE_RE.test(text)) {
    chosen = steps;
    confidence = 'media';
  } else return null;
  const last = chosen.at(-1)!;
  const month = parseISO(last.date).m;
  const pct = Math.round(last.pct * 10_000) / 100;
  return {
    key: `reajuste:${rec.id}`,
    label: `Reajuste ${rec.description}`,
    kind: 'adjustment',
    direction: 'out',
    categoryId: rec.categoryId,
    leadDays: 30,
    confidence,
    schedule: [{ month, day: 1, amountCents: Math.round((rec.amountCents * pct) / 100) }],
    scheduleYear: parseISO(last.date).y,
    evidence: chosen.map((s) => ({
      year: parseISO(s.date).y,
      totalCents: Math.round(s.pct * 10_000) / 100,
      months: [parseISO(s.date).m],
      n: 1,
    })),
    txIds: [],
    recurrenceId: rec.id,
    adjustmentPct: pct,
  };
}

// ---------------------------------------------------------------------------
// Detecção
// ---------------------------------------------------------------------------

async function holdsFunds(tx: Tx, ws: string): Promise<boolean> {
  const r = await sql<{ n: number }>`
    select count(*)::int as n from (
      select t.asset_id from trades t join assets a on a.id = t.asset_id
      where t.workspace_id = ${ws}::uuid and a.kind = 'fund'
      group by t.asset_id
      having sum(case when t.kind in ('buy', 'contribution') then t.qty
                      when t.kind in ('sell', 'redemption') then -t.qty else 0 end) > 0
    ) x`.execute(tx);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/** Tudo o que o histórico sugere (sem gravar). */
export async function learnFromHistory(tx: Tx, ws: string, today: string): Promise<Learned[]> {
  const from = `${parseISO(today).y - HISTORY_YEARS}-01-01`;
  const hist = await loadHistory(tx, ws, from, today);
  const recs = await loadRecurrences(tx, ws);
  const out: Learned[] = [];
  const used = new Set<string>();
  const recNorms = recs.map((r) => normalizeDescription(r.description));
  const recKeys = new Set(recs.map((r) => descriptionKey(r.description)));

  // 1) Catálogo
  for (const c of CATALOG) {
    // já coberto por uma recorrência ativa (ex.: "IPTU" em 10x cadastrado como recorrência)
    if (recNorms.some((n) => c.pattern.test(n))) continue;
    const txs = hist.filter((t) => t.direction === c.direction && !t.recurrenceId && c.pattern.test(t.norm));
    const learned = learnSchedule(txs, today, c.maxMonths);
    if (!learned) continue;
    txs.forEach((t) => used.add(t.id));
    out.push({
      key: c.key,
      label: c.label,
      kind: c.kind,
      direction: c.direction,
      categoryId: txs.at(-1)!.categoryId,
      leadDays: c.leadDays,
      ...learned,
      txIds: txs.map((t) => t.id),
    });
  }

  // 2) Anuais genéricos: mesma descrição, mesmo mês (±1), em 2+ anos, até 3 meses por ano
  const groups = new Map<string, HistTx[]>();
  for (const t of hist) {
    if (t.direction !== 'out' || t.recurrenceId || t.installment || used.has(t.id)) continue;
    if (t.cents < MIN_ANNUAL_CENTS || t.key.length < 3 || recKeys.has(t.key)) continue;
    groups.set(t.key, [...(groups.get(t.key) ?? []), t]);
  }
  for (const [key, txs] of groups) {
    // todos os lançamentos com a mesma descrição (mesmo os pequenos) contam para descartar gasto mensal
    const all = hist.filter((t) => t.direction === 'out' && t.key === key);
    const sh = seasonShape(all.map((t) => parseISO(t.date).m));
    const monthsBySeason = new Map<number, Set<number>>();
    for (const t of all) {
      const season = seasonOf(t.date, sh);
      monthsBySeason.set(season, (monthsBySeason.get(season) ?? new Set()).add(parseISO(t.date).m));
    }
    if ([...monthsBySeason.values()].some((ms) => ms.size > 3)) continue;
    // primeiro pagamento de cada temporada no mesmo mês (±1)
    const firsts = new Map<number, number>();
    for (const t of txs) {
      const season = seasonOf(t.date, sh);
      if (!firsts.has(season)) firsts.set(season, seasonOrder(parseISO(t.date).m, sh));
    }
    if (firsts.size < 2) continue;
    if (Math.max(...firsts.values()) - Math.min(...firsts.values()) > 1) continue;
    if (diffDays(today, txs.at(-1)!.date) > 15 * 30) continue; // parou de acontecer
    const learned = learnSchedule(txs, today, 3);
    if (!learned) continue;
    const last = txs.at(-1)!;
    out.push({
      key: `annual:${key}`,
      label: last.description.trim().slice(0, 60),
      kind: 'expense',
      direction: 'out',
      categoryId: last.categoryId,
      leadDays: 30,
      ...learned,
      txIds: txs.map((t) => t.id),
    });
  }

  // 3) Reajustes de recorrências mensais
  for (const r of recs) {
    const adj = learnAdjustment(r, hist);
    if (adj) out.push(adj);
  }

  // 4) 13º estimado pelo salário quando o histórico ainda não tem 13º
  if (!out.some((l) => l.key === 'decimo_terceiro')) {
    const salaries = recs.filter(
      (r) =>
        r.direction === 'in' &&
        r.rule.startsWith('FREQ=MONTHLY') &&
        SALARY_13_RE.test(normalizeDescription(`${r.description} ${r.categoryName ?? ''}`)),
    );
    const base = salaries.reduce((a, r) => a + r.amountCents, 0);
    if (base > 0) {
      const first = Math.round(base / 2);
      out.push({
        key: 'decimo_terceiro',
        label: '13º salário',
        kind: 'income',
        direction: 'in',
        categoryId: salaries[0]!.categoryId,
        leadDays: 30,
        confidence: 'estimado',
        schedule: [
          { month: 11, day: 30, amountCents: first },
          { month: 12, day: 20, amountCents: base - first },
        ],
        scheduleYear: null,
        evidence: [],
        txIds: [],
      });
    }
  }

  // 5) Come-cotas (informativo, sem valor)
  if (await holdsFunds(tx, ws)) {
    out.push({
      key: COME_COTAS.key,
      label: COME_COTAS.label,
      kind: 'info',
      direction: null,
      categoryId: null,
      leadDays: 30,
      confidence: 'alta',
      schedule: COME_COTAS.schedule,
      scheduleYear: null,
      evidence: [],
      txIds: [],
    });
  }
  return out;
}

/**
 * Detecta e grava os itens do calendário. Nunca ressuscita item ignorado; em item confirmado, só
 * troca a agenda quando há pagamentos de uma temporada mais nova que a da agenda atual (a edição do
 * usuário vale até lá). Depois sincroniza a projeção.
 */
export async function detectSeasonal(
  tx: Tx,
  ws: string,
  today: string,
): Promise<{ created: number; updated: number }> {
  const learned = await learnFromHistory(tx, ws, today);
  const existing = new Map((await loadItems(tx, ws)).map((i) => [i.key, i]));
  let created = 0;
  let updated = 0;
  for (const l of learned) {
    const ex = existing.get(l.key);
    let id: string;
    if (!ex) {
      const row = await tx
        .insertInto('seasonalItems')
        .values({
          workspaceId: ws,
          key: l.key,
          label: l.label,
          kind: l.kind,
          direction: l.direction,
          categoryId: l.categoryId,
          recurrenceId: l.recurrenceId ?? null,
          schedule: JSON.stringify(l.schedule),
          scheduleYear: l.scheduleYear,
          adjustmentPct: l.adjustmentPct ?? null,
          leadDays: l.leadDays,
          confidence: l.confidence,
          evidence: JSON.stringify(l.evidence),
          // informativo não tem o que confirmar
          status: l.kind === 'info' ? 'confirmed' : 'suggested',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
      created++;
    } else {
      id = ex.id;
      const relearn =
        ex.status === 'suggested'
          ? l.scheduleYear !== null || ex.confidence === 'estimado'
          : ex.status === 'confirmed' &&
            l.scheduleYear !== null &&
            (ex.scheduleYear === null || l.scheduleYear > ex.scheduleYear);
      const patch: Record<string, unknown> = {};
      if (l.evidence.length && JSON.stringify(l.evidence) !== JSON.stringify(ex.evidence))
        patch.evidence = JSON.stringify(l.evidence);
      if (relearn && ex.status !== 'dismissed') {
        if (JSON.stringify(l.schedule) !== JSON.stringify(ex.schedule))
          patch.schedule = JSON.stringify(l.schedule);
        if (l.scheduleYear !== ex.scheduleYear) patch.scheduleYear = l.scheduleYear;
        if (l.confidence !== ex.confidence) patch.confidence = l.confidence;
        if ((l.adjustmentPct ?? null) !== ex.adjustmentPct) patch.adjustmentPct = l.adjustmentPct ?? null;
      }
      if (Object.keys(patch).length) {
        await tx
          .updateTable('seasonalItems')
          .set({ ...patch, updatedAt: new Date() })
          .where('id', '=', id)
          .execute();
        updated++;
      }
    }
    if (l.txIds.length)
      await tx
        .updateTable('transactions')
        .set({ seasonalItemId: id })
        .where('id', 'in', l.txIds)
        .where('seasonalItemId', 'is', null)
        .execute();
  }
  // come-cotas some quando não há mais fundos
  if (!learned.some((l) => l.key === COME_COTAS.key) && existing.get(COME_COTAS.key)?.source === 'detected')
    await tx.deleteFrom('seasonalItems').where('id', '=', existing.get(COME_COTAS.key)!.id).execute();
  await syncSeasonalPlanned(tx, ws, today);
  return { created, updated };
}

// ---------------------------------------------------------------------------
// Ocorrências, projeção e calendário
// ---------------------------------------------------------------------------

interface Ctx {
  items: ItemRow[];
  hist: HistTx[];
  recs: Map<string, RecRow>;
}

async function loadCtx(tx: Tx, ws: string, today: string): Promise<Ctx> {
  const items = await loadItems(tx, ws);
  // temporada anterior inteira (matrícula começa em outubro do ano anterior)
  const hist = items.length ? await loadHistory(tx, ws, `${parseISO(today).y - 2}-10-01`, today) : [];
  const recs = items.some((i) => i.recurrenceId) ? await loadRecurrences(tx, ws) : [];
  return { items, hist, recs: new Map(recs.map((r) => [r.id, r])) };
}

/** Quanto já foi pago (ou se o reajuste já aconteceu) em cada temporada. */
function paidBySeason(item: ItemRow, ctx: Ctx): Map<number, number> {
  const out = new Map<number, number>();
  if (item.kind === 'info') return out;
  if (item.kind === 'adjustment') {
    const rec = item.recurrenceId ? ctx.recs.get(item.recurrenceId) : undefined;
    const month = item.schedule[0]?.month;
    if (!rec || !month) return out;
    for (const s of stepsOf(recurrenceSeries(rec, ctx.hist))) {
      const { y, m } = parseISO(s.date);
      if (Math.abs(m - month) <= 1) out.set(y, Number.MAX_SAFE_INTEGER);
    }
    return out;
  }
  const sh = shapeOf(item.schedule);
  const match = matcher(item);
  for (const t of ctx.hist)
    if (match(t)) out.set(seasonOf(t.date, sh), (out.get(seasonOf(t.date, sh)) ?? 0) + t.cents);
  return out;
}

/** Ocorrências do item com data em [from, to). */
function occurrencesOf(item: ItemRow, ctx: Ctx, from: string, to: string): SeasonalOccurrenceDTO[] {
  if (item.status === 'dismissed' || !item.schedule.length) return [];
  const sh = shapeOf(item.schedule);
  const paid = paidBySeason(item, ctx);
  const out: SeasonalOccurrenceDTO[] = [];
  const sched = [...item.schedule].sort((a, b) => seasonOrder(a.month, sh) - seasonOrder(b.month, sh));
  const tot = total(sched);
  for (let season = seasonOf(from, sh); season <= seasonOf(to, sh); season++) {
    const paidTotal = paid.get(season) ?? 0;
    let cum = 0;
    sched.forEach((e, i) => {
      cum += e.amountCents;
      const date = dateIn(season, e, sh);
      if (date < from || date >= to) return;
      const isPaid =
        item.kind === 'adjustment'
          ? paidTotal > 0
          : tot > 0 && (paidTotal >= 0.9 * tot || paidTotal >= 0.9 * cum);
      out.push({
        itemId: item.id,
        key: item.key,
        label: item.label,
        kind: item.kind,
        direction: item.direction,
        date,
        season,
        amountCents: e.amountCents,
        status: item.status,
        confidence: item.confidence,
        paid: isPaid,
        inProjection: item.status === 'confirmed' && item.kind !== 'info' && !isPaid,
        installment: sched.length > 1 && item.kind !== 'info' ? { n: i + 1, total: sched.length } : null,
      });
    });
  }
  return out;
}

const byDate = (a: SeasonalOccurrenceDTO, b: SeasonalOccurrenceDTO) =>
  a.date.localeCompare(b.date) || a.label.localeCompare(b.label);

function toDTO(i: ItemRow): SeasonalItemDTO {
  const { matchPattern, recurrenceId, scheduleYear, ...dto } = i;
  void matchPattern;
  void recurrenceId;
  void scheduleYear;
  return dto;
}

export async function seasonalCalendar(tx: Tx, ws: string, today: string, months = 12): Promise<CalendarDTO> {
  const ctx = await loadCtx(tx, ws, today);
  const from = startOfMonth(today);
  const to = addMonths(from, months);
  return {
    items: ctx.items.map(toDTO),
    occurrences: ctx.items.flatMap((i) => occurrencesOf(i, ctx, from, to)).sort(byDate),
  };
}

/** Ocorrências agrupadas por mês (AAAA-MM-01) para anexar à projeção. */
export async function seasonalByMonth(
  tx: Tx,
  ws: string,
  today: string,
  months: number,
): Promise<Map<string, SeasonalOccurrenceDTO[]>> {
  const { occurrences } = await seasonalCalendar(tx, ws, today, months);
  const out = new Map<string, SeasonalOccurrenceDTO[]>();
  for (const o of occurrences) {
    const m = startOfMonth(o.date);
    out.set(m, [...(out.get(m) ?? []), o]);
  }
  return out;
}

/**
 * Reescreve os fluxos planejados 'seasonal' com as ocorrências não pagas dos itens confirmados e
 * liga ao item os pagamentos reais (que saem da média do variável).
 */
export async function syncSeasonalPlanned(tx: Tx, ws: string, today: string): Promise<void> {
  const ctx = await loadCtx(tx, ws, today);
  for (const item of ctx.items) {
    if (item.status === 'dismissed' || item.kind === 'info' || item.kind === 'adjustment') continue;
    const match = matcher(item);
    const ids = ctx.hist.filter((t) => !t.seasonalItemId && match(t)).map((t) => t.id);
    if (ids.length)
      await tx
        .updateTable('transactions')
        .set({ seasonalItemId: item.id })
        .where('id', 'in', ids)
        .where('seasonalItemId', 'is', null)
        .execute();
  }

  await tx
    .deleteFrom('plannedCashflows')
    .where('workspaceId', '=', ws)
    .where('source', '=', 'seasonal')
    .execute();
  const from = startOfMonth(today);
  const to = addMonths(from, PLANNED_MONTHS);
  const rows: Array<{
    date: string;
    amountCents: number;
    direction: 'in' | 'out';
    refId: string;
    description: string;
  }> = [];
  for (const item of ctx.items) {
    if (item.status !== 'confirmed' || item.kind === 'info' || !item.direction) continue;
    const occs = occurrencesOf(item, ctx, from, to).filter((o) => !o.paid);
    if (item.kind === 'adjustment') {
      rows.push(...adjustmentRows(item, ctx, occs, from, to));
      continue;
    }
    for (const o of occs)
      if (o.amountCents > 0)
        rows.push({
          date: o.date,
          amountCents: o.amountCents,
          direction: item.direction,
          refId: item.id,
          description: o.installment
            ? `${item.label} (${o.installment.n}/${o.installment.total})`
            : item.label,
        });
  }
  if (rows.length)
    await tx
      .insertInto('plannedCashflows')
      .values(rows.map((r) => ({ ...r, workspaceId: ws, source: 'seasonal' })))
      .execute();
}

/** Reajuste vira o acréscimo mensal sobre a recorrência a partir do mês do reajuste (composto a cada ano). */
function adjustmentRows(item: ItemRow, ctx: Ctx, occs: SeasonalOccurrenceDTO[], from: string, to: string) {
  const rec = item.recurrenceId ? ctx.recs.get(item.recurrenceId) : undefined;
  const pct = (item.adjustmentPct ?? 0) / 100;
  if (!rec || pct <= 0 || !occs.length) return [];
  const rows = [];
  for (let m = from; m < to; m = addMonths(m, 1)) {
    if (rec.endDate && m > rec.endDate) break;
    const n = occs.filter((o) => startOfMonth(o.date) <= m).length;
    if (!n) continue;
    rows.push({
      date: m,
      amountCents: Math.round(rec.amountCents * ((1 + pct) ** n - 1)),
      direction: 'out' as const,
      refId: item.id,
      description: item.label,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Textos (agente e lembretes)
// ---------------------------------------------------------------------------

/** "cota única em 15/jan" ou "3 parcelas (jan, fev, mar)". */
export function describeSchedule(schedule: SeasonalScheduleEntry[]): string {
  if (schedule.length === 1) {
    const e = schedule[0]!;
    return `em cota única (${String(e.day).padStart(2, '0')}/${MONTHS_SHORT[e.month - 1]})`;
  }
  return `em ${schedule.length} parcelas (${schedule.map((e) => MONTHS_SHORT[e.month - 1]).join(', ')})`;
}

/** Frase da evidência: "2024: R$ 2.100,00 · 2025: R$ 2.340,00". */
export function describeEvidence(item: Pick<SeasonalItemDTO, 'kind' | 'evidence'>): string {
  return item.evidence
    .map((e) =>
      item.kind === 'adjustment'
        ? `${MONTHS_SHORT[e.months[0]! - 1]}/${e.year}: +${e.totalCents.toFixed(1).replace('.', ',')}%`
        : `${e.year}: ${formatBRL(e.totalCents)}`,
    )
    .join(' · ');
}

export function occurrenceSentence(o: SeasonalOccurrenceDTO): string {
  const amount =
    o.kind === 'info'
      ? ''
      : o.kind === 'adjustment'
        ? ` +${formatBRL(o.amountCents)}/mês`
        : ` ${formatBRL(o.amountCents)}`;
  const part = o.installment ? ` (${o.installment.n}/${o.installment.total})` : '';
  const state = o.paid
    ? 'pago'
    : o.kind === 'info'
      ? 'informativo'
      : o.status === 'confirmed'
        ? 'na projeção'
        : o.confidence === 'estimado'
          ? 'estimado, a confirmar'
          : 'sugerido, a confirmar';
  return `${formatDateBR(o.date)}: ${o.label}${part}${amount} (${state})`;
}

/** Item pelo nome que o usuário falou ("ipva", "seguro do carro", "13"). */
export function findSeasonalItem<T extends Pick<SeasonalItemDTO, 'key' | 'label' | 'status'>>(
  items: T[],
  query: string,
): T | null {
  const q = normalizeDescription(query);
  if (!q) return null;
  const alive = items.filter((i) => i.status !== 'dismissed');
  const pool = alive.length ? [...alive, ...items.filter((i) => i.status === 'dismissed')] : items;
  return (
    pool.find((i) => i.key === q.replace(/ /g, '_')) ??
    pool.find((i) => CATALOG_BY_KEY.get(i.key)?.pattern.test(q)) ??
    pool.find((i) => normalizeDescription(i.label) === q) ??
    pool.find(
      (i) => normalizeDescription(i.label).includes(q) || q.includes(normalizeDescription(i.label)),
    ) ??
    pool.find((i) => fold(i.key).includes(q.replace(/ /g, '_'))) ??
    null
  );
}

/**
 * Temporada-base de uma agenda editada pelo usuário: a anterior à da próxima ocorrência. Assim a
 * edição vale até aparecerem os pagamentos reais da temporada editada.
 */
export function editedScheduleYear(schedule: SeasonalScheduleEntry[], today: string): number {
  const sh = shapeOf(schedule);
  const s = seasonOf(today, sh);
  const from = startOfMonth(today);
  const upcoming = schedule.some((e) => dateIn(s, e, sh) >= from);
  return (upcoming ? s : s + 1) - 1;
}
