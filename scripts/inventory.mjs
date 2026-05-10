import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function countRoutes() {
  const dir = resolve(ROOT, 'apps/dashboard-server/src/routes');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => f.replace('.ts', ''));
}

function countSkills() {
  const dir = resolve(ROOT, 'apps/dashboard-server/src/skills/seed');
  try {
    return readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory());
  } catch {
    return [];
  }
}

function countSeedAgents() {
  const file = resolve(ROOT, 'apps/dashboard-server/src/db/agents-seed.ts');
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/seedKey:\s*'([^']+)'/g)].map((m) => m[1]);
}

function countMigrations() {
  const dir = resolve(ROOT, 'apps/dashboard-server/drizzle');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function countDirectives() {
  const file = resolve(ROOT, 'packages/schemas/src/agents.ts');
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/kind:\s*z\.literal\('([^']+)'\)/g)].map((m) => m[1]);
}

const out = {
  generatedAt: new Date().toISOString(),
  routes: countRoutes(),
  agents: countSeedAgents(),
  skills: countSkills(),
  directives: countDirectives(),
  migrations: countMigrations(),
};

const outPath = process.env.HARNESS_INVENTORY_OUT
  ? resolve(process.env.HARNESS_INVENTORY_OUT)
  : resolve(ROOT, 'docs/INVENTORY.json');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`wrote ${outPath}`);
console.log(
  `  routes:${out.routes.length} agents:${out.agents.length} skills:${out.skills.length} directives:${out.directives.length} migrations:${out.migrations.length}`,
);
