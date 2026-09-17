/**
 * Calls from the builder UI to the builder host.
 *
 * Same origin in both modes — the host serves the built SPA, and in development Vite
 * proxies `/api` to it — so these are plain relative fetches with no CORS dance and no
 * base URL to configure.
 *
 * Every call carries the credential it needs in the body. Deliberately: the host has no
 * session and no token store, so a request that does not bring a token cannot do
 * anything, and a host restart never invalidates anything.
 */
import type {
  CloudflareAccount,
  ConnectPushToDeployResult,
  EnsureWorkerResult,
  GitIntegrationState,
  RepoReadableResult,
  WorkerBuild,
} from "@/core/cloudflare";
import type { CloudflareOAuthTokens } from "@/core/cloudflareOAuth";
import type { CursorAgent, CursorRun } from "@/core/cursorAgents";
import type {
  GitHubDeviceAuthorization,
  GitHubDevicePollResult,
} from "@/core/githubDeviceFlow";
import type { BuilderOAuthAvailability } from "@/core/oauthConfig";

export class HostApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HostApiError";
  }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HostApiError(
      "The builder host is not reachable. Start it with `mindoodb-app-builder`.",
      0,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    code?: unknown;
  };

  if (!response.ok) {
    throw new HostApiError(
      typeof payload.error === "string" ? payload.error : `The host answered HTTP ${response.status}.`,
      response.status,
      typeof payload.code === "string" ? payload.code : undefined,
    );
  }

  return payload as T;
}

export async function checkHostAlive(): Promise<boolean> {
  try {
    const response = await fetch("/api/health");
    return response.ok;
  } catch {
    return false;
  }
}

export interface BuilderHostConfig {
  oauth: BuilderOAuthAvailability;
  cloudflareClientId: string;
  cloudflareScopes: string[];
  /** Which app's installation should cover a newly created repository. */
  githubAppSlug: string;
}

/**
 * Which connect flows this builder is registered for.
 *
 * Read once at startup. A builder with no registered applications answers with empty
 * client ids, and the UI then asks for pasted tokens instead of offering a button that
 * would lead to an error page.
 */
export async function readHostConfig(): Promise<BuilderHostConfig | null> {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as BuilderHostConfig;
  } catch {
    return null;
  }
}

/** Step 1 of the GitHub device flow. Sends nothing but the host's own client id. */
export function startGitHubDeviceFlow(): Promise<GitHubDeviceAuthorization> {
  return post("/api/github/device/start", {});
}

/** Step 3, polled at the interval GitHub asked for. */
export function pollGitHubDeviceFlow(deviceCode: string): Promise<GitHubDevicePollResult> {
  return post("/api/github/device/poll", { deviceCode });
}

/**
 * Exchange a Cloudflare authorization code through the host.
 *
 * Only used when the browser could not do it itself — see `connectCloudflare` in
 * `useCloudflareConnect.ts`, which tries the direct call first precisely so the access
 * token can stay inside the tab.
 */
export function exchangeCloudflareCodeViaHost(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<CloudflareOAuthTokens> {
  return post("/api/cloudflare/oauth/token", { ...input });
}

export function refreshCloudflareTokenViaHost(refreshToken: string): Promise<CloudflareOAuthTokens> {
  return post("/api/cloudflare/oauth/refresh", { refreshToken });
}

/** So the user picks an account instead of pasting its id. */
export function listCloudflareAccounts(
  cloudflareToken: string,
): Promise<{ accounts: CloudflareAccount[] }> {
  return post("/api/cloudflare/accounts", { cloudflareToken });
}

/**
 * Has the Cloudflare GitHub App been installed on this account? The answer is evidence,
 * not a record — see `probeGitIntegration` — so "unconfirmed" means unknown, not no.
 */
export function probeCloudflareGitIntegration(input: {
  cloudflareToken: string;
  accountId: string;
}): Promise<{ state: GitIntegrationState }> {
  return post("/api/cloudflare/git-integration", { ...input });
}

/**
 * Can Cloudflare read this repository? Asked by making Cloudflare try — see
 * `checkRepoReadable`. The repository must already exist.
 */
export function checkCloudflareRepoReadable(input: {
  cloudflareToken: string;
  accountId: string;
  providerAccountId: string;
  repoId: string;
  branch: string;
}): Promise<RepoReadableResult> {
  return post("/api/cloudflare/repo-access", { ...input });
}

export function verifyCursorKey(cursorToken: string): Promise<{ email?: string }> {
  return post("/api/cursor/verify", { cursorToken });
}

export function ensureCloudflareWorker(input: {
  cloudflareToken: string;
  accountId: string;
  name: string;
}): Promise<EnsureWorkerResult> {
  return post("/api/cloudflare/worker", { ...input });
}

export function connectCloudflarePushToDeploy(input: {
  cloudflareToken: string;
  accountId: string;
  /**
   * GitHub's numeric ids, read in the page. The builder host never sees the GitHub
   * token — it only needs the ids Cloudflare asks for, which are not secret.
   */
  providerAccountId: string;
  providerAccountName: string;
  repoId: string;
  repoName: string;
  scriptTag: string;
  branch: string;
}): Promise<ConnectPushToDeployResult> {
  return post("/api/cloudflare/push-to-deploy", { ...input });
}

/**
 * Start a build without pushing anything — the way out of a repository whose first
 * push reached nobody. See `startBuild`.
 */
export function startCloudflareBuild(input: {
  cloudflareToken: string;
  accountId: string;
  scriptTag: string;
  branch: string;
}): Promise<{ buildUuid: string }> {
  return post("/api/cloudflare/build", { ...input });
}

/** The Worker's recent builds, newest first, for the "last build" line in the app list. */
export function listCloudflareBuilds(input: {
  cloudflareToken: string;
  accountId: string;
  scriptTag: string;
}): Promise<{ builds: WorkerBuild[] }> {
  return post("/api/cloudflare/builds", { ...input });
}

export function launchCursorAgent(input: {
  cursorToken: string;
  repositoryUrl: string;
  branch?: string;
  prompt?: string;
  mode?: "agent" | "plan";
  /** Omit both to get the builder's defaults: push to `branch`, open no pull request. */
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
}): Promise<{ agent: CursorAgent; run: CursorRun }> {
  return post("/api/cursor/agents", { ...input });
}

export function sendCursorFollowUp(input: {
  cursorToken: string;
  agentId: string;
  prompt: string;
}): Promise<{ run: CursorRun }> {
  return post("/api/cursor/follow-up", { ...input });
}

export function readCursorStatus(input: {
  cursorToken: string;
  agentId: string;
  runId?: string;
}): Promise<{ agent: CursorAgent; run: CursorRun | null }> {
  return post("/api/cursor/status", { ...input });
}
