import { defineConfig } from "vitest/config";
import path from "node:path";

const dir = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dir, "./src"),
      // "server-only" is a Next build guard with no meaning under Vitest.
      "server-only": path.resolve(dir, "./tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Points every worker at a throwaway database before anything imports
    // src/db/client.ts, which resolves its path once at module load.
    setupFiles: ["./tests/setup.ts"],
    globals: true,
  },
});
