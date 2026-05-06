import type { FastifyPluginAsync } from 'fastify';
import { authProbeStatus } from '../auth-status.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/health', async () => ({
    ok: true,
    time: new Date().toISOString(),
    version: '1.0.0',
    authProbe: authProbeStatus(),
  }));
};
