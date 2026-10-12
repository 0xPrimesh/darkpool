import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// @arcium-hq/client imports node "crypto" and "fs" at module level. The
// crypto functions it uses (randomBytes, createHash) are polyfilled; fs is
// only used by uploadCircuit, which the browser never calls, so it is stubbed.
const shim = (f: string) => fileURLToPath(new URL(`./src/shims/${f}`, import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ["crypto", "buffer", "stream", "util"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  resolve: {
    alias: [
      { find: "fs", replacement: shim("fs.ts") },
      // Only the bare specifier; the shim itself imports the real dist path.
      { find: /^@anchor-lang\/core$/, replacement: shim("anchor.ts") },
    ],
  },
  server: { port: 5173 },
});
