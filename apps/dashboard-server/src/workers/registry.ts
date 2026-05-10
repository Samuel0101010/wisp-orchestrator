import { randomUUID } from 'node:crypto';

export type WorkerHandler = () => Promise<unknown>;

export interface WorkerDef {
  name: string;
  cronSpec: string;        // 5-field cron, e.g. '*/15 * * * *'
  enabled: boolean;
  handler: WorkerHandler;
}

export interface WorkerRunRecord {
  id: string;
  workerName: string;
  startedAt: Date;
  endedAt: Date | null;
  status: 'running' | 'ok' | 'failed';
  result: unknown;
  errorReason: string | null;
}

export class WorkerRegistry {
  private workers = new Map<string, WorkerDef>();

  register(def: WorkerDef): void { this.workers.set(def.name, def); }
  list(): WorkerDef[] { return [...this.workers.values()]; }
  get(name: string): WorkerDef | undefined { return this.workers.get(name); }

  async runNow(name: string): Promise<WorkerRunRecord> {
    const w = this.workers.get(name);
    if (!w) throw new Error(`unknown worker ${name}`);
    const id = randomUUID();
    const startedAt = new Date();
    try {
      const result = await w.handler();
      return {
        id, workerName: name, startedAt,
        endedAt: new Date(), status: 'ok', result, errorReason: null,
      };
    } catch (err) {
      return {
        id, workerName: name, startedAt,
        endedAt: new Date(), status: 'failed', result: null,
        errorReason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
