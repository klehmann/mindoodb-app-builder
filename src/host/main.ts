/**
 * Entry point for the builder host.
 *
 * Prints the URL to paste into Haven, because that is the whole handshake: Haven
 * installs the builder like any other externally hosted app, and a loopback URL counts
 * as a secure origin, so an HTTPS Haven can iframe `http://127.0.0.1:4400` without
 * mixed-content trouble.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILDER_DEFAULT_PORT, BUILDER_DEV_PORT } from "../core/ports";
import { startBuilderHost } from "./server";

function resolveStaticDir(): string | undefined {
  // The built SPA sits next to the built host: dist-host/main.js and dist/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, "../dist"),
    path.resolve(here, "../../dist"),
    path.resolve(process.cwd(), "dist"),
  ]) {
    if (existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return undefined;
}

function readPort(): number {
  const raw = process.env.MINDOODB_BUILDER_PORT?.trim();
  if (!raw) {
    return BUILDER_DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`MINDOODB_BUILDER_PORT must be a port number, received ${raw}.`);
  }
  return parsed;
}

const staticDir = resolveStaticDir();
const port = readPort();

const host = await startBuilderHost({
  port,
  staticDir,
  // Binding beyond loopback is possible for a shared deployment, but it is opt-in: the
  // page this host serves holds live API tokens in the browser.
  host: process.env.MINDOODB_BUILDER_HOST?.trim() || "127.0.0.1",
  allowedOrigin: process.env.MINDOODB_BUILDER_ALLOWED_ORIGIN,
});

const pasteUrl = staticDir ? host.url : `http://127.0.0.1:${BUILDER_DEV_PORT}`;

console.log("");
console.log("  MindooDB App Builder");
console.log("");
console.log(`  Host        ${host.url}`);
console.log(`  Mode        ${staticDir ? "serving the built app" : "API only (run `pnpm dev`)"}`);
console.log("");
console.log("  Paste this URL into Haven → Applications → add an app:");
console.log("");
console.log(`      ${pasteUrl}`);
console.log("");
console.log("  Your tokens stay in your Haven database and in this browser tab.");
console.log("  This host stores nothing.");
console.log("");

async function shutdown(signal: string): Promise<void> {
  console.log(`\nStopping the builder host (${signal}).`);
  await host.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
