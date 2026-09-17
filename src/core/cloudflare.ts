/**
 * Cloudflare: create the Worker, then let Cloudflare's own CI deploy it on every push.
 *
 * Two jobs, and the split matters.
 *
 * **ensureWorker** uploads a placeholder module — a Worker that answers "deploying" and
 * nothing else. It is not the app. It exists because two things have to exist before the
 * app can be built: the public `*.workers.dev` URL (which goes into `haven-app.json`, so
 * it must be known *before* the first commit) and the Worker's immutable script tag,
 * which is the only identifier the Builds API accepts.
 *
 * **connectPushToDeploy** wires the repository to that Worker. From then on every push
 * to the default branch builds and deploys itself, including the identity commit that
 * follows immediately — so the placeholder is overwritten by the real app within a
 * minute or two, and the user's later pushes (or an agent's) need nothing from us.
 *
 * This is why the builder never holds a deploy credential and never runs `wrangler`:
 * the first deploy and the thousandth take the same path.
 *
 * Both run **on the builder host**, not in the page. `api.cloudflare.com` sends no CORS
 * headers, so a browser cannot call it at all — the token travels in one request to the
 * host, is used, and is dropped.
 *
 * Endpoint reference:
 * https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
 */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * Pinned rather than "today": a compatibility date is a promise about runtime
 * behaviour, and generating repos whose behaviour depends on their creation date would
 * make two apps from the same template subtly different.
 */
const PLACEHOLDER_COMPATIBILITY_DATE = "2026-09-01";

/**
 * The placeholder's whole job is to be replaced. It says so, and asks not to be cached,
 * because the origin probe polls this exact URL and a cached 503 would outlive the real
 * deployment.
 */
const PLACEHOLDER_MODULE = `export default {
  fetch() {
    return new Response("This app is being deployed. Reload in a moment.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
`;

/**
 * Cloudflare installs dependencies before the build command runs, and picks the package
 * manager from the lockfile. A generated repo has no lockfile yet — deliberately, so its
 * first install resolves a current SDK — which would leave the automatic step guessing.
 * Turning it off and installing explicitly makes the build the same whether or not a
 * lockfile has since been committed.
 */
const BUILD_ENVIRONMENT = { SKIP_DEPENDENCY_INSTALL: "true" };
const BUILD_COMMAND = "pnpm install --no-frozen-lockfile && pnpm run build";
const DEPLOY_COMMAND = "pnpm exec wrangler deploy";

export class CloudflareApiError extends Error {
  readonly status: number;
  /** Cloudflare's own error code, when it sent one. Worth keeping: 10007 etc. */
  readonly code: number | null;

  constructor(message: string, status: number, code: number | null = null) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.code = code;
  }
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

/**
 * Cloudflare reports failures two ways — an HTTP status and `success: false` with an
 * error list, sometimes both, sometimes only the second on a 200. Treat the envelope as
 * the authority and surface Cloudflare's own wording, which is usually specific enough
 * to act on ("workers.dev subdomain not registered").
 */
