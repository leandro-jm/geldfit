import cron from 'node-cron';
import { todayISO } from '@sf/shared';
import { DataChangeNotifier } from '@sf/api/realtime/notifier';
import { createWorkerContext } from './context.js';
import { insightsDaily } from './jobs/insights.js';
import { dailyMaintenance } from './jobs/maintenance.js';
import { marketDaily } from './jobs/market.js';
import { createDebouncedRefresher, refreshAll } from './jobs/projection.js';
import { purgeDeleted } from './jobs/purge.js';
import { dispatchReminders, scheduleReminders } from './jobs/reminders.js';

const ctx = createWorkerContext();
const log = ctx.app.log;
const TZ = { timezone: 'America/Sao_Paulo' };

function job(name: string, fn: () => Promise<unknown>) {
  let running = false;
  return async () => {
    if (running) return; // evita sobreposição
    running = true;
    const t0 = Date.now();
    try {
      await fn();
      log.debug({ job: name, ms: Date.now() - t0 }, 'job ok');
    } catch (err) {
      log.error({ err, job: name }, 'job falhou');
    } finally {
      running = false;
    }
  };
}

const maintenance = job('maintenance', async () => {
  await dailyMaintenance(ctx);
  await refreshAll(ctx);
});
const schedule = job('schedule-reminders', () => scheduleReminders(ctx));
const dispatch = job('dispatch-reminders', () => dispatchReminders(ctx));
const market = job('market', () => marketDaily(ctx, todayISO()));
const insights = job('insights', () => insightsDaily(ctx));
const purge = job('purge', () => purgeDeleted(ctx));

cron.schedule('* * * * *', dispatch, TZ);
cron.schedule('5 * * * *', schedule, TZ);
cron.schedule('0 5 * * *', maintenance, TZ);
cron.schedule('30 6 * * *', insights, TZ);
cron.schedule('30 19 * * 1-5', market, TZ);
cron.schedule('0 3 * * *', purge, TZ);

// Recálculo da projeção a cada commit relevante (trigger → NOTIFY → debounce)
const notifier = new DataChangeNotifier(ctx.app.config.DATABASE_URL, log);
const refresh = createDebouncedRefresher(ctx);
notifier.on('change', (ws: string, table: string) => {
  if (table !== 'drafts' && table !== 'insights') refresh(ws);
});
await notifier.start();

// Na subida: garante horizonte das recorrências, snapshots, agenda e dados de mercado
await maintenance();
await schedule();
if (process.env.WORKER_SKIP_MARKET !== '1') void market().then(insights);
log.info('worker iniciado');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log.info(`${sig} recebido, encerrando worker`);
    await notifier.stop();
    await ctx.close();
    process.exit(0);
  });
}
