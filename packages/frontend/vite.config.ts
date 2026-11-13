import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Plugins live outside this package (packages/inkvoice-plugins, a git
 * submodule). Vite notices edits there but can keep serving stale copies of
 * the files that import them, so the page shows old code or raw translation
 * keys until a restart. Any change there clears the cache and reloads.
 */
function reloadOnPluginChange(): Plugin {
  const dir = path.resolve(__dirname, "../inkvoice-plugins");
  return {
    name: "inkvoice-plugins-reload",
    apply: "serve",
    configureServer(server) {
      server.watcher.add(dir);
      const reload = (file: string) => {
        if (!file.startsWith(dir)) return;
        server.moduleGraph.invalidateAll();
        server.ws.send({ type: "full-reload" });
      };
      for (const event of ["change", "add", "unlink"] as const) server.watcher.on(event, reload);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), reloadOnPluginChange()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            "codemirror",
            "@codemirror/lang-html",
            "@codemirror/lang-css",
            "@codemirror/theme-one-dark",
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
