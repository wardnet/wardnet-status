/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Local development runs fully offline: MSW intercepts /api/* in the browser
// (src/mocks). Against a real local worker, disable MSW (VITE_ENABLE_MSW=false)
// and let the proxy below forward /api to `wrangler dev`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // The @wardnet/* packages carry their own React peer; force a single copy.
    dedupe: ["react", "react-dom"],
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: false,
  },
});
