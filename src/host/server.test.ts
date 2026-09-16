/**
 * The host's HTTP behaviour, exercised over a real socket on an ephemeral port.
 *
 * Most of these are security assertions rather than feature tests: the host is a
 * loopback service that sits next to the user's live API tokens, so "which origins may
 * call it" and "can a path escape the static directory" matter more than any route.
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILDER_DEV_PORT } from "@/core/ports";
import { startBuilderHost, type BuilderHostHandle } from "@/host/server";

let host: BuilderHostHandle | null = null;
let staticDir = "";

beforeEach(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), "builder-host-"));
  await writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>builder</title>");
  await writeFile(path.join(staticDir, "404.html"), "<!doctype html><title>missing</title>");
  await writeFile(path.join(staticDir, "haven-app.json"), '{"format":"mindoodb.haven.app"}');
  await mkdir(path.join(staticDir, "assets"), { recursive: true });
  await writeFile(path.join(staticDir, "assets", "app.js"), "export default 1;");
  // A file one level above the static root: the target of a traversal attempt.
  await writeFile(path.join(staticDir, "..", "builder-host-secret.txt"), "top secret");
});

afterEach(async () => {
  await host?.close();
  host = null;
  vi.unstubAllGlobals();
});

async function start(options: Parameters<typeof startBuilderHost>[0] = {}) {
  host = await startBuilderHost({ port: 0, staticDir, ...options });
  return host;
}

describe("static serving", () => {
  it("serves the SPA shell at the root", async () => {
    const { url } = await start();

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("builder");
  });

  it("serves its own haven-app.json with CORS, because Haven reads it cross-origin", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/haven-app.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves hashed assets with the right content type", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
  });

  it("answers an unknown path with 404, not with the SPA shell", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/assets/missing.js`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("missing");
  });

  it.each([
    "/../builder-host-secret.txt",
    "/%2e%2e/builder-host-secret.txt",
    "/assets/../../builder-host-secret.txt",
  ])("refuses to serve %s from outside the static root", async (attempt) => {
    const { url } = await start();

    const response = await fetch(`${url}${attempt}`, { redirect: "manual" });
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("top secret");
  });

  it("explains itself when running without a built SPA", async () => {
    const { url } = await start({ staticDir: undefined });

    const response = await fetch(url);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("API only") });
  });
});

describe("/api origin policy", () => {
  it("accepts a request from the Vite dev origin", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/health`, {
      headers: { Origin: `http://127.0.0.1:${BUILDER_DEV_PORT}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      `http://127.0.0.1:${BUILDER_DEV_PORT}`,
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("refuses a request from any other page the user might have open", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/health`, {
      headers: { Origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows an explicitly configured extra origin", async () => {
    const { url } = await start({ allowedOrigin: "https://builder.example.com" });

    const response = await fetch(`${url}/api/health`, {
      headers: { Origin: "https://builder.example.com" },
    });

    expect(response.status).toBe(200);
  });

  it("answers a preflight for an allowed origin and blocks one for a stranger", async () => {
    const { url } = await start();

    const allowed = await fetch(`${url}/api/cursor/verify`, {
      method: "OPTIONS",
      headers: {
        Origin: `http://127.0.0.1:${BUILDER_DEV_PORT}`,
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-methods")).toContain("POST");

    const blocked = await fetch(`${url}/api/cursor/verify`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never allows credentialed cross-origin requests", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/health`, {
      headers: { Origin: `http://127.0.0.1:${BUILDER_DEV_PORT}` },
    });

    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("/api request handling", () => {
  it("forwards a proxied call and returns the upstream result", async () => {
    const { url } = await start({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ email: "dev@example.com" }), {
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    });

    const response = await fetch(`${url}/api/cursor/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursorToken: "crsr_key" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "dev@example.com" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a body that is not JSON", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/cursor/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(response.status).toBe(400);
  });

  it("refuses an oversized body instead of buffering it", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/cursor/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursorToken: "x".repeat(300 * 1024) }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("too large") });
  });
});
