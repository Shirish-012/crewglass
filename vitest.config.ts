import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@shared": resolve(root, "src/shared") } },
  test: { include: ["test/**/*.test.ts"], environment: "node", pool: "forks" },
});
