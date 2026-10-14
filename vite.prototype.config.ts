// Builds the renderer UI with fake data into ONE self-contained HTML file (prototype/dist/index.html)
// that opens straight from disk — no server, no network. Scripts are inlined only for this prototype;
// the real Electron app keeps them in separate files under a strict Content Security Policy.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, "src/renderer"),
  base: "./",
  plugins: [react(), viteSingleFile()],
  resolve: { alias: { "@shared": resolve(root, "src/shared") } },
  build: {
    outDir: resolve(root, "prototype/dist"),
    emptyOutDir: true,
    reportCompressedSize: false,
  },
});
