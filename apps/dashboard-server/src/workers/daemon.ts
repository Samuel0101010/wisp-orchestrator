import cron from 'node-cron';
import { db } from '../db/index.js';
import { workerRuns } from '@agent-harness/schemas';
import type { WorkerRegistry } from './registry.js';

export class WorkerDaemon {
  private tasks: cron.ScheduledTask[] = [];
  constructor(private registry: WorkerRegistry) {}

  start(): void {
    for (const w of this.registry.list()) {
      if (!w.enabled) continue;
      const task = cron.schedule(w.cronSpec, async () => {
        const run = await this.registry.runNow(w.name);
        try {
          await db.insert(workerRuns).values({
            id: run.id,
            workerName: run.workerName,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            status: run.status,
            resultJson: run.result,
            errorReason: run.errorReason,
          }).run();
        } catch (err) {
          // Never throw out of the cron task — it would be silently swallowed
          // by node-cron and we'd lose visibility. Log to console instead.
          console.error('[worker-daemon] failed to persist run', w.name, err);
        }
      });
      this.tasks.push(task);
    }
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
  }
}
