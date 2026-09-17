/**
 * GitHub REST calls the builder makes to turn a name and a description into a
 * ready-to-build repository.
 *
 * These run in the **browser**, not in the host: GitHub's REST API sends permissive CORS
 * headers, so the user's token never has to travel through a server we operate. That is
 * the whole reason this module has no host counterpart.
 *
 * Three steps:
 *   1. `generateRepositoryFromTemplate` — one call, copies the starter template.
 *   2. `commitFiles` — one commit that stamps the app's identity into the four files
 *      that carry it, plus the user's description into TASK.md.
 *   3. `getAuthenticatedUser` / `getRepository` — the numeric ids the Cloudflare Workers
 *      Builds connection needs later.
 */

const GITHUB_API_BASE = "https://api.github.com";

/** The template the starter repositories are generated from. */
export const STARTER_TEMPLATE_OWNER = "klehmann";
export const STARTER_TEMPLATE_REPO = "mindoodb-app-starter";

export interface GitHubUser {
  id: number;
  login: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  /**
   * The owner's numeric id. Carried along because Cloudflare's repository connection
   * asks for it, and for an organization it is not the token user's id — so taking it
   * from the repository is the only version that is right in both cases.
   */
  ownerId: number;
  htmlUrl: string;
  defaultBranch: string;
}

export interface GitHubFileChange {
  path: string;
  content: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

interface GitHubRequestOptions {
  token: string;
  method?: string;
  path: string;
  body?: unknown;
  /** Status codes to resolve as `null` instead of throwing (e.g. 404 on a lookup). */
  emptyOn?: number[];
}

async function githubRequest<T>(options: GitHubRequestOptions): Promise<T | null> {
  const { token, method = "GET", path, body, emptyOn = [] } = options;

  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (emptyOn.includes(response.status)) {
    return null;
  }

  if (!response.ok) {
    throw new GitHubError(await readGitHubErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return null;
  }

  return (await response.json()) as T;
}

/**
 * GitHub reports problems in a `message` field, sometimes with a per-field `errors`
 * array that carries the actually useful part ("name already exists on this account").
 */
async function readGitHubErrorMessage(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return `GitHub request failed with HTTP ${response.status}.`;
  }

  if (typeof payload !== "object" || payload === null) {
    return `GitHub request failed with HTTP ${response.status}.`;
  }

  const record = payload as { message?: unknown; errors?: unknown };
  const message = typeof record.message === "string" ? record.message : `HTTP ${response.status}`;
  const details = Array.isArray(record.errors)
    ? record.errors
        .map((entry) =>
          typeof entry === "object" && entry !== null && typeof (entry as { message?: unknown }).message === "string"
            ? (entry as { message: string }).message
            : "",
        )
        .filter((entry) => entry !== "")
    : [];

  return details.length ? `${message}: ${details.join("; ")}` : message;
}

interface RawRepository {
  id: number;
  name: string;
  full_name: string;
  owner: { id: number; login: string };
  html_url: string;
  default_branch: string;
}

function toRepository(raw: RawRepository): GitHubRepository {
  return {
    id: raw.id,
    name: raw.name,
    fullName: raw.full_name,
    owner: raw.owner.login,
    ownerId: raw.owner.id,
    htmlUrl: raw.html_url,
    defaultBranch: raw.default_branch,
  };
}

export async function getAuthenticatedUser(token: string): Promise<GitHubUser> {
  const raw = await githubRequest<{ id: number; login: string }>({ token, path: "/user" });
  if (!raw) {
    throw new GitHubError("GitHub did not return the authenticated user.", 500);
  }
  return { id: raw.id, login: raw.login };
}

/** `null` when the repository does not exist, which is how a name check is done. */
export async function getRepository(
  token: string,
  owner: string,
  name: string,
): Promise<GitHubRepository | null> {
  const raw = await githubRequest<RawRepository>({
    token,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    emptyOn: [404],
  });
  return raw ? toRepository(raw) : null;
}

/** Where the user installs the app. Installing is not the same as authorizing it. */
export function githubAppInstallUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}

interface RawInstallation {
  id?: number;
  app_slug?: string;
  repository_selection?: string;
}

/**
 * The user's installations, or `null` when the token cannot list them.
 *
 * The distinction matters: "no installations" is a fact about the account, while a
 * refused lookup is a fact about the token — a pasted personal access token may simply
 * not be allowed to ask. Collapsing the two would turn "cannot tell" into "not
 * installed" and send people to fix something that is already fine.
 *
 * Scope worth knowing before building anything on this: with a user-to-server token the
 * endpoint lists installations *of the app the token belongs to*, and nothing else. It
 * cannot see another vendor's app however it is filtered — see the note below
 * `findAppInstallation`.
 */
async function listUserInstallations(token: string): Promise<RawInstallation[] | null> {
  const payload = await githubRequest<{ installations?: RawInstallation[] }>({
    token,
    path: "/user/installations",
    emptyOn: [401, 403, 404],
  });
  return payload ? (payload.installations ?? []) : null;
}

