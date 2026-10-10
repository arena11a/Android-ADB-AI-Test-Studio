import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "dist-electron/main", lib: { entry: path.join(here, "src/main/index.ts") } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "dist-electron/preload", lib: { entry: path.join(here, "src/preload/index.ts") } },
  },
  renderer: {
    root: here,
    plugins: [react(), tailwindcss()],
    build: { outDir: "dist-renderer", rollupOptions: { input: path.join(here, "index.html") } },
    resolve: {
      alias: { "@renderer": path.join(here, "src/renderer"), "@shared": path.join(here, "src/shared") },
    },
    // the renderer imports shared types straight from core/src
    server: { fs: { allow: [here, path.resolve(here, "..")] } },
  },
});
