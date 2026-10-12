import pg from 'pg';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';

/**
 * Mantém uma conexão dedicada com LISTEN data_changed e repassa eventos por workspace.
 * Os triggers do banco fazem pg_notify em toda escrita relevante.
 */
export class DataChangeNotifier extends EventEmitter {
  private client: pg.Client | null = null;
  private stopped = false;

  constructor(
    private connectionString: string,
    private log: Logger,
  ) {
    super();
    this.setMaxListeners(0);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const client = new pg.Client({
        connectionString: this.connectionString,
        application_name: 'sf-notifier',
      });
      await client.connect();
      client.on('notification', (n) => {
        if (!n.payload) return;
        try {
          const p = JSON.parse(n.payload) as { ws: string; table: string };
          this.emit(`ws:${p.ws}`, p.table);
          this.emit('change', p.ws, p.table);
        } catch {
          /* ignora payload inválido */
        }
      });
      client.on('error', (err) => {
        this.log.warn({ err }, 'conexão LISTEN caiu; reconectando');
        this.client = null;
        if (!this.stopped) setTimeout(() => void this.connect(), 2000);
      });
      await client.query('LISTEN data_changed');
      this.client = client;
    } catch (err) {
      this.log.warn({ err }, 'falha ao iniciar LISTEN; nova tentativa em 5s');
      if (!this.stopped) setTimeout(() => void this.connect(), 5000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.end().catch(() => {});
  }
}
