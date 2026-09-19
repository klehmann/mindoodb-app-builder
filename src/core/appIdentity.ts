/**
 * Turning "Team Notes" into an app.
 *
 * A generated repository starts as a byte-for-byte copy of the starter template, so
 * every file still calls the app `mindoodb-app-starter`. Four places carry the app's
 * identity and have to agree with each other, because each is read by a different
 * system:
 *
 * | File                    | Read by                                            |
 * | ----------------------- | -------------------------------------------------- |
 * | `package.json`          | pnpm, and the bundle manifest's default `appId`     |
 * | `wrangler.jsonc`        | Cloudflare — the Worker name decides the live URL   |
 * | `public/haven-app.json` | Haven, when a user installs the app                |
 * | `TASK.md`               | the coding agent                                    |
 *
 * Everything here is a pure string transform so the rules are testable without a
 * network: the orchestration in `createApp.ts` fetches the template's current text,
 * runs it through these functions, and commits the result in one commit.
 */

/** Cloudflare Worker names, and therefore our repository slugs: `[a-z0-9-]`, max 63. */
const MAX_SLUG_LENGTH = 63;

/**
 * MindooDB database ids for a *new* store: lowercase `[a-z0-9._-]`, first character
 * alphanumeric, max 64. Mirrors Haven/`mindoodb` `NEW_DATABASE_ID_REGEX`.
 */
export const MAX_DATABASE_ID_LENGTH = 64;
const NEW_DATABASE_ID_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
/** So generated apps do not all land in the tenant's `main` database. */
export const APP_DATABASE_ID_PREFIX = "app_";

/**
 * Permissions a generated app asks for on its one database. Read is implied by the
 * mapping existing. `sign` / `timestamps` / `sealedchannel` stay off until the app
 * actually needs them.
 */
export const APP_DATABASE_PERMISSIONS = [
  "write",
  "delete",
  "history",
  "attachments",
  "views",
  "directory",
] as const;

export type AppDatabasePermission = (typeof APP_DATABASE_PERMISSIONS)[number];

export const DEFAULT_APP_DATABASE_PERMISSIONS: readonly AppDatabasePermission[] = [
  ...APP_DATABASE_PERMISSIONS,
];

export interface AppIdentity {
  /** What the user typed, shown as the app label in Haven. */
  label: string;
  /** Repository name, Worker name, and `appId` — all the same slug, on purpose. */
  slug: string;
  /** The user's one-line description. May be empty. */
  description: string;
  /** The user's full task text, written into `TASK.md`. May be empty. */
  task: string;
  /**
   * Logical (and suggested physical) database id. Defaults to `app_<slug>`, truncated
   * to {@link MAX_DATABASE_ID_LENGTH}.
   */
  databaseId?: string;
  /** Readable database name shown in Haven. Defaults to the app label. */
  databaseLabel?: string;
  /** Requested mapping permissions. Defaults to {@link DEFAULT_APP_DATABASE_PERMISSIONS}. */
  databasePermissions?: readonly AppDatabasePermission[];
}

export interface ResolvedAppDatabase {
  id: string;
  label: string;
  permissions: AppDatabasePermission[];
}

/**
 * Derive a slug that is valid as a GitHub repository name *and* a Cloudflare Worker
 * name at once. The Worker name is the stricter of the two and it decides the public
 * URL, so it wins: lowercase, digits, and single dashes only.
 */
export function slugifyAppName(name: string): string {
  const slug = name
    .normalize("NFKD")
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/, "");

  return slug || "mindoodb-app";
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug) && slug.length <= MAX_SLUG_LENGTH;
}

/**
 * Derive a new-database id from a Worker/repo slug: `app_` plus the slug, cut to 64
 * characters so a 63-character Worker name still produces a legal MindooDB id.
 */
export function databaseIdFromSlug(slug: string): string {
  const maxBody = MAX_DATABASE_ID_LENGTH - APP_DATABASE_ID_PREFIX.length;
  const body = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, maxBody)
    .replace(/[-.]+$/, "");

  return body ? `${APP_DATABASE_ID_PREFIX}${body}` : "";
}

export function isValidDatabaseId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_DATABASE_ID_LENGTH &&
    NEW_DATABASE_ID_REGEX.test(id) &&
    !id.endsWith(".")
  );
}

/** Lowercase while typing, matching Haven's create-database field. */
export function normalizeDatabaseIdInput(value: string): string {
  return value.toLowerCase();
}

