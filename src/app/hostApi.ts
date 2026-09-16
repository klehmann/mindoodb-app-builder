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
import type { ConnectPushToDeployResult, EnsureWorkerResult } from "@/core/cloudflare";
import type { CursorAgent, CursorRun } from "@/core/cursorAgents";

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

export function launchCursorAgent(input: {
  cursorToken: string;
  repositoryUrl: string;
  branch?: string;
  prompt?: string;
  mode?: "agent" | "plan";
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
