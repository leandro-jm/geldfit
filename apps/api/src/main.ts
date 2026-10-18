import { createAppContext } from './bootstrap.js';
import { loadAiSettings, watchAiSettings } from './lib/ai-settings.js';
import { buildServer } from './server.js';

const { app, handle } = createAppContext({ name: 'api' });
await loadAiSettings(app);
watchAiSettings(app);
const { server, notifier } = await buildServer(app, handle.pool);
await notifier.start();
await server.listen({ port: app.config.API_PORT, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} recebido, encerrando`);
    await server.close();
    await notifier.stop();
    await handle.close();
    process.exit(0);
  });
}