/** Fill in the database the generated app will declare, using the identity defaults. */
export function resolveAppDatabase(identity: AppIdentity): ResolvedAppDatabase {
  const slug = identity.slug.trim() || slugifyAppName(identity.label);
  const id = identity.databaseId?.trim() || databaseIdFromSlug(slug);
  const label = identity.databaseLabel?.trim() || identity.label.trim() || slug;
  const permissions = identity.databasePermissions
    ? [...identity.databasePermissions]
    : [...DEFAULT_APP_DATABASE_PERMISSIONS];
  return { id, label, permissions };
}

/** The workers.dev URL a Worker will get, so the UI can show it before it is live. */
export function workersDevUrl(slug: string, accountSubdomain: string): string {
  return `https://${slug}.${accountSubdomain}.workers.dev`;
}

function reindentJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Set `name` and `description` in the template's package.json. */
export function patchPackageJson(source: string, identity: AppIdentity): string {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  parsed.name = identity.slug;
  if (identity.description) {
    parsed.description = identity.description;
  }
  return reindentJson(parsed);
}

/**
 * Set the Worker name in `wrangler.jsonc`.
 *
 * Text substitution rather than parse-and-serialize: the file is JSONC and its comments
 * explain why `not_found_handling` is what it is. Round-tripping through `JSON.parse`
 * would delete that explanation, and the next person would "fix" the setting.
 */
export function patchWranglerConfig(source: string, identity: AppIdentity): string {
  const namePattern = /("name"\s*:\s*")([^"]*)(")/;
  if (!namePattern.test(source)) {
    throw new Error('wrangler.jsonc does not contain a "name" field to rename.');
  }
  return source.replace(namePattern, `$1${identity.slug}$3`);
}

/**
 * Stamp the app identity onto `haven-app.json`, including the per-app database and
 * hosted-bundle mode. Generated apps must not share the template's `main` store, and
 * Haven should serve the Vite `haven-bundle.zip` rather than keep the Worker as the
 * live origin.
 */
export function patchAppDefinition(source: string, identity: AppIdentity): string {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const database = resolveAppDatabase(identity);
  parsed.appId = identity.slug;
  parsed.label = identity.label;
  parsed.hosting = "hosted";
  parsed.defaultLaunchDatabaseId = database.id;
  parsed.databases = [
    {
      logicalDatabaseId: database.id,
      label: database.label,
      permissions: database.permissions,
    },
  ];
  if (identity.description) {
    parsed.description = identity.description;
  } else {
    delete parsed.description;
  }
  return reindentJson(parsed);
}

/**
 * The agent's brief.
 *
 * Only the user's own words go in here. No tokens, no database contents, no host
 * details — this text is sent to a third-party VM.
 */
export function renderTaskMarkdown(identity: AppIdentity): string {
  const lines = [`# ${identity.label}`, ""];

  if (identity.description) {
    lines.push(identity.description, "");
  }

  lines.push("## What this app should do", "");
  lines.push(identity.task.trim() || "_Not described yet._", "");
  lines.push("## Notes", "");
  const database = resolveAppDatabase(identity);
  lines.push("- Read `AGENTS.md` first; it lists the SDK docs and the invariants.");
  lines.push(
    `- The app's database is \`${database.id}\` (see \`public/haven-app.json\`). Open that id, not \`main\`.`,
  );
  lines.push(
    "- Keep `public/haven-app.json` in step with the databases the app actually uses.",
  );
  lines.push("- Prefer finishing one working screen over scaffolding several unfinished ones.");
  lines.push("");

  return lines.join("\n");
}

export interface TemplateSources {
  packageJson: string;
  wranglerConfig: string;
  appDefinition: string;
}

export interface IdentityFileChange {
  path: string;
  content: string;
}

/**
 * The full set of files that make a generated repository *this* app, ready to be sent
 * as a single commit.
 */
export function buildIdentityFiles(
  sources: TemplateSources,
  identity: AppIdentity,
): IdentityFileChange[] {
  return [
    { path: "package.json", content: patchPackageJson(sources.packageJson, identity) },
    { path: "wrangler.jsonc", content: patchWranglerConfig(sources.wranglerConfig, identity) },
    {
      path: "public/haven-app.json",
      content: patchAppDefinition(sources.appDefinition, identity),
    },
    { path: "TASK.md", content: renderTaskMarkdown(identity) },
  ];
}
