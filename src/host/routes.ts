/**
 * The host's `/api/*` surface, as a pure function of (method, path, body).
 *
 * Keeping it framework-free and free of Node types means the whole API can be tested
 * without opening a socket, and the HTTP layer in `server.ts` stays small enough to
 * audit in one sitting.
 *
 * Every route takes the credential it needs in the request body and uses it for that
 * one call. There is no route that stores a token and none that returns one.
 */
import {
  connectPushToDeploy,
  ensureWorker,
  CloudflareApiError,
} from "../core/cloudflare";
import {
  getAgent,
  getRun,
  launchAgent,
  sendFollowUp,
  verifyApiKey,
  CursorApiError,
} from "../core/cursorAgents";

export interface ApiRequest {
  method: string;
  pathname: string;
  body: unknown;
  fetchImpl?: typeof fetch;
}

export interface ApiResponse {
  status: number;
  payload: unknown;
}

function badRequest(message: string): ApiResponse {
  return { status: 400, payload: { error: message } };
}

function readBodyString(body: unknown, key: string): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function readBodyBoolean(body: unknown, key: string): boolean | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Translate an upstream failure into something the UI can show.
 *
 * Upstream status codes are passed through rather than collapsed into 500 so the app
 * can tell "your key is wrong" (401) from "the agent is still working" (409), but the
 * message is the upstream's own text — the host adds no detail of its own, because it
 * knows nothing the user does not.
 */
function toErrorResponse(error: unknown): ApiResponse {
  if (error instanceof CursorApiError) {
    return {
      status: error.status >= 400 && error.status < 600 ? error.status : 502,
      payload: { error: error.message, code: error.code },
    };
  }
  if (error instanceof CloudflareApiError) {
    return {
      status: error.status >= 400 && error.status < 600 ? error.status : 502,
      payload: { error: error.message, code: error.code },
    };
  }
  return {
    status: 502,
    payload: { error: error instanceof Error ? error.message : "The upstream call failed." },
  };
}

export async function handleApiRequest(request: ApiRequest): Promise<ApiResponse> {
  const { method, pathname, body, fetchImpl } = request;

  if (pathname === "/api/health") {
    return { status: 200, payload: { ok: true } };
  }

  if (method !== "POST") {
    return { status: 405, payload: { error: `${method} is not allowed on ${pathname}.` } };
  }

  const cursorToken = readBodyString(body, "cursorToken");
  const cloudflareToken = readBodyString(body, "cloudflareToken");
  const accountId = readBodyString(body, "accountId");

  switch (pathname) {
    // Cloudflare's API sends no CORS headers, so these two cannot happen in the page at
    // all. The token is used for the one call and then forgotten.
    case "/api/cloudflare/worker": {
      const name = readBodyString(body, "name");
      if (!cloudflareToken || !accountId) {
        return badRequest("A Cloudflare token and account ID are required.");
      }
      if (!name) {
        return badRequest("A Worker name is required.");
      }
      try {
        const worker = await ensureWorker({
          token: cloudflareToken,
          accountId,
          name,
          fetchImpl,
        });
        return { status: 200, payload: worker };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    case "/api/cloudflare/push-to-deploy": {
      const scriptTag = readBodyString(body, "scriptTag");
      const repoId = readBodyString(body, "repoId");
      const repoName = readBodyString(body, "repoName");
      const providerAccountId = readBodyString(body, "providerAccountId");
      const providerAccountName = readBodyString(body, "providerAccountName");
      const branch = readBodyString(body, "branch");
      if (!cloudflareToken || !accountId) {
        return badRequest("A Cloudflare token and account ID are required.");
      }
      if (!scriptTag) {
        return badRequest("A Worker script tag is required.");
      }
      if (!repoId || !repoName || !providerAccountId || !providerAccountName) {
        return badRequest("The GitHub repository and account identifiers are required.");
      }
      try {
        const connection = await connectPushToDeploy({
          token: cloudflareToken,
          accountId,
          providerAccountId,
          providerAccountName,
          repoId,
          repoName,
          scriptTag,
          branch: branch || "main",
          fetchImpl,
        });
        return { status: 200, payload: connection };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    case "/api/cursor/verify": {
      if (!cursorToken) {
        return badRequest("A Cursor API key is required.");
      }
      try {
        const me = await verifyApiKey({ apiKey: cursorToken, fetchImpl });
        return { status: 200, payload: me };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    case "/api/cursor/agents": {
      const repositoryUrl = readBodyString(body, "repositoryUrl");
      if (!cursorToken) {
        return badRequest("A Cursor API key is required.");
      }
      if (!repositoryUrl) {
        return badRequest("A repository URL is required.");
      }
      const mode = readBodyString(body, "mode");
      try {
        const result = await launchAgent({
          apiKey: cursorToken,
          repositoryUrl,
          branch: readBodyString(body, "branch") || undefined,
          prompt: readBodyString(body, "prompt") || undefined,
          mode: mode === "plan" ? "plan" : mode === "agent" ? "agent" : undefined,
          autoCreatePR: readBodyBoolean(body, "autoCreatePR"),
          fetchImpl,
        });
        return { status: 200, payload: result };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    case "/api/cursor/follow-up": {
      const agentId = readBodyString(body, "agentId");
      const prompt = readBodyString(body, "prompt");
      if (!cursorToken) {
        return badRequest("A Cursor API key is required.");
      }
      if (!agentId) {
        return badRequest("An agent id is required.");
      }
      if (!prompt) {
        return badRequest("A follow-up needs some instructions.");
      }
      try {
        const run = await sendFollowUp({ apiKey: cursorToken, agentId, prompt, fetchImpl });
        return { status: 200, payload: { run } };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    case "/api/cursor/status": {
      const agentId = readBodyString(body, "agentId");
      const runId = readBodyString(body, "runId");
      if (!cursorToken) {
        return badRequest("A Cursor API key is required.");
      }
      if (!agentId) {
        return badRequest("An agent id is required.");
      }
      try {
        const agent = await getAgent({ apiKey: cursorToken, agentId, fetchImpl });
        const effectiveRunId = runId || agent.latestRunId;
        const run = effectiveRunId
          ? await getRun({ apiKey: cursorToken, agentId, runId: effectiveRunId, fetchImpl })
          : null;
        return { status: 200, payload: { agent, run } };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    default:
      return { status: 404, payload: { error: `Unknown endpoint ${pathname}.` } };
  }
}
