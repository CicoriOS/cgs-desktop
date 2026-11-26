import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// One source, two products (ADR 0032): `vite build` -> web dist; `vite build --mode connect` -> remote `/connect` SPA.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The connect wire library is shared with the cgscli daemon: one source, in the sibling checkout (ADR 0036).
  resolve: { alias: { "@cgs/wire": path.resolve(__dirname, "../cgscli/packages/connect/src/remote/wire/index.ts") } },
  base: mode === "connect" ? "/connect/" : "/",
  root: ".",
  build: mode === "connect" ? { outDir: "dist-connect", emptyOutDir: true, rollupOptions: { input: "index-connect.html" } } : undefined,
  server: { proxy: { "/api": "http://127.0.0.1:18787", "/ws": { target: "ws://127.0.0.1:18787", ws: true }, "/relay": { target: "ws://127.0.0.1:18787", ws: true } } },
  test: { environment: "node", include: ["test/**/*.test.ts", "src/**/*.test.ts"] },
}));
