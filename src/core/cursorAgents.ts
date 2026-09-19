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

/**
 * Sent on every launch. Omitting `model` lets Cursor pick the account default, which
 * is currently Grok 4.5 — this builder wants 4.6. Override per call via
 * {@link LaunchAgentInput.model}. The id is the Cloud Agents catalog value
 * (`GET /v1/models`), not the IDE slug.
 */
export const CURSOR_DEFAULT_MODEL_ID = "grok-4.6";

export interface CursorModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

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
 * Cursor Cloud Agents clone through Cursor's own GitHub App, not this builder's
 * token — that token is never sent (`envVars` is deliberately omitted). A private
 * repository the builder just created is therefore invisible until that other
 * installation can see it, which is what "cannot access the repository" means.
 */
export function explainCursorLaunchError(message: string, status: number): string {
  const looksLikeAccess =
    status === 403
    || status === 404
    || /access the repo/i.test(message)
    || /cannot access/i.test(message)
    || /not (have )?access/i.test(message)
    || /repository.*(not found|private|permission)/i.test(message);
  if (!looksLikeAccess) {
    return message;
  }
  return (
    `${message} Cursor Cloud Agents use Cursor's GitHub App, not this builder's token. ` +
    "Install it at https://github.com/apps/cursor/installations/new and give it " +
    '"All repositories" — or add this one after it exists — then start the agent again.'
  );
}

/**
 * The first prompt: read the repo's own rules, then do what the user asked.
 *
 * Kept this short on purpose. `AGENTS.md` in the generated repo is the real brief — it
 * ships with the template, so it stays correct as the SDK changes, while a prompt
 * baked into this builder would drift the moment either side moves.
 */
export function buildLaunchPrompt(branch = "main"): string {
  return [
    "Read AGENTS.md in the repository root first: it states the platform rules and links",
    "the documentation that matches the pinned SDK version.",
    "",
    "Then implement TASK.md. Keep public/haven-app.json in step with the databases the",
    "app actually opens. Generate a 512×512 PNG that matches the app's theme and write",
    "it to public/appicon.png — Haven uses that file as the workspace icon after a",
    "hosted-bundle install. Run `pnpm test` and `pnpm build` before you finish, and",
    "commit the pnpm lockfile that the first install produces.",
    "",
    // Said in the prompt as well as in the launch options because the agent can reach
    // for `gh pr create` on its own. Cloudflare deploys this app on a push to the
    // default branch, so work parked on a side branch never reaches the user.
    `Commit and push to ${branch} directly. Do not create a pull request, and do not`,
    "open a draft: this repository deploys on every push to its default branch, and the",
    "user is waiting for the app to appear at its own address.",
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
  /**
   * Push to `branch` itself instead of a generated `cursor/...` branch.
   *
   * Defaults to `true` here, against Cursor's own default, because this builder has one
   * outcome: Cloudflare Workers Builds deploys on a push to the default branch. Cursor's
   * default parks the work on a side branch, so the build never runs and the app the
   * user is waiting for never changes — with nothing failing anywhere to say why.
   */
  workOnCurrentBranch?: boolean;
  /**
   * Open a pull request when the run finishes.
   *
   * Defaults to `false` here for the same reason. A pull request is the right shape for
   * a team reviewing a change, and the wrong shape for someone who asked for an app and
   * is watching for its address.
   */
  autoCreatePR?: boolean;
  /** Defaults to {@link CURSOR_DEFAULT_MODEL_ID}. */
  model?: CursorModelSelection;
  fetchImpl?: typeof fetch;
}

export interface LaunchAgentResult {
  agent: CursorAgent;
  run: CursorRun;
}

export async function launchAgent(input: LaunchAgentInput): Promise<LaunchAgentResult> {
  let payload: { agent?: RawAgent; run?: RawRun };
  try {
    payload = await cursorRequest<{ agent?: RawAgent; run?: RawRun }>({
      apiKey: input.apiKey,
      method: "POST",
      path: "/v1/agents",
      fetchImpl: input.fetchImpl,
      body: {
        prompt: { text: input.prompt?.trim() || buildLaunchPrompt(input.branch) },
        repos: [
          {
            url: input.repositoryUrl,
            ...(input.branch ? { startingRef: input.branch } : {}),
          },
        ],
        ...(input.mode ? { mode: input.mode } : {}),
        // Both sent always, never omitted: leaving either out hands the decision to
        // Cursor's defaults, which are a `cursor/...` branch and no deployment.
        workOnCurrentBranch: input.workOnCurrentBranch ?? true,
        autoCreatePR: input.autoCreatePR ?? false,
        model: input.model ?? { id: CURSOR_DEFAULT_MODEL_ID },
      },
    });
  } catch (error) {
    if (error instanceof CursorApiError) {
      throw new CursorApiError(
        explainCursorLaunchError(error.message, error.status),
        error.status,
        error.code,
      );
    }
    throw error;
  }

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
