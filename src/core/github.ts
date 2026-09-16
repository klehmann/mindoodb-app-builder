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

  const raw = await githubRequest<RawRepository>({
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

  if (!raw) {
    throw new GitHubError("GitHub did not return the generated repository.", 500);
  }
  return toRepository(raw);
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
