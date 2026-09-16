#!/usr/bin/env node
/**
 * Published entry point: `npx mindoodb-app-builder`.
 *
 * A thin loader rather than the host itself, so the shipped code is the same bundle the
 * repository builds (`dist-host/main.js`) and this file never drifts from it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../dist-host/main.js");

if (!existsSync(entry)) {
  console.error("The builder host is not built. Run `pnpm build` first.");
  process.exit(1);
}

await import(entry);
