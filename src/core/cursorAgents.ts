/**
 * Cursor Cloud Agents client.
 *
 * This is the one integration that **cannot** run in the browser: a Cursor API key is a
 * long-lived organization-scoped secret and the API is documented only for server-side
 * use, so the builder host proxies these calls (see `src/host/routes/cursor.ts`). The
 * key still belongs to the user — it arrives with the request, is used once, and is
 * never stored.
 *
 * The v1 surface splits work into a durable **agent** (the conversation and its
 * workspace) and per-prompt **runs**. Creating an agent returns both; a follow-up
 * instruction is a new run on the same agent, which is why iterating keeps context.
 *
 * Deliberately not sent: `envVars`. It is tempting to hand the agent the user's GitHub
 * and Cloudflare tokens so it could deploy its own work, but that copies live
 * credentials into a third-party VM for no benefit — Cloudflare Workers Builds deploys
 * from its own Git connection, so the agent only has to push.
 */

const CURSOR_API_BASE = "https://api.cursor.com";

/** Terminal states: polling can stop. */
export const CURSOR_RUN_TERMINAL_STATUSES = ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"] as const;

export type CursorRunStatus =
  | "CREATING"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED";

export interface CursorAgent {
  id: string;
  name: string;
  status: string;
  /** Where the user watches the agent work. The builder shows this as a link. */
  url: string;
  latestRunId?: string;
}

export interface CursorRunBranch {
  repoUrl: string;
  branch: string;
  prUrl?: string;
}

export interface CursorRun {
  id: string;
  agentId: string;
  status: CursorRunStatus;
  /** Only present once the run reached a terminal state. */
  result?: string;
  durationMs?: number;
  branches: CursorRunBranch[];
}

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Cursor's machine-readable code, e.g. `agent_busy`. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "CursorApiError";
  }
}

interface CursorRequestOptions {
  apiKey: string;
  method?: string;
  path: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
}

async function cursorRequest<T>(options: CursorRequestOptions): Promise<T> {
  const { apiKey, method = "GET", path, body, fetchImpl = fetch } = options;

  const response = await fetchImpl(`${CURSOR_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const record = payload as { error?: { message?: unknown; code?: unknown }; message?: unknown };
    const message =
      (typeof record.error?.message === "string" && record.error.message)
      || (typeof record.message === "string" && record.message)
      || `Cursor API request failed with HTTP ${response.status}.`;
    const code = typeof record.error?.code === "string" ? record.error.code : undefined;
    throw new CursorApiError(message, response.status, code);
  }

  return payload as T;
}

interface RawAgent {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  url?: unknown;
  latestRunId?: unknown;
}

interface RawRun {
  id?: unknown;
  agentId?: unknown;
  status?: unknown;
  result?: unknown;
  durationMs?: unknown;
  git?: { branches?: unknown };
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toAgent(raw: RawAgent | undefined): CursorAgent {
  return {
    id: readString(raw?.id),
    name: readString(raw?.name),
    status: readString(raw?.status),
    url: readString(raw?.url),
    latestRunId: typeof raw?.latestRunId === "string" ? raw.latestRunId : undefined,
  };
}

function toRun(raw: RawRun | undefined): CursorRun {
  const rawBranches = Array.isArray(raw?.git?.branches) ? raw.git.branches : [];
  return {
    id: readString(raw?.id),
    agentId: readString(raw?.agentId),
    status: readString(raw?.status, "CREATING") as CursorRunStatus,
    result: typeof raw?.result === "string" ? raw.result : undefined,
    durationMs: typeof raw?.durationMs === "number" ? raw.durationMs : undefined,
    branches: rawBranches.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }
      const record = entry as { repoUrl?: unknown; branch?: unknown; prUrl?: unknown };
      return [
        {
          // Cursor returns this without a scheme, unlike the URL that was sent in.
          repoUrl: readString(record.repoUrl),
          branch: readString(record.branch),
          prUrl: typeof record.prUrl === "string" ? record.prUrl : undefined,
        },
      ];
    }),
  };
}

export function isTerminalRunStatus(status: CursorRunStatus): boolean {
  return (CURSOR_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The first prompt: read the repo's own rules, then do what the user asked.
 *
 * Kept this short on purpose. `AGENTS.md` in the generated repo is the real brief — it
 * ships with the template, so it stays correct as the SDK changes, while a prompt
 * baked into this builder would drift the moment either side moves.
 */
export function buildLaunchPrompt(): string {
  return [
    "Read AGENTS.md in the repository root first: it states the platform rules and links",
    "the documentation that matches the pinned SDK version.",
    "",
    "Then implement TASK.md. Keep public/haven-app.json in step with the databases the",
    "app actually opens, run `pnpm test` and `pnpm build` before you finish, and commit",
    "the pnpm lockfile that the first install produces.",
  ].join("\n");
}

export interface LaunchAgentInput {
  apiKey: string;
  /** Full HTTPS clone URL, e.g. `https://github.com/octocat/team-notes`. */
  repositoryUrl: string;
  branch?: string;
  prompt?: string;
  /** `plan` makes the agent propose an approach first; useful for vague descriptions. */
  mode?: "agent" | "plan";
  /** Open a pull request instead of pushing to the branch directly. */
  autoCreatePR?: boolean;
  fetchImpl?: typeof fetch;
}

export interface LaunchAgentResult {
  agent: CursorAgent;
  run: CursorRun;
}

export async function launchAgent(input: LaunchAgentInput): Promise<LaunchAgentResult> {
  const payload = await cursorRequest<{ agent?: RawAgent; run?: RawRun }>({
    apiKey: input.apiKey,
    method: "POST",
    path: "/v1/agents",
    fetchImpl: input.fetchImpl,
    body: {
      prompt: { text: input.prompt?.trim() || buildLaunchPrompt() },
      repos: [
        {
          url: input.repositoryUrl,
          ...(input.branch ? { startingRef: input.branch } : {}),
        },
      ],
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.autoCreatePR === undefined ? {} : { autoCreatePR: input.autoCreatePR }),
    },
  });

  return { agent: toAgent(payload.agent), run: toRun(payload.run) };
}

