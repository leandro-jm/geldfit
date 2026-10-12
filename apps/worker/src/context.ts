import { createDb, type Db } from '@sf/db';
import { createAppContext } from '@sf/api/bootstrap';
import type { AppContext } from '@sf/api/context';

export interface WorkerContext {
  app: AppContext; // pool app_user (RLS por usuário)
  sys: Db; // pool app_worker (BYPASSRLS) só para varreduras entre tenants e manutenção
  close(): Promise<void>;
}

export function createWorkerContext(): WorkerContext {
  const { app, handle } = createAppContext({ name: 'worker' });
  const url = process.env.WORKER_DATABASE_URL;
  if (!url) throw new Error('WORKER_DATABASE_URL não definido');
  const sysHandle = createDb(url, { max: 4, applicationName: 'sf-worker-sys' });
  return {
    app,
    sys: sysHandle.db,
    async close() {
      await handle.close();
      await sysHandle.close();
    },
  };
}
