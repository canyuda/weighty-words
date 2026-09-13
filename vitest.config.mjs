import { defineConfig } from 'vitest/config';

// Unit tests only; Electron smoke lives in tests/e2e (run via tests/e2e/smoke.js)
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node'
  }
});
