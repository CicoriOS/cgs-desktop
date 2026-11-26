import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// One source, two products (ADR 0032): `vite build` -> web dist; the desktop shell loads the same bundle
// and adds native presentation on top (decided by the client profile at runtime, not by a fork of the code).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:18787", "/ws": { target: "ws://127.0.0.1:18787", ws: true } } },
  test: { environment: "node", include: ["test/**/*.test.ts", "src/**/*.test.ts"] },
});
