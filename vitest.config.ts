import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test runs with a home of its own, so none can reach the real host's folder.
    setupFiles: ['tests/setup.ts'],
    // Worktrees made for parallel work hold copies of these tests; they run in their own.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
