import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { havenBundle } from "mindoodb-app-sdk/vite";
import wasm from "vite-plugin-wasm";
import { defineConfig } from "vitest/config";

import { BUILDER_DEFAULT_PORT, BUILDER_DEV_PORT } from "./src/core/ports.ts";

function createResolveAliases(): Record<string, string> {
  const aliases: Record<string, string> = {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
  };

  if (process.env.LOCAL_MINDOODB === "1") {
    aliases["mindoodb-app-sdk/testing"] = fileURLToPath(
      new URL("../mindoodb-app-sdk/src/testing/index.ts", import.meta.url),
    );
    aliases["mindoodb-app-sdk/vite"] = fileURLToPath(
      new URL("../mindoodb-app-sdk/src/vite/index.ts", import.meta.url),
    );
    aliases["mindoodb-app-sdk"] = fileURLToPath(
      new URL("../mindoodb-app-sdk/src/index.ts", import.meta.url),
    );
  }

  return aliases;
}

export default defineConfig({
  base: "./",
  plugins: [wasm(), vue(), havenBundle()],
  resolve: {
    alias: createResolveAliases(),
  },
  server: {
    // 127.0.0.1 rather than 0.0.0.0: this page holds the user's live API tokens in
    // memory, and nothing on the LAN has any business reaching it.
    host: "127.0.0.1",
    port: BUILDER_DEV_PORT,
    // In dev the SPA is served by Vite, so `/api` has to be forwarded to the builder
    // host running next to it. Same-origin from the browser's point of view, which is
    // what keeps the host's origin check meaningful in both modes.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${BUILDER_DEFAULT_PORT}`,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "jsdom",
    // Registers vue-i18n on every mounted component and pins the language to English,
    // so a component test asserts on the phrases in en.json instead of failing on a
    // missing `$t` or on whatever language the machine running it prefers.
    setupFiles: ["./src/i18n/testSetup.ts"],
  },
});
