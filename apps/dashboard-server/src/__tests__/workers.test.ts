import { describe, expect, it } from 'vitest';
import { WorkerRegistry } from '../workers/registry.js';

describe('WorkerRegistry', () => {
  it('registers handlers and runs them on demand', async () => {
    const reg = new WorkerRegistry();
    let counter = 0;
    reg.register({
      name: 'inc',
      cronSpec: '* * * * *',
      enabled: true,
      handler: async () => {
        counter++;
        return { counter };
      },
    });
    const run = await reg.runNow('inc');
    expect(run.status).toBe('ok');
    expect(counter).toBe(1);
    expect((run.result as { counter: number }).counter).toBe(1);
  });

  it('records failed status when handler throws', async () => {
    const reg = new WorkerRegistry();
    reg.register({
      name: 'boom',
      cronSpec: '* * * * *',
      enabled: true,
      handler: async () => {
        throw new Error('oops');
      },
    });
    const run = await reg.runNow('boom');
    expect(run.status).toBe('failed');
    expect(run.errorReason).toContain('oops');
  });
});