export interface GitHubAppInstallation {
  id: number;
  /** `"all"` or `"selected"`. */
  repositorySelection: string;
}

/**
 * Find this app's installation on an account the token's user can reach.
 *
 * Worth understanding, because it is the difference between a working builder and an
 * opaque 403: authorizing a GitHub App and installing it are two separate acts. The
 * device flow only authorizes — it proves who the user is and that they consented — and
 * a `ghu_` token draws its *repository* permissions from an installation. A user who
 * authorized but never installed holds a token with no repository access at all, and
 * every call here answers "Resource not accessible by integration" no matter which
 * permissions the app declares.
 *
 * `null` therefore means two very different things depending on the token, which is why
 * callers must not treat it as an error on its own: a classic personal access token has
 * no installations and needs none.
 */
export async function findAppInstallation(options: {
  token: string;
  /** The app, as its URL slug. */
  appSlug: string;
}): Promise<GitHubAppInstallation | null> {
  const { token, appSlug } = options;

  const installations = await listUserInstallations(token);
  const installation = installations?.find((entry) => entry.app_slug === appSlug);
  if (!installation || typeof installation.id !== "number") {
    return null;
  }
  return {
    id: installation.id,
    repositorySelection: installation.repository_selection ?? "selected",
  };
}

/*
 * There used to be a `checkCloudflareRepoAccess` here, reading `GET /user/installations`
 * to find Cloudflare's app and warn when it was limited to hand-picked repositories.
 * It could not work, and it is worth knowing why before anyone writes it again.
 *
 * GitHub scopes that endpoint to the *app the token belongs to*: "Lists installations of
 * your GitHub App that the authenticated user has explicit permission to access." With
 * the `ghu_` token the device flow issues, the response therefore contains exactly one
 * entry — this builder's own installation — no matter how many other apps the account
 * has. Cloudflare's app is not absent from the list; it is not addressable by this
 * token at all. The old code read that silence as "not installed" and told every user,
 * correctly installed or not, to go and install it.
 *
 * There is no substitute. `GET /installation/repositories` answers for the token's own
 * installation, and Cloudflare exposes no endpoint listing its Git connections. The
 * requirement is real — a repository that does not exist yet cannot be in a hand-picked
 * list, so a build would connect and never run — but it can only be *stated*, not
 * verified, which is what the setup list now does.
 */

/*
 * There used to be an `ensureRepositoryInInstallation` here, adding a freshly created
 * repository to the app's installation so the identity commit could not be refused.
 * It was removed because it could never do anything:
 *
 *   - GitHub already grants an installation access to the repositories the app itself
 *     creates, even under "only select repositories", so there is no gap to close.
 *   - `PUT /user/installations/{id}/repositories/{id}` is not available to GitHub App
 *     tokens at all ("only works for PATs (classic) with the `repo` scope"), so with the
 *     token the device flow issues the call could only ever 403 — turning a healthy
 *     build into one carrying a warning about a problem that does not exist.
 */

/**
 * Read one file's text from a branch. `null` when the path does not exist, so callers
 * can treat an optional template file as optional.
 *
 * Uses the raw media type: the JSON form returns base64 with line breaks, and decoding
 * that by hand only adds a way to corrupt UTF-8.
 */
export async function getFileText(options: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<string | null> {
  const { token, owner, repo, path, ref } = options;
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    + `/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new GitHubError(await readGitHubErrorMessage(response), response.status);
  }
  return await response.text();
}

/**
 * Whether the repository has any content yet.
 *
 * Asks for the root listing, which is the one question with an unambiguous answer: a
 * repository with no commit answers 404 `"This repository is empty."`, and one with a
 * commit answers 200 with the entries. Anything else is a real failure and is thrown.
 */
export async function repositoryHasContent(options: {
  token: string;
  owner: string;
  repo: string;
  ref?: string;
}): Promise<boolean> {
  const { token, owner, repo, ref } = options;
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    + `/contents${query}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new GitHubError(await readGitHubErrorMessage(response), response.status);
  }
  return true;
}

/**
 * Wait for a freshly generated repository to actually contain the template.
 *
 * `POST /repos/{template}/generate` answers 201 with a complete repository object, but
 * GitHub copies the template *afterwards*. For the next second or two the repository
 * exists and is empty, and the Contents API says so with a 404 — which is what the
 * identity commit used to trip over, one step later, reporting "the template is missing
 * package.json" about a template that was fine.
 *
 * Polling the root listing rather than each file keeps the two cases apart: this answers
 * "has GitHub finished?", so a file that is genuinely absent afterwards is still an
 * error about that file, immediately, and not a timeout.
 */
