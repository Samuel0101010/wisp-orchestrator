import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 15000,
    hookTimeout: 15000,
    isolate: true,
  },
});
