import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}", "**/__tests__/**/*.test.ts"],
    exclude: [
      "node_modules",
      "build",
      ".react-router",
      // Post-build tests require dist/ to exist - run with `npm run test:build`
      "**/build-no-xlsx.test.ts",
    ],
  },
});

