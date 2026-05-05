import type { Config } from 'drizzle-kit';

export default {
  schema: '../../packages/schemas/src/db.ts',
  dialect: 'sqlite',
  out: './drizzle',
  dbCredentials: {
    url: './data/harness.db',
  },
} satisfies Config;
