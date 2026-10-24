import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import {
  defineConfig,
  transformWithEsbuild,
  type Plugin,
  type Rollup,
} from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Replace the HOST env var with SHOPIFY_APP_URL for Shopify CLI compatibility
// Type assertion needed: wrangler types generates literal types for vars,
// but at runtime we may override them
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  (process.env as Record<string, string>).SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

/**
 * Worker bundle size: whitespace/comment-only minification of the SSR (Worker)
 * output. Vite does not minify SSR builds by default, and Wrangler's gzip
 * total for the Worker has a 400 KiB CI budget.
 *
 * Deliberately conservative: only `minifyWhitespace` is enabled. Identifiers
 * are NOT renamed (Function/class `.name` stays intact) and syntax is NOT
 * rewritten, so runtime behaviour is unchanged. Source maps are chained
 * through renderChunk, so Sentry/Workers stack traces still resolve to source.
 * Scoped to the `ssr` environment only; the client build is untouched.
 */
function minifyWorkerWhitespace(): Plugin {
  return {
    name: "ntr:minify-worker-whitespace",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "ssr",
    // order: "post" so this runs after Vite's own `vite:esbuild-transpile`
    // renderChunk (which re-prints SSR chunks for the es2024 target and would
    // otherwise undo the whitespace removal).
    renderChunk: {
      order: "post",
      async handler(code, chunk) {
        const result = await transformWithEsbuild(code, chunk.fileName, {
          loader: "js",
          format: "esm",
          // Keep non-ASCII as-is (esbuild's default escapes it to \uXXXX, which
          // inflates the output). Matches what Vite's own minifier uses.
          charset: "utf8",
          minifyWhitespace: true,
          minifyIdentifiers: false,
          minifySyntax: false,
          keepNames: false,
          treeShaking: false,
          sourcemap: true,
        });
        // esbuild types sourcesContent as (string | null)[]; Rollup accepts it.
        return {
          code: result.code,
          map: result.map as Rollup.SourceMapInput,
        };
      },
    },
  };
}

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT!) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    reactRouter(),
    tsconfigPaths(),
    minifyWorkerWhitespace(),
  ],
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
});
