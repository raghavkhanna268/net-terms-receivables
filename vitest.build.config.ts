/**
 * Vitest config for build output tests.
 * 
 * These tests require dist/ to exist (run after `npm run build`).
 * Run with: npm run test:build
 */
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/routes/__tests__/build-no-xlsx.test.ts"],
  },
});
