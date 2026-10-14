// Builds the Electron app: main process, preload bridge and the UI (the same UI as the prototype).
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const alias = { "@shared": resolve(root, "src/shared") };

// Content Security Policy for the app's page. Built app: scripts only from the app itself, and no network of
// any kind. Dev server: also its own local scripts and hot-reload socket.
const PROD_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'";
const DEV_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; base-uri 'none'; object-src 'none'";

function csp(): Plugin {
  let dev = false;
  return {
    name: "crewglass-csp",
    configResolved(c) { dev = c.command === "serve"; },
    transformIndexHtml: (html) => html
      .replace(/content="default-src[^"]*"/, `content="${dev ? DEV_CSP : PROD_CSP}"`)
      .replace("<title>Crewglass — prototype</title>", "<title>Crewglass</title>"),
  };
}

export default defineConfig({
  main: {
    resolve: { alias },
    // Where this repo is, for the "Unknown fields" box. Left empty in builds meant for sharing (npm run dmg), so the
    // app you hand out doesn't carry your folder path; anyone can still set it in Settings.
    define: { __SOURCE_REPO__: JSON.stringify(process.env.CREWGLASS_SHARE === "1" ? "" : root) },
    // Everything the main process needs (e.g. yaml) is bundled in, so the packaged app ships no node_modules.
    build: { outDir: "out/main", externalizeDeps: false, rollupOptions: { input: { index: resolve(root, "src/main/index.ts") } } },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: "out/preload",
      externalizeDeps: false,
      rollupOptions: { input: { index: resolve(root, "src/preload/index.ts") }, output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    resolve: { alias },
    plugins: [react(), csp()],
    build: { outDir: resolve(root, "out/renderer"), rollupOptions: { input: resolve(root, "src/renderer/index.html") } },
  },
});
