import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // In dev the client connects same-origin (:5173); proxy the WebSocket
    // upgrade through to the game server so we don't hardcode its port.
    proxy: {
      "/ws": { target: "http://localhost:8787", ws: true, changeOrigin: true },
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  // Let Vite's resolver process the shared package's TS source directly
  // (it maps the `.js` import specifiers to their `.ts` siblings) instead of
  // esbuild pre-bundling it, which would not.
  optimizeDeps: { exclude: ["@highlander/shared"] },
});