async function callCloudflare<T>(input: {
  token: string;
  path: string;
  method?: string;
  body?: unknown;
  /** Set for multipart uploads, where the body must not be JSON-encoded. */
  rawBody?: FormData;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const { token, path, method = "GET", body, rawBody, fetchImpl = fetch } = input;

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetchImpl(`${CLOUDFLARE_API}${path}`, {
      method,
      headers,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (error) {
    throw new CloudflareApiError(
      `Cloudflare could not be reached: ${error instanceof Error ? error.message : "network error"}`,
      0,
    );
  }

  const text = await response.text();
  let envelope: CloudflareEnvelope<T> | null = null;
  if (text) {
    try {
      envelope = JSON.parse(text) as CloudflareEnvelope<T>;
    } catch {
      envelope = null;
    }
  }

  if (!response.ok || envelope?.success === false) {
    const first = envelope?.errors?.[0];
    const message = first?.message || `Cloudflare returned ${response.status}.`;
    throw new CloudflareApiError(
      response.status === 401 || response.status === 403
        ? `${message} Check that the Cloudflare token is a user token with Workers Scripts Edit and Workers Builds Configuration Edit.`
        : message,
      response.status,
      first?.code ?? null,
    );
  }

  return (envelope?.result ?? (null as T)) as T;
}

export interface WorkerScript {
  name: string;
  tag: string;
}

/** `GET /workers/scripts` returns names as `id` and the tag the Builds API wants as `tag`. */
export async function listWorkerScripts(input: {
  token: string;
  accountId: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkerScript[]> {
  const result = await callCloudflare<Array<{ id?: string; tag?: string }>>({
    token: input.token,
    path: `/accounts/${encodeURIComponent(input.accountId)}/workers/scripts`,
    fetchImpl: input.fetchImpl,
  });

  return (result ?? [])
    .filter((entry): entry is { id: string; tag: string } =>
      Boolean(entry && typeof entry.id === "string" && typeof entry.tag === "string"),
    )
    .map((entry) => ({ name: entry.id, tag: entry.tag }));
}

/**
 * Whether this account has ever built from a Git repository.
 *
 * `"unconfirmed"` is not a failure. It means no evidence either way, which is the
 * honest answer for a fresh account and for one whose connected Worker is outside the
 * handful this looks at.
 */
export type GitIntegrationState = "connected" | "unconfirmed";

/**
 * Detect whether the Cloudflare GitHub App has been installed on the account.
 *
 * Installing it is the one step of the whole build with no API — Cloudflare's own docs
 * call it a dashboard prerequisite — so the best this can do is look for its footprint
 * rather than its record. There is no endpoint that lists Git connections: `PUT
 * /builds/repos/connections` and `DELETE .../{uuid}` are all that exist, and
 * `GET /builds/builds` needs `version_ids`, so it cannot answer "has anything ever
 * built here". An existing build trigger is the one artifact that proves a connection,
 * because a trigger cannot be created without one.
 *
 * Bounded on purpose: an account can hold hundreds of Workers, and this runs while the
 * user waits after connecting. Looking at a few is enough to recognise an account that
 * is already set up, and guessing wrong costs a line of text that says "not confirmed",
 * never a blocked build.
 */
export async function probeGitIntegration(input: {
  token: string;
  accountId: string;
  /** How many Workers to look at before giving up on finding evidence. */
  maxWorkers?: number;
  fetchImpl?: typeof fetch;
}): Promise<GitIntegrationState> {
  const { token, accountId, maxWorkers = 5, fetchImpl } = input;

  const workers = await listWorkerScripts({ token, accountId, fetchImpl });

  for (const worker of workers.slice(0, maxWorkers)) {
    const triggers = await callCloudflare<Array<{ trigger_uuid?: string }>>({
      token,
      path: `/accounts/${encodeURIComponent(accountId)}/builds/workers/${encodeURIComponent(worker.tag)}/triggers`,
      fetchImpl,
    });
    if ((triggers ?? []).some((entry) => Boolean(entry?.trigger_uuid))) {
      return "connected";
    }
  }

  return "unconfirmed";
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

/**
 * The accounts this token can act on.
 *
 * Exists so the user never has to find and paste an account id: after connecting, the
 * builder asks who they are and offers a list. A token scoped to a single account
 * returns one entry, which the UI can select without asking anything.
 */
export async function listAccounts(input: {
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudflareAccount[]> {
  const result = await callCloudflare<Array<{ id?: string; name?: string }>>({
    token: input.token,
    path: "/accounts",
    fetchImpl: input.fetchImpl,
  });

  return (result ?? [])
    .filter((entry): entry is { id: string; name?: string } =>
      Boolean(entry && typeof entry.id === "string"),
    )
    .map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }));
}

export async function getAccountSubdomain(input: {
  token: string;
  accountId: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const result = await callCloudflare<{ subdomain?: string }>({
    token: input.token,
    path: `/accounts/${encodeURIComponent(input.accountId)}/workers/subdomain`,
    fetchImpl: input.fetchImpl,
  });

  const subdomain = result?.subdomain?.trim();
  if (!subdomain) {
    throw new CloudflareApiError(
      "This account has no workers.dev subdomain yet. Register one once in the Cloudflare dashboard under Workers & Pages, then try again.",
      404,
    );
  }
  return subdomain;
}

export interface EnsureWorkerResult {
  url: string;
  scriptTag: string;
  reused: boolean;
}

/**
 * Make sure a Worker by this name exists and is reachable on `*.workers.dev`.
 *
 * An existing Worker is left completely alone. The name came from the repository name,
 * which was checked for availability on GitHub — so a collision here means the user
 * already has an unrelated Worker under that name, and overwriting it with a placeholder
 * would take down whatever it serves. Reporting `reused` lets the caller say so.
 */
export async function ensureWorker(input: {
  token: string;
  accountId: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<EnsureWorkerResult> {
  const { token, accountId, name, fetchImpl } = input;

  const subdomain = await getAccountSubdomain({ token, accountId, fetchImpl });
  const url = `https://${name}.${subdomain}.workers.dev`;

  const existing = (await listWorkerScripts({ token, accountId, fetchImpl })).find(
    (script) => script.name === name,
  );
  if (existing) {
    return { url, scriptTag: existing.tag, reused: true };
  }

  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "index.js",
          compatibility_date: PLACEHOLDER_COMPATIBILITY_DATE,
          bindings: [],
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.append(
    "index.js",
    new Blob([PLACEHOLDER_MODULE], { type: "application/javascript+module" }),
    "index.js",
  );

  await callCloudflare<unknown>({
    token,
    method: "PUT",
    path: `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`,
    rawBody: form,
    fetchImpl,
  });

  // The upload response does not carry the tag, so read it back. It is the identifier
  // every Builds call needs, and the name will not do.
  const created = (await listWorkerScripts({ token, accountId, fetchImpl })).find(
    (script) => script.name === name,
  );
  if (!created) {
    throw new CloudflareApiError(
      `Cloudflare accepted the Worker ${name} but does not list it yet. Try again in a moment.`,
      404,
    );
  }

  // Without this the Worker exists but answers nothing on the public internet, and both
  // the origin probe and the eventual Haven install would fail on a URL that looks right.
  //
  // `previews_enabled` is stated explicitly because Cloudflare's default follows the
  // workers.dev setting: enabling one would silently enable the other. A per-version
  // preview URL is another public address serving this app's code, and the app is
  // registered in Haven under one origin — so the extra surface buys nothing here.
  await callCloudflare<unknown>({
    token,
    method: "POST",
    path: `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/subdomain`,
    body: { enabled: true, previews_enabled: false },
    fetchImpl,
  });

  return { url, scriptTag: created.tag, reused: false };
}

export interface ConnectPushToDeployResult {
  repoConnectionUuid: string;
  triggerUuid: string;
  buildTokenUuid: string;
  /** True when a trigger was already configured for this Worker and was left as it is. */
  reused: boolean;
}

/**
 * The build token is what Cloudflare's CI uses to deploy, and it is a different
 * credential from the one this call authenticates with.
 *
 * An existing build token is preferred, because a user who set one up in the dashboard
 * scoped it deliberately and that intent should win. Creating one is the fallback, and
 * it rests on an inference: `POST /builds/tokens` takes `cloudflare_token_id` plus
 * `build_token_secret`, which Cloudflare does not document — the field names say it
 * wraps an existing API token, so the builder passes the id of the token the user
 * pasted (via `GET /user/tokens/verify`) and that token as the secret. If Cloudflare
 * rejects this, the dashboard route (Settings → Builds → API token) still works and the
 * list read above will then find it, so a failure here is recoverable rather than fatal
 * to the design.
 */
async function resolveBuildToken(input: {
  token: string;
  accountId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ uuid: string; created: boolean }> {
  const { token, accountId, fetchImpl } = input;

  const existing = await callCloudflare<Array<{ build_token_uuid?: string }>>({
    token,
    path: `/accounts/${encodeURIComponent(accountId)}/builds/tokens`,
    fetchImpl,
  });
  const found = (existing ?? []).find((entry) => Boolean(entry?.build_token_uuid));
  if (found?.build_token_uuid) {
    return { uuid: found.build_token_uuid, created: false };
  }

  const verified = await callCloudflare<{ id?: string }>({
    token,
    path: "/user/tokens/verify",
    fetchImpl,
  });
  if (!verified?.id) {
    throw new CloudflareApiError(
      "Cloudflare did not identify this token, so no build token could be registered. The Builds API needs a user token, not an account token.",
      401,
    );
  }

  const created = await callCloudflare<{ build_token_uuid?: string }>({
    token,
    method: "POST",
    path: `/accounts/${encodeURIComponent(accountId)}/builds/tokens`,
    body: {
      build_token_name: "MindooDB App Builder",
      build_token_secret: token,
      cloudflare_token_id: verified.id,
    },
    fetchImpl,
  });
  if (!created?.build_token_uuid) {
    throw new CloudflareApiError("Cloudflare did not return a build token.", 502);
  }
  return { uuid: created.build_token_uuid, created: true };
}

/**
 * Connect the repository to the Worker so pushes deploy themselves.
 *
 * Requires the Cloudflare GitHub App to be installed on the account — a one-time
 * dashboard step that has no API. When it is missing the connection upsert fails, and
 * that failure is rewritten into the instruction that actually fixes it, because
 * "resource not found" is not something a user can act on.
 */
export async function connectPushToDeploy(input: {
  token: string;
  accountId: string;
  /** GitHub's numeric account id, read in the browser where the GitHub token lives. */
  providerAccountId: string;
  providerAccountName: string;
  /** GitHub's numeric repository id. */
  repoId: string;
  repoName: string;
  scriptTag: string;
  branch: string;
  fetchImpl?: typeof fetch;
}): Promise<ConnectPushToDeployResult> {
  const { token, accountId, scriptTag, branch, fetchImpl } = input;

  const existingTriggers = await callCloudflare<Array<{
    trigger_uuid?: string;
    build_token_uuid?: string;
    repo_connection?: { repo_connection_uuid?: string };
  }>>({
    token,
    path: `/accounts/${encodeURIComponent(accountId)}/builds/workers/${encodeURIComponent(scriptTag)}/triggers`,
    fetchImpl,
  });
  const alreadyConnected = (existingTriggers ?? []).find((entry) => Boolean(entry?.trigger_uuid));
  if (alreadyConnected?.trigger_uuid) {
    return {
      repoConnectionUuid: alreadyConnected.repo_connection?.repo_connection_uuid ?? "",
      triggerUuid: alreadyConnected.trigger_uuid,
      buildTokenUuid: alreadyConnected.build_token_uuid ?? "",
      reused: true,
    };
  }

  let repoConnectionUuid: string;
  try {
    const connection = await callCloudflare<{ repo_connection_uuid?: string }>({
      token,
      method: "PUT",
      path: `/accounts/${encodeURIComponent(accountId)}/builds/repos/connections`,
      body: {
        provider_type: "github",
        provider_account_id: input.providerAccountId,
        provider_account_name: input.providerAccountName,
        repo_id: input.repoId,
        repo_name: input.repoName,
      },
      fetchImpl,
    });
    if (!connection?.repo_connection_uuid) {
      throw new CloudflareApiError("Cloudflare did not return a repository connection.", 502);
    }
    repoConnectionUuid = connection.repo_connection_uuid;
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 404 || error.status === 400)) {
      throw new CloudflareApiError(
        "Cloudflare cannot see your GitHub account. Install the Cloudflare GitHub App once — in the dashboard, open any Worker, then Settings, Builds, Connect — and try again.",
        error.status,
        error.code,
      );
    }
    throw error;
  }

  const buildToken = await resolveBuildToken({ token, accountId, fetchImpl });

  const trigger = await callCloudflare<{ trigger_uuid?: string }>({
    token,
    method: "POST",
    path: `/accounts/${encodeURIComponent(accountId)}/builds/triggers`,
    body: {
      external_script_id: scriptTag,
      repo_connection_uuid: repoConnectionUuid,
      build_token_uuid: buildToken.uuid,
      trigger_name: "Deploy production",
      build_command: BUILD_COMMAND,
      deploy_command: DEPLOY_COMMAND,
      root_directory: "/",
      branch_includes: [branch],
      branch_excludes: [],
      path_includes: ["*"],
      path_excludes: [],
      build_caching_enabled: true,
    },
    fetchImpl,
  });
  if (!trigger?.trigger_uuid) {
    throw new CloudflareApiError("Cloudflare did not return a build trigger.", 502);
  }

  await callCloudflare<unknown>({
    token,
    method: "PATCH",
    path: `/accounts/${encodeURIComponent(accountId)}/builds/triggers/${encodeURIComponent(trigger.trigger_uuid)}/environment_variables`,
    body: Object.fromEntries(
      Object.entries(BUILD_ENVIRONMENT).map(([key, value]) => [key, { value, is_secret: false }]),
    ),
    fetchImpl,
  });

  return {
    repoConnectionUuid,
    triggerUuid: trigger.trigger_uuid,
    buildTokenUuid: buildToken.uuid,
    reused: false,
  };
}
