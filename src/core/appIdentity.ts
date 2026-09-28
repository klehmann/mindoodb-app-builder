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
 * The id a generated app's code opens its database by.
 *
 * The same for every app on purpose. The app addresses the database by this logical id
 * and never learns the physical one, which Haven maps per installation — so the physical
 * id can be unique per app (and changed later in the app's settings in Haven) without a
 * line of the app's code knowing.
 */
export const DEFAULT_LOGICAL_DATABASE_ID = "main";

/** Length of the random part that makes a physical database id unique. */
export const DATABASE_SUFFIX_LENGTH = 6;

/**
 * Permissions a generated app can request on its one database. Matches Haven's
 * mapping permissions (`MINDOODB_APP_MAPPING_PERMISSIONS`) — `proposeapps` is
 * registration-level and does not belong here. Read is implied by the mapping
 * existing. `sign` / `timestamps` / `sealedchannel` stay off until the app
 * actually needs them.
 */
export const APP_DATABASE_PERMISSIONS = [
  "write",
  "delete",
  "history",
  "attachments",
  "views",
  "sign",
  "timestamps",
  "directory",
  "sealedchannel",
] as const;

export type AppDatabasePermission = (typeof APP_DATABASE_PERMISSIONS)[number];

export const DEFAULT_APP_DATABASE_PERMISSIONS: readonly AppDatabasePermission[] = [
  "write",
  "delete",
  "history",
  "attachments",
  "views",
  "directory",
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
  /**
   * The random part of the physical database ids, chosen once per app. Without it the
   * ids fall back to the old `app_<slug>`, which is what apps built before it still use.
   */
  databaseSuffix?: string;
  /** Set when the app starts from an existing app's code rather than the starter. */
  copiedFrom?: AppCopySource;
  /**
   * Written into `haven-app.json` as `source.repository`, so the app's address is enough
   * to find its code again. Only for public repositories: for a private one the URL would
   * publish the owner and name of something nobody else can open.
   */
  sourceRepositoryUrl?: string;
}

/** What an app copy needs to know about the app it was copied from. */
export interface AppCopySource {
  fullName: string;
  htmlUrl: string;
  commitSha: string;
  /** The logical ids the source's code opens. They stay; only the physical ids change. */
  databases: Array<{ logicalDatabaseId: string; label: string }>;
}

export interface ResolvedAppDatabase {
  /** The id the app's code opens. */
  logicalId: string;
  /** The physical id suggested to Haven. */
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

/**
 * A random `[a-z0-9]` suffix for physical database ids.
 *
 * The slug alone is only as unique as a repository name: two people in one tenant can
 * both build a "team-poll", and with `app_team-poll` for both, the second install would
 * open the first one's data.
 */
export function randomDatabaseSuffix(length = DATABASE_SUFFIX_LENGTH): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * The physical id for one of an app's databases: `app_<slug>_<suffix>`, or, for an app
 * with several, `app_<slug>_<logical>_<suffix>` so they stay apart. The slug part is cut
 * first when it does not fit, so the suffix — the part that makes it unique — survives.
 */
export function physicalDatabaseId(
  slug: string,
  suffix: string,
  logicalDatabaseId?: string,
): string {
  const clean = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/[-._]+$/, "");
  const tail = [logicalDatabaseId ? clean(logicalDatabaseId) : "", suffix]
    .filter(Boolean)
    .join("_");
  const room = MAX_DATABASE_ID_LENGTH - APP_DATABASE_ID_PREFIX.length - tail.length - 1;
  const body = clean(slug).slice(0, Math.max(0, room)).replace(/[-._]+$/, "");
  return `${APP_DATABASE_ID_PREFIX}${body ? `${body}_` : ""}${tail}`;
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
  const suffix = identity.databaseSuffix?.trim();
  const id =
    identity.databaseId?.trim() ||
    (suffix ? physicalDatabaseId(slug, suffix) : databaseIdFromSlug(slug));
  const label = identity.databaseLabel?.trim() || identity.label.trim() || slug;
  const permissions = identity.databasePermissions
    ? [...identity.databasePermissions]
    : [...DEFAULT_APP_DATABASE_PERMISSIONS];
  return { logicalId: DEFAULT_LOGICAL_DATABASE_ID, id, label, permissions };
}

/**
 * The physical ids a copy's databases get: one each, all new, all unique.
 *
 * Keyed by logical id, which the copied code keeps using. A single database gets the
 * short form, like a new app's.
 */
export function copiedDatabaseIds(identity: AppIdentity): Map<string, string> {
  const slug = identity.slug.trim() || slugifyAppName(identity.label);
  const suffix = identity.databaseSuffix?.trim() || randomDatabaseSuffix();
  const databases = identity.copiedFrom?.databases ?? [];
  return new Map(
    databases.map((database) => [
      database.logicalDatabaseId,
      physicalDatabaseId(
        slug,
        suffix,
        databases.length > 1 ? database.logicalDatabaseId : undefined,
      ),
    ]),
  );
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
 *
 * The one exception is a copied app whose configuration names where it is deployed —
 * `routes`, `route` or `account_id`. Those belong to the original: kept, the copy's
 * first deploy would try to take over the original's domain, or land in an account that
 * is not the user's. They are removed, and only then is the file rewritten as plain JSON.
 */
export function patchWranglerConfig(source: string, identity: AppIdentity): string {
  const namePattern = /("name"\s*:\s*")([^"]*)(")/;
  if (!namePattern.test(source)) {
    throw new Error('wrangler.jsonc does not contain a "name" field to rename.');
  }
  const renamed = source.replace(namePattern, `$1${identity.slug}$3`);
  if (!identity.copiedFrom || !DEPLOYMENT_TARGET_PATTERN.test(stripJsonComments(renamed))) {
    return renamed;
  }
  const parsed = JSON.parse(stripJsonComments(renamed)) as Record<string, unknown>;
  for (const key of DEPLOYMENT_TARGET_KEYS) {
    delete parsed[key];
  }
  return reindentJson(parsed);
}

const DEPLOYMENT_TARGET_KEYS = ["routes", "route", "account_id"] as const;
const DEPLOYMENT_TARGET_PATTERN = /"(routes|route|account_id)"\s*:/;

/**
 * JSONC to JSON: drop comments and trailing commas, leave strings alone. Enough for a
 * wrangler file; not a general JSON5 reader.
 */
export function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const nextChar = source[index + 1];
    if (inString) {
      result += char;
      if (char === "\\") {
        result += nextChar ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && nextChar === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      result += "\n";
    } else if (char === "/" && nextChar === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
    } else {
      result += char;
    }
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Stamp the app identity onto `haven-app.json`, including the per-app database and
 * hosted-bundle mode. Generated apps must not share the template's `main` store, and
 * Haven should serve the Vite `haven-bundle.zip` rather than keep the Worker as the
 * live origin.
 *
 * The database is declared the way every generated app declares it: the fixed logical
 * id `main`, which the code opens, and a unique physical id Haven is asked to use.
 */
export function patchAppDefinition(source: string, identity: AppIdentity): string {
  if (identity.copiedFrom) {
    return patchCopiedAppDefinition(source, identity);
  }
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const database = resolveAppDatabase(identity);
  parsed.appId = identity.slug;
  parsed.label = identity.label;
  parsed.hosting = "hosted";
  parsed.defaultLaunchDatabaseId = database.logicalId;
  parsed.databases = [
    {
      logicalDatabaseId: database.logicalId,
      label: database.label,
      databaseId: database.id,
      permissions: database.permissions,
    },
  ];
  applyDescription(parsed, identity);
  applySourceRepository(parsed, identity);
  return reindentJson(parsed);
}

/**
 * The copy of an existing app's definition, made this app's own.
 *
 * Kept: everything the source's code relies on — its logical database ids, their
 * permissions, how it is hosted, what it may reach. Replaced: the name, the id, and the
 * physical database ids, which are new so the copy starts with empty databases of its
 * own. Someone who wants the original's data points the mapping at it in Haven's app
 * settings; the code does not change, because it only ever sees the logical ids.
 */
function patchCopiedAppDefinition(source: string, identity: AppIdentity): string {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const physicalIds = copiedDatabaseIds(identity);
  parsed.appId = identity.slug;
  parsed.label = identity.label;
  if (Array.isArray(parsed.databases)) {
    parsed.databases = parsed.databases.map((entry) => {
      if (!isRecord(entry) || typeof entry.logicalDatabaseId !== "string") {
        return entry;
      }
      const databaseId = physicalIds.get(entry.logicalDatabaseId);
      return databaseId ? { ...entry, databaseId } : entry;
    });
  }
  applyDescription(parsed, identity);
  applySourceRepository(parsed, identity);
  return reindentJson(parsed);
}

function applyDescription(parsed: Record<string, unknown>, identity: AppIdentity): void {
  if (identity.description) {
    parsed.description = identity.description;
  } else {
    delete parsed.description;
  }
  // The listing is what the app's landing page and Haven's setup wizard show. The
  // template's summary describes the template, so it is replaced by the user's own
  // description or dropped; the icon and anything else in the listing stay.
  const listing = isRecord(parsed.listing) ? { ...parsed.listing } : null;
  if (listing) {
    if (identity.description) {
      listing.summary = identity.description;
    } else {
      delete listing.summary;
    }
    parsed.listing = listing;
  }
}

/**
 * `source.repository` names this app's own repository, or is removed. A copied
 * definition still carries the original's, and leaving it would send the next person
 * who copies this app to the wrong code.
 */
function applySourceRepository(parsed: Record<string, unknown>, identity: AppIdentity): void {
  const source = isRecord(parsed.source) ? { ...parsed.source } : {};
  if (identity.sourceRepositoryUrl) {
    source.repository = identity.sourceRepositoryUrl;
  } else {
    delete source.repository;
  }
  if (Object.keys(source).length > 0) {
    parsed.source = source;
  } else {
    delete parsed.source;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The agent's brief.
 *
 * Only the user's own words go in here. No tokens, no database contents, no host
 * details — this text is sent to a third-party VM.
 */
export function renderTaskMarkdown(identity: AppIdentity): string {
  if (identity.copiedFrom) {
    return renderCopiedTaskMarkdown(identity, identity.copiedFrom);
  }
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
    `- The app opens its database by the logical id \`${database.logicalId}\` (see \`public/haven-app.json\`). Haven maps it to the physical database; never use the physical id in code.`,
  );
  lines.push(
    "- Keep `public/haven-app.json` in step with the databases the app actually uses.",
  );
  lines.push("- Prefer finishing one working screen over scaffolding several unfinished ones.");
  lines.push("");

  return lines.join("\n");
}

function renderCopiedTaskMarkdown(identity: AppIdentity, copiedFrom: AppCopySource): string {
  const lines = [`# ${identity.label}`, ""];

  if (identity.description) {
    lines.push(identity.description, "");
  }

  lines.push("## Starting point", "");
  lines.push(
    `This app is a copy of [${copiedFrom.fullName}](${copiedFrom.htmlUrl}) at commit \`${copiedFrom.commitSha.slice(0, 7)}\`. ` +
      "The code already works. Build on it instead of starting over, and keep what the task below does not ask to change.",
    "",
  );
  lines.push("## What should change", "");
  lines.push(identity.task.trim() || "_Nothing described yet._", "");
  lines.push("## Notes", "");
  lines.push("- Read `AGENTS.md` first if the repository has one; it lists the SDK docs and the invariants.");
  if (copiedFrom.databases.length > 0) {
    const ids = copiedFrom.databases.map((database) => `\`${database.logicalDatabaseId}\``).join(", ");
    lines.push(
      `- The app opens its databases by their logical ids (${ids}). Keep using those; Haven maps them to this app's own physical databases.`,
    );
  }
  lines.push(
    "- Keep `public/haven-app.json` in step with the databases the app actually uses.",
  );
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
