import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { authProbeStatus } from '../auth-status.js';

// Read the dashboard-server's package.json once at module load and export the
// version string. Avoids the bug where every release bump leaves a stale
// hardcoded "1.0.0" in this file (caught after v1.1.0 ship).
//
// Path resolution: src/routes/health.ts and dist/routes/health.js both sit two
// levels deep below the package root, so `../../package.json` works for both
// tsx-watch dev mode and the compiled production bundle.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
export const SERVER_VERSION = pkg.version;

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/health', async () => ({
    ok: true,
    time: new Date().toISOString(),
    version: SERVER_VERSION,
    authProbe: authProbeStatus(),
  }));
};
