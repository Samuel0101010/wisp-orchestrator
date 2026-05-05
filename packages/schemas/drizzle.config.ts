// drizzle-kit config. drizzle-kit itself is a devDependency of the consuming
// server (apps/dashboard-server) — this file just declares the schema location
// so the kit can be invoked as `drizzle-kit generate --config ../packages/schemas/drizzle.config.ts`.

const config = {
  schema: './src/db.ts',
  dialect: 'sqlite' as const,
  out: './drizzle',
};

export default config;
