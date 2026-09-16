import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

/**
 * Build config for the Node host (`dist-host/main.js`).
 *
 * Separate from the SPA build, and an SSR build rather than `tsc`, so the host's
 * imports resolve with the same rules as the rest of the project — a `tsc`-emitted
 * NodeNext build would require `.js` extensions on every relative import, which the
 * browser code shares and does not use.
 *
 * `external: true` keeps `mindoodb-app-sdk` and Node builtins as real imports rather
 * than inlining a copy of the SDK into the host bundle.
 */
export default defineConfig({
  // `public/` belongs to the SPA build. Copying it here as well would put a second
  // haven-app.json next to the host bundle, where it means nothing and only invites
  // the two copies to drift.
  publicDir: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    ssr: "src/host/main.ts",
    outDir: "dist-host",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("@/"),
      output: { entryFileNames: "main.js" },
    },
  },
});
