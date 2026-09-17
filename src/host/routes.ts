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
  checkRepoReadable,
  connectPushToDeploy,
  ensureWorker,
  listAccounts,
  listBuilds,
  startBuild,
  probeGitIntegration,
  CloudflareApiError,
} from "../core/cloudflare";
import {
  cloudflareRedirectUri,
  readOAuthAvailability,
  readOAuthConfig,
  type BuilderOAuthConfig,
} from "../core/oauthConfig";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  CloudflareOAuthError,
} from "../core/cloudflareOAuth";
import {
  pollDeviceAuthorization,
  startDeviceAuthorization,
  GitHubDeviceFlowError,
} from "../core/githubDeviceFlow";
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
  /**
   * The OAuth registration this builder runs as. Passed in rather than read from the
   * environment here, because the same routes serve a Node host (`process.env`) and a
   * Worker (its own `env` binding).
   */
  config?: BuilderOAuthConfig;
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
  if (error instanceof CloudflareOAuthError || error instanceof GitHubDeviceFlowError) {
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
  const config = request.config ?? readOAuthConfig();

  if (pathname === "/api/health") {
    return { status: 200, payload: { ok: true } };
  }

  /**
   * What this builder is registered as. Only public values: the client ids are public by
   * definition for a client that cannot keep a secret, and the UI needs them to know
   * whether to offer "Connect" or fall back to asking for a pasted token.
   */
  if (pathname === "/api/config") {
    return {
      status: 200,
      payload: {
        oauth: readOAuthAvailability(config),
        cloudflareClientId: config.cloudflareClientId,
        cloudflareScopes: config.cloudflareScopes,
        githubAppSlug: config.githubAppSlug,
      },
    };
  }

  if (method !== "POST") {
    return { status: 405, payload: { error: `${method} is not allowed on ${pathname}.` } };
  }

  const cursorToken = readBodyString(body, "cursorToken");
  const cloudflareToken = readBodyString(body, "cloudflareToken");
  const accountId = readBodyString(body, "accountId");

  switch (pathname) {
    // `github.com/login/*` is not `api.github.com` and sends no CORS headers, so the two
    // device-flow calls have to happen here even though every other GitHub call in the
    // builder happens in the page. Neither carries a credential *in*: the first sends
    // only a public client id, and the second only the device code it was given.
    case "/api/github/device/start": {
      try {
        const authorization = await startDeviceAuthorization({
          clientId: config.githubClientId,
          fetchImpl,
        });
        return { status: 200, payload: authorization };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    case "/api/github/device/poll": {
      const deviceCode = readBodyString(body, "deviceCode");
      if (!deviceCode) {
        return badRequest("A device code is required.");
      }
      try {
        const result = await pollDeviceAuthorization({
          clientId: config.githubClientId,
          deviceCode,
          fetchImpl,
        });
        return { status: 200, payload: result };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    /**
     * Fallback for the PKCE code exchange.
     *
     * The browser does this itself when the OAuth client registration lists the
     * builder's origin in `allowed_cors_origins`, which is better — the access token
     * then never exists outside the tab. This route is for the case where it does not,
     * and it is a pass-through: the code and the verifier arrive together, are spent on
     * one call, and the tokens go straight back.
     */
    case "/api/cloudflare/oauth/token": {
      const code = readBodyString(body, "code");
      const codeVerifier = readBodyString(body, "codeVerifier");
      const redirectUri = readBodyString(body, "redirectUri") || cloudflareRedirectUri(config);
      if (!config.cloudflareClientId) {
        return badRequest("This builder has no Cloudflare OAuth client configured.");
      }
      if (!code || !codeVerifier) {
        return badRequest("An authorization code and its verifier are required.");
      }
      try {
        const tokens = await exchangeAuthorizationCode({
          clientId: config.cloudflareClientId,
          redirectUri,
          code,
          codeVerifier,
          fetchImpl,
        });
        return { status: 200, payload: tokens };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    case "/api/cloudflare/oauth/refresh": {
      const refreshToken = readBodyString(body, "refreshToken");
      if (!config.cloudflareClientId) {
        return badRequest("This builder has no Cloudflare OAuth client configured.");
      }
      if (!refreshToken) {
        return badRequest("A refresh token is required.");
      }
      try {
        const tokens = await refreshAccessToken({
          clientId: config.cloudflareClientId,
          refreshToken,
          fetchImpl,
        });
        return { status: 200, payload: tokens };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    /** So the user picks an account by name instead of hunting for its id. */
    case "/api/cloudflare/accounts": {
      if (!cloudflareToken) {
        return badRequest("A Cloudflare token is required.");
      }
      try {
        const accounts = await listAccounts({ token: cloudflareToken, fetchImpl });
        return { status: 200, payload: { accounts } };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    /**
     * Is the Cloudflare GitHub App installed? Asked before a build rather than
     * discovered by one failing, since fixing it means leaving for the dashboard.
     */
    case "/api/cloudflare/git-integration": {
      if (!cloudflareToken || !accountId) {
        return badRequest("A Cloudflare token and account ID are required.");
      }
      try {
        const state = await probeGitIntegration({
          token: cloudflareToken,
          accountId,
          fetchImpl,
        });
        return { status: 200, payload: { state } };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    // Asks Cloudflare to read the repository, which is the only way to learn whether its
    // GitHub App can. The ids are GitHub's and are not secret; the repository has to
    // exist already, so the caller runs this after creating it.
    case "/api/cloudflare/repo-access": {
      const providerAccountId = readBodyString(body, "providerAccountId");
      const repoId = readBodyString(body, "repoId");
      const branch = readBodyString(body, "branch");
      if (!cloudflareToken || !accountId) {
        return badRequest("A Cloudflare token and account ID are required.");
      }
      if (!providerAccountId || !repoId || !branch) {
        return badRequest("A provider account ID, repository ID and branch are required.");
      }
      try {
        const readable = await checkRepoReadable({
          token: cloudflareToken,
          accountId,
          providerAccountId,
          repoId,
          branch,
          fetchImpl,
        });
        return { status: 200, payload: readable };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

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

    // Starts a build with no push behind it, for a repository whose first push reached
    // nobody. See `startBuild`.
    case "/api/cloudflare/build": {
      const scriptTag = readBodyString(body, "scriptTag");
      const branch = readBodyString(body, "branch");
      if (!cloudflareToken || !accountId) {
        return badRequest("A Cloudflare token and account ID are required.");
      }
      if (!scriptTag || !branch) {
        return badRequest("A Worker script tag and branch are required.");
      }
      try {
        const build = await startBuild({
          token: cloudflareToken,
          accountId,
          scriptTag,
          branch,
          fetchImpl,
        });
        return { status: 200, payload: build };
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    // Read-only: how the app list answers "did the last build work?" without sending
    // the user to the dashboard.
    case "/api/cloudflare/builds": {
      const scriptTag = readBodyString(body, "scriptTag");
      if (!cloudflareToken || !accountId) {
        return badRequest("A Cloudflare token and account ID are required.");
      }
      if (!scriptTag) {
        return badRequest("A Worker script tag is required.");
      }
      try {
        const builds = await listBuilds({
          token: cloudflareToken,
          accountId,
          scriptTag,
          fetchImpl,
        });
        return { status: 200, payload: { builds } };
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
          // Both left undefined when the caller says nothing, so `launchAgent` applies
          // the builder's defaults — push to the branch, no pull request.
          workOnCurrentBranch: readBodyBoolean(body, "workOnCurrentBranch"),
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
