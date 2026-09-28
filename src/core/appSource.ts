/**
 * Starting an app from an existing one: find its code, check it can be copied, copy it.
 *
 * The user pastes one of two things, and both end at a public GitHub repository:
 *
 *  - a **repository URL** (`https://github.com/owner/repo`, `owner/repo`, a `.git` or
 *    `/tree/...` link), used as-is;
 *  - an **app URL** — the address the app is served from. Its `haven-app.json` names the
 *    repository in `source.repository`, which this builder writes for every public app it
 *    creates. An app without that field cannot be traced back to its code, and says so.
 *
 * The copy is a fresh history, not a fork. A fork is one per account and source, cannot
 * be private, cannot be made of one's own repository, and keeps pointing at its parent —
 * none of which fits "start my app from that one". GitHub's template endpoint only works
 * for repositories marked as templates. So the files are read through the Git data API
 * and written into the new repository as one commit, which is the same mechanism the
 * identity commit already uses, only for every file.
 *
 * Everything reaches the network through injected functions, so the rules here — what
 * counts as copyable, what is skipped, what is text — are testable without GitHub.
 */
import {
  resolveMindooDBAppDefinitionUrl,
  validateMindooDBAppDefinition,
} from "mindoodb-app-sdk";

import { FlowNoteError } from "./flowNotes";
import type {
  GitHubRepositoryDetails,
  GitHubTree,
  GitHubTreeEntry,
  ReplacementTreeEntry,
} from "./github";

export interface SourceRepositoryRef {
  owner: string;
  repo: string;
}

export type SourceInput =
  | ({ kind: "github" } & SourceRepositoryRef)
  | { kind: "app"; url: string };

/** One database the source app declares, as its code addresses it. */
export interface AppSourceDatabase {
  logicalDatabaseId: string;
  label: string;
}

/** A repository that was checked and can be copied, pinned to one commit. */
export interface AppSource {
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  branch: string;
  commitSha: string;
  /** From the source's `haven-app.json`, for pre-filling the form. */
  label: string;
  description: string;
  databases: AppSourceDatabase[];
  /** The files that will be copied. */
  files: GitHubTreeEntry[];
  /** Workflow files, which a GitHub App token may not write. Left out, and counted. */
  skippedPaths: string[];
}

/**
 * Where a copy stops. Generous for an app — the starter is a few dozen files — and far
 * below what would run into GitHub's limits on content-creating requests.
 */
export const COPY_LIMITS = {
  maxFiles: 2_000,
  maxTotalBytes: 50 * 1024 * 1024,
};

/** Files the builder reads and rewrites; a source without them is not a Haven app it can adopt. */
export const REQUIRED_SOURCE_FILES = ["package.json", "wrangler.jsonc", "public/haven-app.json"];

/**
 * Workflows are left behind. Writing `.github/workflows/*` needs the `workflows`
 * permission, which this builder's GitHub App does not ask for, and a copied workflow
 * would run with the new owner's secrets anyway — not something to inherit silently.
 */
const SKIPPED_PREFIXES = [".github/workflows/"];

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function repositoryRef(owner: string, repo: string): SourceRepositoryRef | null {
  const cleanRepo = repo.replace(/\.git$/i, "");
  if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(cleanRepo) || cleanRepo === "." || cleanRepo === "..") {
    return null;
  }
  return { owner, repo: cleanRepo };
}

/**
 * A GitHub repository named any of the ways people copy one: the page URL, a deeper
 * link into it, the clone URL, the SSH form, or bare `owner/repo`.
 */
export function parseGitHubRepository(text: string): SourceRepositoryRef | null {
  const value = text.trim();
  if (!value) {
    return null;
  }

  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value);
  if (ssh) {
    return repositoryRef(ssh[1], ssh[2]);
  }

  // `owner/repo`. GitHub owners cannot contain a dot, so `example.com/app` stays a URL.
  const bare = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (bare) {
    return repositoryRef(bare[1], bare[2]);
  }

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  return owner && repo ? repositoryRef(owner, repo) : null;
}

/** What the user pasted: a repository, an app's address, or nothing usable. */
export function parseSourceInput(text: string): SourceInput | null {
  const repository = parseGitHubRepository(text);
  if (repository) {
    return { kind: "github", ...repository };
  }
  const value = text.trim();
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".")) {
      return { kind: "app", url: url.href };
    }
  } catch {
    // Falls through to "not usable".
  }
  return null;
}

