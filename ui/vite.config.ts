import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  const target = process.env.VITE_TARGET ?? "web";
  return {
    plugins: [react()],
    resolve: {
      alias: {
        // the other adapter is never bundled
        "@platform": path.resolve(root, { desktop: "src/platform/wails.ts", mobile: "src/platform/mobile/index.ts" }[target] ?? "src/platform/http.ts"),
        "@": path.resolve(root, "src"),
      },
    },
    build: {
      outDir: { desktop: "../desktop/frontend/dist", mobile: "../mobile/www" }[target] ?? "../server/internal/webui/dist",
      emptyOutDir: true,
    },
    server: { proxy: { "/v1": "http://127.0.0.1:8080" } }, // web dev → local Go server
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