export async function waitForRepositoryContent(options: {
  token: string;
  owner: string;
  repo: string;
  ref?: string;
  /** Give up after this long. Generation is normally done in seconds. */
  timeoutMs?: number;
  intervalMs?: number;
  /** Injected in tests, so they do not spend the timeout they are testing. */
  wait?: (ms: number) => Promise<void>;
  check?: typeof repositoryHasContent;
}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const check = options.check ?? repositoryHasContent;
  const query = {
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    ref: options.ref,
  };

  // One attempt plus retries for as long as the budget lasts, so a timeout of 0 still
  // asks once — "do not wait" must not turn into "do not look".
  for (let elapsed = 0; ; elapsed += intervalMs) {
    if (await check(query)) {
      return true;
    }
    if (elapsed + intervalMs > timeoutMs) {
      return false;
    }
    await wait(intervalMs);
  }
}

export interface GenerateRepositoryInput {
  token: string;
  /** Target owner. A blank value creates the repository under the token's own user. */
  owner?: string;
  name: string;
  description?: string;
  /**
   * Defaults to `false`. A public repository is what makes Cloudflare Workers Builds
   * and Cursor cloud agents simplest to authorize, but the user decides.
   */
  private?: boolean;
  templateOwner?: string;
  templateRepo?: string;
}

/**
 * Copy the starter template into a new repository.
 *
 * GitHub's template generation is a single call and gives the new repository a fresh
 * history, so the user's app does not start with the template's commits.
 */
export async function generateRepositoryFromTemplate(
  input: GenerateRepositoryInput,
): Promise<GitHubRepository> {
  const templateOwner = input.templateOwner ?? STARTER_TEMPLATE_OWNER;
  const templateRepo = input.templateRepo ?? STARTER_TEMPLATE_REPO;

  let raw: RawRepository | null;
  try {
    raw = await githubRequest<RawRepository>({
      token: input.token,
      method: "POST",
      path: `/repos/${encodeURIComponent(templateOwner)}/${encodeURIComponent(templateRepo)}/generate`,
      body: {
        name: input.name,
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.description ? { description: input.description } : {}),
        private: input.private ?? false,
      },
    });
  } catch (error) {
    throw explainTemplateGenerateError(error);
  }

  if (!raw) {
    throw new GitHubError("GitHub did not return the generated repository.", 500);
  }
  return toRepository(raw);
}

/**
 * Turn GitHub's "Resource not accessible by integration" into something the user can act
 * on. That message is GitHub's answer to *any* insufficient GitHub App grant and names
 * neither what is missing nor where to fix it, so it is repeated here with the two
 * causes in the order they actually occur.
 *
 * The installation comes first because authorizing is the step the device flow performs
 * and installing is the step it cannot: a token from an app that was never installed has
 * no repository permissions whatsoever. Only once installed does the second cause apply
 * — creating a repository counts as administration, so Administration write is needed on
 * top of the Contents access the identity commit uses, and a permission added after the
 * installation stays dormant until that installation accepts the request.
 */
function explainTemplateGenerateError(error: unknown): unknown {
  if (!(error instanceof GitHubError) || error.status !== 403) {
    return error;
  }
  return new GitHubError(
    `${error.message} — the GitHub App is authorized but its grant does not cover ` +
      "creating a repository. Either it is not installed on the account (authorizing and " +
      'installing are separate), or it lacks "Administration: Read and write" alongside ' +
      "Contents and Metadata. A permission added after installing also has to be accepted " +
      "on the installation. Reconnect GitHub here afterwards.",
    error.status,
  );
}

/**
 * Write several files in a single commit.
 *
 * Done with the Git data API rather than the contents API on purpose: the contents API
 * commits one file at a time and needs each file's current blob sha, which would turn
 * "name this app" into four commits and four extra round trips. Passing `content`
 * directly in the tree entries skips blob creation entirely.
 */
export async function commitFiles(options: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: GitHubFileChange[];
}): Promise<string> {
  const { token, owner, repo, branch, message, files } = options;
  if (files.length === 0) {
    throw new GitHubError("A commit needs at least one file.", 400);
  }

  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const ref = await githubRequest<{ object: { sha: string } }>({
    token,
    path: `${base}/git/ref/heads/${encodeURIComponent(branch)}`,
  });
  if (!ref) {
    throw new GitHubError(`Branch ${branch} was not found.`, 404);
  }
  const headSha = ref.object.sha;

  const headCommit = await githubRequest<{ tree: { sha: string } }>({
    token,
    path: `${base}/git/commits/${headSha}`,
  });
  if (!headCommit) {
    throw new GitHubError("The branch head commit could not be read.", 404);
  }

  const tree = await githubRequest<{ sha: string }>({
    token,
    method: "POST",
    path: `${base}/git/trees`,
    body: {
      base_tree: headCommit.tree.sha,
      tree: files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    },
  });
  if (!tree) {
    throw new GitHubError("The commit tree could not be created.", 500);
  }

  const commit = await githubRequest<{ sha: string }>({
    token,
    method: "POST",
    path: `${base}/git/commits`,
    body: { message, tree: tree.sha, parents: [headSha] },
  });
  if (!commit) {
    throw new GitHubError("The commit could not be created.", 500);
  }

  await githubRequest({
    token,
    method: "PATCH",
    path: `${base}/git/refs/heads/${encodeURIComponent(branch)}`,
    body: { sha: commit.sha },
  });

  return commit.sha;
}
