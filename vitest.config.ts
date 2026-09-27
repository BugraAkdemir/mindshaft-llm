import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Tool timeouts and the reactive safety layer use real timers; running
    // suites in separate forks keeps a stray interval in one file from
    // affecting another.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
    },
  },
});
