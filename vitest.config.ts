import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: false,
    maxWorkers: 2,
    // Migrations are loaded through fs, outside Vite's import graph.
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/packages/storage/migrations/*.sql', '**/apps/api/migrations/*.sql', '**/apps/api/src/runtime-worker.ts', '**/apps/api/src/history-service.ts', '**/apps/api/src/alarm-service.ts', '**/apps/api/src/notification-worker.ts', '**/apps/api/src/notification-service.ts', '**/apps/api/src/aggregate-worker.ts', '**/apps/api/src/aggregate-service.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
          testTimeout: 2_000,
          retry: 0,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000,
          retry: 0,
          fileParallelism: false,
        },
      },
    ],
  },
});