/**
 * The repository an app definition says it was built from, if it says so.
 *
 * Only GitHub repositories count, because only those can be read here.
 */
export function sourceRepositoryFromDefinition(definition: unknown): SourceRepositoryRef | null {
  if (typeof definition !== "object" || definition === null) {
    return null;
  }
  const source = (definition as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) {
    return null;
  }
  const repository = (source as { repository?: unknown }).repository;
  return typeof repository === "string" ? parseGitHubRepository(repository) : null;
}

/** The `haven-app.json` URL for an app address, whether or not it already ends in it. */
export function appDefinitionUrlFor(appUrl: string): string {
  return resolveMindooDBAppDefinitionUrl(appUrl);
}

function readLabel(definition: Record<string, unknown>): string {
  return typeof definition.label === "string" ? definition.label.trim() : "";
}

function readDescription(definition: Record<string, unknown>): string {
  if (typeof definition.description === "string" && definition.description.trim()) {
    return definition.description.trim();
  }
  const listing = definition.listing;
  if (typeof listing === "object" && listing !== null) {
    const summary = (listing as { summary?: unknown }).summary;
    if (typeof summary === "string") {
      return summary.trim();
    }
    if (typeof summary === "object" && summary !== null) {
      const en = (summary as Record<string, unknown>).en;
      return typeof en === "string" ? en.trim() : "";
    }
  }
  return "";
}

export interface ResolveSourceDependencies {
  /** The parsed `haven-app.json` at this URL. Throws when it cannot be read. */
  fetchAppDefinition: (definitionUrl: string) => Promise<unknown>;
  getRepositoryDetails: (owner: string, repo: string) => Promise<GitHubRepositoryDetails | null>;
  readTree: (owner: string, repo: string, ref: string) => Promise<GitHubTree>;
  readFile: (owner: string, repo: string, path: string, ref: string) => Promise<string | null>;
}

/**
 * Turn what the user pasted into a checked, copyable source.
 *
 * Throws a {@link FlowNoteError} for every reason a source is refused, so the form can
 * say exactly what is wrong in the reader's language. `commitSha` pins a resumed copy to
 * the commit the first attempt saw.
 */
