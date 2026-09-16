/**
 * The builder host.
 *
 * It exists for exactly two reasons, and it is worth being blunt about them because
 * everything else in the builder deliberately runs in the browser:
 *
 *   1. **Some APIs are not callable from a page.** Cursor's API is documented for
 *      server-side use only; Cloudflare's API does not promise CORS. GitHub does, which
 *      is why repository creation is not here.
 *   2. **The user needs one origin to paste into Haven.** The host serves the SPA and
 *      its own `haven-app.json`, so a local builder is an ordinary Haven app
 *      registration pointing at `http://127.0.0.1:4400`.
 *
 * What it is emphatically *not* is a credential store. Tokens arrive in a request body,
 * are used for that one call, and are never written to disk, logged, or cached. There
 * is no session, no cookie, and no database. Restarting the host loses nothing, because
 * it never held anything.
 *
 * Security posture:
 *   - Bound to loopback by default, so nothing on the LAN can reach it.
 *   - `/api/*` requires an allowlisted `Origin`, so a random page the user visits cannot
 *     drive it.
 *   - Responses carry no `Access-Control-Allow-Credentials` and the host sets no
 *     cookies, so there is nothing to ride along on a cross-site request.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { builderAllowedOrigins, BUILDER_DEFAULT_PORT } from "../core/ports";
import { handleApiRequest } from "./routes";

export interface BuilderHostOptions {
  port?: number;
  /** Defaults to loopback. Override only with a reason. */
  host?: string;
  /** Directory holding the built SPA (`dist/`). Omitted in API-only dev mode. */
  staticDir?: string;
  /** Extra comma-separated origins allowed to call `/api/*`. */
  allowedOrigin?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export interface BuilderHostHandle {
  server: Server;
  /** The port actually bound, which differs from the request when port 0 is used. */
  port: number;
  url: string;
  close: () => Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a URL path inside the static directory, refusing anything that escapes it.
 *
 * The check is on the *resolved* path rather than on the raw string, so `%2e%2e`,
 * backslashes, and symlink-shaped tricks all end up compared against the real root.
 */
function resolveStaticPath(staticDir: string, urlPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes("\0")) {
    return null;
  }

  const relative = decoded.replace(/^\/+/, "") || "index.html";
  const root = path.resolve(staticDir);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }

  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    const indexFile = path.join(resolved, "index.html");
    return existsSync(indexFile) ? indexFile : null;
  }
  return existsSync(resolved) ? resolved : null;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

/** Bodies here carry API tokens, so cap them and never buffer without a limit. */
const MAX_BODY_BYTES = 256 * 1024;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (total === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startBuilderHost(
  options: BuilderHostOptions = {},
): Promise<BuilderHostHandle> {
  const requestedPort = options.port ?? BUILDER_DEFAULT_PORT;
  const host = options.host ?? "127.0.0.1";
  const allowedOrigins = builderAllowedOrigins(options.allowedOrigin);
  const staticDir = options.staticDir;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "The builder host failed.",
        });
        return;
      }
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    // Haven fetches this cross-origin to install the builder, exactly as it does for a
    // Cloudflare-hosted app.
    if (url.pathname === "/haven-app.json") {
      response.setHeader("Access-Control-Allow-Origin", "*");
    }

    if (!staticDir) {
      sendJson(response, 404, {
        error: "This builder host serves the API only. Run the Vite dev server for the UI.",
      });
      return;
    }

    await serveStatic(url.pathname, response, staticDir);
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const origin = request.headers.origin;

    if (request.method === "OPTIONS") {
      // Preflight is answered for allowed origins only; an unknown origin gets no
      // Access-Control-Allow-Origin and the browser stops there.
      if (origin && allowedOrigins.includes(origin)) {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        });
      } else {
        response.writeHead(403);
      }
      response.end();
      return;
    }

    // A same-origin `fetch` from the built SPA sends no Origin header for GET, so only
    // a *present and unknown* origin is rejected.
    if (origin && !allowedOrigins.includes(origin)) {
      sendJson(response, 403, { error: "This origin may not use the builder host." });
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }

    let body: unknown = {};
    if (request.method === "POST") {
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "The request body was not valid JSON.",
        });
        return;
      }
    }

    const result = await handleApiRequest({
      method: request.method ?? "GET",
      pathname: url.pathname,
      body,
      fetchImpl: options.fetchImpl,
    });
    sendJson(response, result.status, result.payload);
  }

  async function serveStatic(
    urlPath: string,
    response: ServerResponse,
    directory: string,
  ): Promise<void> {
    const filePath = resolveStaticPath(directory, urlPath);

    if (!filePath) {
      const notFound = path.join(directory, "404.html");
      if (existsSync(notFound)) {
        const html = await readFile(notFound);
        response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      // The SPA is rebuilt in place during development, and a builder that serves a
      // stale bundle after an update is a support ticket, not an optimization.
      "Cache-Control": "no-cache",
    });
    createReadStream(filePath).pipe(response);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : requestedPort;

  return {
    server,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
