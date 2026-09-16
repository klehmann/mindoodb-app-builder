/**
 * The builder as a Cloudflare Worker, for the deployed copy at `app-builder.mindoodb.com`.
 *
 * It is the same builder. `handleApiRequest` was written as a pure function of method,
 * path and body — no Node imports, no sockets — so the Worker and the local Node host run
 * byte-identical logic and only the plumbing differs: static files come from the assets
 * binding instead of the filesystem, and configuration comes from the Worker's `env`
 * instead of `process.env`.
 *
 * The deployed copy exists for two reasons:
 *
 *   1. **A registered OAuth redirect URI.** Cloudflare has no device grant for
 *      third-party clients, so the authorization code must return to a pre-registered
 *      URL. A builder on `http://127.0.0.1:4400` has none, so it borrows this one and
 *      the callback page relays the code back to it (see `oauthCallback.ts`).
 *   2. **Somewhere to point a user who does not want to run anything.**
 *
 * What is worth being clear about: on the deployed copy, the one call that genuinely
 * needs a server — Cursor's API, which is not callable from a browser — is made by
 * *this* Worker rather than by a process on the user's machine. It still stores nothing
 * and logs nothing, but a user who would rather not route a Cursor key through anyone
 * else's infrastructure should run the builder locally. GitHub is called from the page,
 * and Cloudflare's OAuth exchange is too when CORS allows it, so Cursor is the only
 * difference between the two.
 */
import {
  readOAuthConfig,
  CLOUDFLARE_CALLBACK_PATH,
  type EnvLike,
} from "../core/oauthConfig";
import { builderAllowedOrigins } from "../core/ports";
import { renderCloudflareCallbackPage } from "../host/oauthCallback";
import { handleApiRequest } from "../host/routes";

export interface WorkerEnv {
  /** Static assets binding: the built SPA in `dist/`. */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  [key: string]: unknown;
}

/** Same cap as the Node host: these bodies carry API tokens, never buffer unbounded. */
const MAX_BODY_BYTES = 256 * 1024;

function envStrings(env: WorkerEnv): EnvLike {
  const values: EnvLike = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

function jsonResponse(status: number, payload: unknown, origin?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const config = readOAuthConfig(envStrings(env));

    if (url.pathname === CLOUDFLARE_CALLBACK_PATH) {
      return new Response(renderCloudflareCallbackPage(config), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    // Haven reads the app definition cross-origin when installing the builder.
    if (url.pathname === "/haven-app.json") {
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      return await env.ASSETS.fetch(request);
    }

    const origin = request.headers.get("origin");
    const allowedOrigins = [
      ...builderAllowedOrigins(typeof env.BUILDER_ALLOWED_ORIGIN === "string" ? env.BUILDER_ALLOWED_ORIGIN : undefined),
      url.origin,
      config.publicOrigin.replace(/\/$/, ""),
    ];

    if (request.method === "OPTIONS") {
      if (origin && allowedOrigins.includes(origin)) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
          },
        });
      }
      return new Response(null, { status: 403 });
    }

    if (origin && !allowedOrigins.includes(origin)) {
      return jsonResponse(403, { error: "This origin may not use the builder host." });
    }
    const allowOrigin = origin && allowedOrigins.includes(origin) ? origin : undefined;

    let body: unknown = {};
    if (request.method === "POST") {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        return jsonResponse(400, { error: "Request body is too large." }, allowOrigin);
      }
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        return jsonResponse(400, { error: "Request body is too large." }, allowOrigin);
      }
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return jsonResponse(
            400,
            { error: "The request body was not valid JSON." },
            allowOrigin,
          );
        }
      }
    }

    const result = await handleApiRequest({
      method: request.method,
      pathname: url.pathname,
      body,
      config,
    });
    return jsonResponse(result.status, result.payload, allowOrigin);
  },
};
