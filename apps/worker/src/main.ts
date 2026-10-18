import cron from 'node-cron';
import { todayISO } from '@sf/shared';
import { DataChangeNotifier } from '@sf/api/realtime/notifier';
import { loadAiSettings, watchAiSettings } from '@sf/api/lib/ai-settings';
import { createWorkerContext } from './context.js';
import { insightsDaily } from './jobs/insights.js';
import { dailyMaintenance } from './jobs/maintenance.js';
import { marketDaily } from './jobs/market.js';
import { memoryExtraction } from './jobs/memory.js';
import { nudgesDaily } from './jobs/nudges.js';
import { createDebouncedRefresher, refreshAll } from './jobs/projection.js';
import { purgeDeleted } from './jobs/purge.js';
import { dispatchReminders, scheduleReminders } from './jobs/reminders.js';
import { createDebouncedSeasonalSync, seasonalDaily } from './jobs/seasonal.js';

const ctx = createWorkerContext();
const log = ctx.app.log;
// chaves e modelos de IA salvos pela tela de Configurações (sobrepõem o .env; recarrega sozinho)
await loadAiSettings(ctx.app);
watchAiSettings(ctx.app);
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
const seasonal = job('seasonal', () => seasonalDaily(ctx));
const memory = job('memory', () => memoryExtraction(ctx));
const nudges = job('nudges', () => nudgesDaily(ctx));

cron.schedule('* * * * *', dispatch, TZ);
cron.schedule('5 * * * *', schedule, TZ);
cron.schedule('0 5 * * *', maintenance, TZ);
cron.schedule('10 5 * * *', seasonal, TZ);
cron.schedule('30 6 * * *', insights, TZ);
cron.schedule('30 19 * * 1-5', market, TZ);
cron.schedule('0 3 * * *', purge, TZ);
cron.schedule('*/5 * * * *', memory, TZ);
cron.schedule('0 7 * * *', nudges, TZ);

// Recálculo da projeção a cada commit relevante (trigger → NOTIFY → debounce)
const NO_PROJECTION = new Set(['drafts', 'insights', 'agent_memories', 'agent_nudges']);
const notifier = new DataChangeNotifier(ctx.app.config.DATABASE_URL, log);
const refresh = createDebouncedRefresher(ctx);
const seasonalSync = createDebouncedSeasonalSync(ctx);
notifier.on('change', (ws: string, table: string) => {
  // tabelas que não mexem na projeção (só atualizam a tela em tempo real)
  if (!NO_PROJECTION.has(table)) refresh(ws);
  if (table === 'transactions') seasonalSync(ws);
});
await notifier.start();

// Na subida: garante horizonte das recorrências, snapshots, agenda e dados de mercado
await maintenance();
await seasonal();
await schedule();
await nudges();
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
