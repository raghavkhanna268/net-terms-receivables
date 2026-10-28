import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  buildDirectory: "dist",
  future: {
    v8_viteEnvironmentApi: true,
  },
  routeDiscovery: { mode: "initial" },
} satisfies Config;
