import { defineConfig } from "vite";
import { connectKitPresentation } from "./tooling/connectkitPresentation";

export default defineConfig({
  base: "./",
  plugins: [connectKitPresentation()],
  // Apply the same wallet labels/order in development and production.
  optimizeDeps: { exclude: ["connectkit"] },
  // Open tabs can still request content-hashed chunks from earlier releases.
  // Deployments must preserve these assets as well (see README).
  build: { sourcemap: true, emptyOutDir: false },
  server: { host: "127.0.0.1" },
});