export async function resolveAppSource(
  input: string,
  deps: ResolveSourceDependencies,
  options: { commitSha?: string } = {},
): Promise<AppSource> {
  const parsed = parseSourceInput(input);
  if (!parsed) {
    throw new FlowNoteError({ code: "sourceInputInvalid" });
  }

  let ref: SourceRepositoryRef;
  if (parsed.kind === "github") {
    ref = parsed;
  } else {
    const definitionUrl = appDefinitionUrlFor(parsed.url);
    let definition: unknown;
    try {
      definition = await deps.fetchAppDefinition(definitionUrl);
    } catch {
      throw new FlowNoteError({ code: "sourceAppUnreachable", params: { url: definitionUrl } });
    }
    const fromDefinition = sourceRepositoryFromDefinition(definition);
    if (!fromDefinition) {
      throw new FlowNoteError({ code: "sourceAppNoRepository", params: { url: definitionUrl } });
    }
    ref = fromDefinition;
  }

  const fullName = `${ref.owner}/${ref.repo}`;
  const details = await deps.getRepositoryDetails(ref.owner, ref.repo);
  if (!details) {
    throw new FlowNoteError({ code: "sourceRepoNotFound", params: { fullName } });
  }
  if (details.private) {
    throw new FlowNoteError({ code: "sourceRepoPrivate", params: { fullName } });
  }

  const repository = details.repository;
  const tree = await deps.readTree(
    repository.owner,
    repository.name,
    options.commitSha || repository.defaultBranch,
  );
  if (tree.truncated) {
    throw new FlowNoteError({
      code: "sourceTooLarge",
      params: { fullName: repository.fullName, limit: COPY_LIMITS.maxFiles },
    });
  }
  if (tree.entries.some((entry) => entry.type === "commit")) {
    throw new FlowNoteError({ code: "sourceHasSubmodules", params: { fullName: repository.fullName } });
  }

  const blobs = tree.entries.filter((entry) => entry.type === "blob");
  const skippedPaths = blobs
    .filter((entry) => SKIPPED_PREFIXES.some((prefix) => entry.path.startsWith(prefix)))
    .map((entry) => entry.path);
  const files = blobs.filter((entry) => !skippedPaths.includes(entry.path));
  const totalBytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (files.length > COPY_LIMITS.maxFiles || totalBytes > COPY_LIMITS.maxTotalBytes) {
    throw new FlowNoteError({
      code: "sourceTooLarge",
      params: { fullName: repository.fullName, limit: COPY_LIMITS.maxFiles },
    });
  }

  const paths = new Set(files.map((entry) => entry.path));
  for (const path of REQUIRED_SOURCE_FILES) {
    if (!paths.has(path)) {
      throw new FlowNoteError({
        code: "sourceMissingFile",
        params: { fullName: repository.fullName, path },
      });
    }
  }

  // Git LFS keeps pointer files in the repository and the content elsewhere; a copy of
  // the pointers builds an app whose images and fonts are three lines of text.
  if (paths.has(".gitattributes")) {
    const attributes = await deps.readFile(
      repository.owner,
      repository.name,
      ".gitattributes",
      tree.commitSha,
    );
    if (attributes && /filter=lfs/.test(attributes)) {
      throw new FlowNoteError({ code: "sourceUsesLfs", params: { fullName: repository.fullName } });
    }
  }

  const definitionText = await deps.readFile(
    repository.owner,
    repository.name,
    "public/haven-app.json",
    tree.commitSha,
  );
  let definitionJson: unknown;
  try {
    definitionJson = JSON.parse(definitionText ?? "");
  } catch {
    throw new FlowNoteError({ code: "sourceDefinitionInvalid", params: { fullName: repository.fullName } });
  }
  const { definition } = validateMindooDBAppDefinition(definitionJson);
  if (!definition) {
    throw new FlowNoteError({ code: "sourceDefinitionInvalid", params: { fullName: repository.fullName } });
  }

  const raw = definitionJson as Record<string, unknown>;
  return {
    owner: repository.owner,
    repo: repository.name,
    fullName: repository.fullName,
    htmlUrl: repository.htmlUrl,
    branch: repository.defaultBranch,
    commitSha: tree.commitSha,
    label: readLabel(raw),
    description: readDescription(raw) || details.description,
    databases: (definition.databases ?? []).map((database) => ({
      logicalDatabaseId: database.logicalDatabaseId,
      label: database.label ?? database.logicalDatabaseId,
    })),
    files,
    skippedPaths,
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The file as text, when it is text that survives a round trip unchanged.
 *
 * Text goes into the tree call inline, which saves one request per file; GitHub stores
 * it as UTF-8, so only bytes that *are* valid UTF-8 come back identical. A NUL byte is
 * the classic binary tell. `ignoreBOM` keeps a byte-order mark as content instead of
 * silently dropping it, which would change the file.
 */
export function bytesAsText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Text above this size goes through a blob anyway, to keep the tree request small. */
const MAX_INLINE_BYTES = 512 * 1024;

export interface CopySourceDependencies {
  /** Read one of the source's blobs, as base64. */
  readBlob: (sha: string) => Promise<string>;
  /** Store bytes in the target repository; returns the new blob's sha. */
  createBlob: (base64: string) => Promise<string>;
  /** Make the target branch exactly these files, as one parentless commit. */
  replaceBranch: (entries: ReplacementTreeEntry[], message: string) => Promise<string>;
  /** How many reads run at once. */
  concurrency?: number;
}

/** Copy every file of the source into the target branch, as one commit. */
export async function copySourceFiles(
  source: AppSource,
  deps: CopySourceDependencies,
): Promise<{ fileCount: number; commitSha: string }> {
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  const entries: ReplacementTreeEntry[] = new Array(source.files.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < source.files.length) {
      const index = next;
      next += 1;
      const file = source.files[index];
      const base64 = await deps.readBlob(file.sha);
      const bytes = base64ToBytes(base64);
      const text = bytes.length <= MAX_INLINE_BYTES ? bytesAsText(bytes) : null;
      entries[index] =
        text === null
          ? { path: file.path, mode: file.mode, sha: await deps.createBlob(base64) }
          : { path: file.path, mode: file.mode, content: text };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, source.files.length) }, worker));

  const commitSha = await deps.replaceBranch(
    entries,
    `Copy of ${source.fullName} at ${source.commitSha.slice(0, 7)}`,
  );
  return { fileCount: entries.length, commitSha };
}