/**
 * Send a follow-up instruction to an existing agent, reusing its conversation and
 * workspace.
 *
 * Only one run can be active per agent: Cursor answers `409 agent_busy` while the
 * previous one is still going, which the UI should show as "still working" rather than
 * as a failure.
 */
export async function sendFollowUp(options: {
  apiKey: string;
  agentId: string;
  prompt: string;
  fetchImpl?: typeof fetch;
}): Promise<CursorRun> {
  const payload = await cursorRequest<{ run?: RawRun }>({
    apiKey: options.apiKey,
    method: "POST",
    path: `/v1/agents/${encodeURIComponent(options.agentId)}/runs`,
    fetchImpl: options.fetchImpl,
    body: { prompt: { text: options.prompt } },
  });
  return toRun(payload.run);
}

/** Execution state lives on the run, not on the agent. */
export async function getRun(options: {
  apiKey: string;
  agentId: string;
  runId: string;
  fetchImpl?: typeof fetch;
}): Promise<CursorRun> {
  const payload = await cursorRequest<RawRun>({
    apiKey: options.apiKey,
    path:
      `/v1/agents/${encodeURIComponent(options.agentId)}`
      + `/runs/${encodeURIComponent(options.runId)}`,
    fetchImpl: options.fetchImpl,
  });
  return toRun(payload);
}

export async function getAgent(options: {
  apiKey: string;
  agentId: string;
  fetchImpl?: typeof fetch;
}): Promise<CursorAgent> {
  const payload = await cursorRequest<RawAgent>({
    apiKey: options.apiKey,
    path: `/v1/agents/${encodeURIComponent(options.agentId)}`,
    fetchImpl: options.fetchImpl,
  });
  return toAgent(payload);
}

/** Cheap credential check for the Connect screen. */
export async function verifyApiKey(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ email?: string }> {
  const payload = await cursorRequest<{ email?: unknown }>({
    apiKey: options.apiKey,
    path: "/v1/me",
    fetchImpl: options.fetchImpl,
  });
  return { email: typeof payload.email === "string" ? payload.email : undefined };
}
