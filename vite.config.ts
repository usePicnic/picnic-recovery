import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // Open tabs can still request content-hashed chunks from earlier releases.
  // Deployments must preserve these assets as well (see README).
  build: { sourcemap: true, emptyOutDir: false },
  server: { host: "127.0.0.1" },
});
