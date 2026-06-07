/**
 * Native-module preflight — MUST be imported FIRST in server.ts.
 *
 * The dashboard server is ESM, so a static `import` of any module that
 * transitively pulls in better-sqlite3 (drizzle-orm/better-sqlite3, or
 * @wisp/memory-mcp's store) loads the native `.node` binary during module-graph
 * evaluation — BEFORE any importing module's body runs. On an ABI mismatch (the
 * binary was built for a different Node version, e.g. installed by the Claude
 * Code CLI's bundled Node but launched under the system Node) that load throws a
 * cryptic NODE_MODULE_VERSION error and the server dies with no guidance.
 *
 * Loading it here first, behind a try/catch, turns that into a clear, actionable
 * message. A successful load caches the binding so the downstream static imports
 * reuse it. The /wisp-dashboard launcher auto-rebuilds the binding before spawn;
 * this is the safety net for a direct `node dist/server.js`.
 */
import { createRequire } from 'node:module';

try {
  createRequire(import.meta.url)('better-sqlite3');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/NODE_MODULE_VERSION|different Node\.js version|was compiled against|\.node\b/i.test(msg)) {
    console.error(
      `\n[wisp] better-sqlite3 (the SQLite native module) failed to load — it was built for a ` +
        `different Node.js version than the one running this server (Node ${process.version}).\n` +
        `[wisp] Rebuild it for this Node, then restart:\n` +
        `[wisp]   pnpm rebuild better-sqlite3      # run in the plugin / repo root\n` +
        `[wisp] Or just re-run /wisp-dashboard — its launcher auto-rebuilds the binding.\n` +
        `[wisp] Original error: ${msg}\n`,
    );
    process.exit(1);
  }
  throw err;
}
