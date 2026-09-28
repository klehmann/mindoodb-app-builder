/**
 * Where the builder keeps the user's GitHub, Cloudflare, and Cursor tokens.
 *
 * All three live in **one recipient-sealed MindooDB document** in the builder's own
 * database. Sealed means person-bound: the payload is encrypted for named users rather
 * than with the database's default shared key, so even a builder database shared with a
 * whole team keeps the tokens readable only by the person who entered them. The
 * ciphertext syncs like any other document, which is how the credentials follow the user
 * to their next device without a server-side vault.
 *
 * The document is created with `[]` recipients and `includeSelf: true` — the host adds
 * the launching user and nobody else can be added by accident. Every further reader is
 * one the user named on purpose, in the setup page's sharing list, and each of them can
 * read live API tokens: that is the whole point of sharing them, and the page says so.
 * Removing a reader rotates the document key, so they miss later changes but keep the
 * tokens they already saw — the page says that too.
 *
 * The builder host never sees this document. The app decrypts in the browser and hands
 * a single token to the host for a single job (see `src/host/`).
 */
import { createViewLanguage, type MindooDBAppDatabase } from "mindoodb-app-sdk";

import { activeRecipients, otherRecipients, recipientDiff } from "./sealedRecipients";

/**
 * Prefix for the random id MindooDB generates for a credential document.
 *
 * The document cannot have a fixed id: MindooDB refuses `recipients` together with a
 * caller-provided id, because such an id is *convergent* — two replicas creating it
 * share Automerge ancestry — while sealing needs a per-document key that cannot be
 * derived that way. So the id is the host's, and the document is found by querying for
 * its `type` (see {@link findCredentialsDocument}).
 */
const CREDENTIALS_ID_PREFIX = "cred";

/** Marks the document for humans reading the database, and is how the app finds it. */
export const CREDENTIALS_DOCUMENT_TYPE = "mindoodb.appbuilder.credentials";

/**
 * Field holding the tokens.
 *
 * Nested on purpose. MindooDB's summary buffer auto-includes every *scalar* top-level
 * field, so top-level tokens would be copied into that local index; a nested object is
 * only indexed when a summary configuration asks for it by path. Keeping `type` and
 * `updatedAt` at the top level is what makes the document queryable, and keeping the
 * tokens one level down keeps them in the encrypted payload only.
 */
const SECRETS_FIELD = "secrets";

const v = createViewLanguage<Record<string, unknown>>();

export interface BuilderCredentials {
  /**
   * GitHub token. Either a user access token from the device flow (`ghu_…`, the normal
   * case) or a personal access token the user pasted, which needs `repo` scope
   * (classic) or Contents + Administration write (fine-grained). Both are used the same
   * way, so nothing downstream has to know which one it got.
   */
  githubToken: string;
  /** GitHub login the repositories are created under. Blank means the token's own user. */
  githubOwner: string;
  /**
   * Cloudflare token. Either an OAuth access token from the connect flow or a pasted
   * API token, which must be **user-scoped** — the Workers Builds API rejects
   * account-scoped tokens — with `Workers Builds Configuration: Edit` and
   * `Workers Scripts: Edit`.
   */
  cloudflareToken: string;
  /**
   * Refresh token, set only by the OAuth flow. Its presence is also how the UI knows a
   * Cloudflare connection can be renewed rather than re-entered.
   */
  cloudflareRefreshToken: string;
  /** Epoch milliseconds, or 0 when the token does not expire (a pasted API token). */
  cloudflareExpiresAt: number;
  cloudflareAccountId: string;
  /** Cursor API key (`crsr_…`) used to launch cloud agents. */
  cursorToken: string;

  /*
   * The two fields below are not secrets. They live in this document anyway, and
   * deliberately at its *top level* rather than inside `secrets`: the setup state is
   * per-person just like the tokens are, so it belongs to the same per-user document —
   * and putting it in a second document would mean a second query on every launch to
   * answer "has this user finished setting up?".
   */

  /**
   * When the user last said their one-time setup is done. Empty means never.
   *
   * This is a *claim*, not a check. Whether Cloudflare's GitHub App can read a
   * repository, or whether Cursor was pointed at one, cannot be read back from any token
   * we hold — so the builder records that the user went through the setup and then
   * trusts it. A run that fails because a grant is missing reports that and offers the
   * setup again, which is cheaper for everyone than a detection that cannot work.
   */
  setupCompletedAt: string;
  /**
   * Whether the user chose to grant Cloudflare and Cursor access to all repositories.
   *
   * `all` is the one that makes every later app a single button: a repository created
   * next month is covered by an installation that already says "all". `selected` means
   * the user keeps that choice per repository, so each new app needs two grants added by
   * hand — the builder still supports it, it just cannot be quiet about it. Empty means
   * they have not been asked yet.
   */
  repoAccess: "all" | "selected" | "";
}

export const EMPTY_CREDENTIALS: BuilderCredentials = {
  githubToken: "",
  githubOwner: "",
  cloudflareToken: "",
  cloudflareRefreshToken: "",
  cloudflareExpiresAt: 0,
  cloudflareAccountId: "",
  cursorToken: "",
  setupCompletedAt: "",
  repoAccess: "",
};

/** Which credentials are present, for a UI that shows what still needs connecting. */
export interface CredentialsStatus {
  github: boolean;
  cloudflare: boolean;
  cursor: boolean;
}

export function readCredentialsStatus(credentials: BuilderCredentials): CredentialsStatus {
  return {
    github: credentials.githubToken.trim() !== "",
    cloudflare:
      credentials.cloudflareToken.trim() !== "" && credentials.cloudflareAccountId.trim() !== "",
    cursor: credentials.cursorToken.trim() !== "",
  };
}

/**
 * Whether the builder can go straight to building apps.
 *
 * Both tokens *and* the user's own "I am done" are required. The tokens alone are not
 * enough: the grants that make a new repository buildable — Cloudflare's GitHub App,
 * Cursor's — are invisible from here, so a user who pasted a token but never installed
 * anything would get a run that dies at the first build with no idea why. The claim is
 * what closes that gap.
 */
export function isSetupComplete(credentials: BuilderCredentials): boolean {
  const status = readCredentialsStatus(credentials);
  return status.github && status.cloudflare && credentials.setupCompletedAt !== "";
}

function readString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * True when an OAuth access token is expired or close enough that the next call would
 * race the expiry. The margin is generous on purpose: refreshing early costs one request
 * and a failed deploy costs the user a restart.
 */
export function isCloudflareTokenStale(
  credentials: BuilderCredentials,
  now = Date.now(),
): boolean {
  if (credentials.cloudflareExpiresAt === 0) {
    return false;
  }
  return credentials.cloudflareExpiresAt - now < 60_000;
}

/** Map a stored document body onto the credential shape, ignoring anything else in it. */
export function credentialsFromDocumentData(
  body: Record<string, unknown> | undefined,
): BuilderCredentials {
  if (!body) {
    return { ...EMPTY_CREDENTIALS };
  }
  // Tokens live under `secrets`; a document written by an earlier build has them at the
  // top level, so both shapes read back rather than silently logging the user out.
  const nested = body[SECRETS_FIELD];
  const data =
    nested !== null && typeof nested === "object" ? (nested as Record<string, unknown>) : body;
  const repoAccess = readString(body, "repoAccess");
  return {
    setupCompletedAt: readString(body, "setupCompletedAt"),
    // Anything unexpected reads as "not asked yet", which only means the setup page
    // asks again — the safe direction.
    repoAccess: repoAccess === "all" || repoAccess === "selected" ? repoAccess : "",
    githubToken: readString(data, "githubToken"),
    githubOwner: readString(data, "githubOwner"),
    cloudflareToken: readString(data, "cloudflareToken"),
    cloudflareRefreshToken: readString(data, "cloudflareRefreshToken"),
    cloudflareExpiresAt: readNumber(data, "cloudflareExpiresAt"),
    cloudflareAccountId: readString(data, "cloudflareAccountId"),
    cursorToken: readString(data, "cursorToken"),
  };
}

/** Credentials plus the document they came from, so a later save updates that one. */
export interface LoadedCredentials {
  credentials: BuilderCredentials;
  documentId: string | null;
  /** Everyone besides the launching user who can read this document. */
  sharedWith: string[];
}

/** How many candidates to look at when choosing between a shared and a private document. */
const CANDIDATE_LIMIT = 10;

/**
 * Which of several readable credential documents to use: the newest one shared with
 * other people, else the newest one.
 *
 * Shared first, because sharing is a deliberate act and it is what makes a team work
 * from one set of accounts: someone who is added to a colleague's settings uses them,
 * rather than whichever of the two documents happened to be saved last. A person who
 * wants their own again asks to be taken off the list. `candidates` are newest first.
 */
export function chooseCredentialsDocument<T extends { data: Record<string, unknown> | undefined }>(
  candidates: readonly T[],
): T | null {
  return (
    candidates.find((candidate) => activeRecipients(candidate.data).length > 1) ??
    candidates[0] ??
    null
  );
}

/**
 * Find this user's credential document.
 *
 * The lookup is a plain `type` query, and it needs no "which user" clause: MindooDB
 * only summarizes a sealed document on a replica that can decrypt it, so another user's
 * credential document is not in this user's summary buffer and cannot match. The newest
 * match wins, so a duplicate left behind by an interrupted save is ignored rather than
 * resurrected.
 */
export async function findCredentialsDocument(
  database: MindooDBAppDatabase,
): Promise<string | null> {
  return (await readCredentialsDocument(database))?.documentId ?? null;
}

/** The chosen credential document, read. See {@link chooseCredentialsDocument}. */
async function readCredentialsDocument(
  database: MindooDBAppDatabase,
): Promise<{ documentId: string; data: Record<string, unknown> | undefined } | null> {
  const result = await database.documents.query({
    filter: v.eq(v.field("type"), CREDENTIALS_DOCUMENT_TYPE),
    sortBy: [{ field: "_lastModified", direction: "descending" }],
    // The tokens are not summarized, but there is no reason to ship any field at all.
    fields: ["type"],
    limit: CANDIDATE_LIMIT,
  });
  const candidates = await Promise.all(
    result.rows.map(async (row) => {
      const document = await database.documents.get(row.docId);
      return document ? { documentId: row.docId, data: document.data } : null;
    }),
  );
  return chooseCredentialsDocument(
    candidates.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  );
}

/**
 * Read this user's sealed credential document, or return empty credentials when they
 * have none yet.
 *
 * Failures are reported as empty rather than thrown: a missing document, a summary
 * still backfilling, or a database without `read` all mean the same thing to the user —
 * the builder opens unconnected and they connect their accounts.
 */
export async function loadCredentials(
  database: MindooDBAppDatabase,
  /** The launching user, so the sharing list can leave them out. */
  self = "",
): Promise<LoadedCredentials> {
  try {
    const found = await readCredentialsDocument(database);
    if (!found) {
      return { credentials: { ...EMPTY_CREDENTIALS }, documentId: null, sharedWith: [] };
    }
    return {
      credentials: credentialsFromDocumentData(found.data),
      documentId: found.documentId,
      sharedWith: otherRecipients(found.data, self),
    };
  } catch {
    return { credentials: { ...EMPTY_CREDENTIALS }, documentId: null, sharedWith: [] };
  }
}

/**
 * Make `next` the list of people, besides the launching user, who can read the
 * credential document. Returns who can read it afterwards.
 *
 * Adding wraps the document key for the new readers, who can then read its whole
 * history. Removing rotates the key: the removed reader cannot read later changes, but
 * keeps whatever tokens they already had — which is why the page tells the user to
 * reconnect after taking someone off.
 */
export async function shareCredentials(
  database: MindooDBAppDatabase,
  documentId: string,
  current: readonly string[],
  next: readonly string[],
  self = "",
): Promise<string[]> {
  const { added, removed } = recipientDiff(current, next);
  let document = null;
  if (added.length > 0) {
    document = await database.documents.addRecipients(documentId, added);
  }
  if (removed.length > 0) {
    document = await database.documents.removeRecipients(documentId, removed);
  }
  return document ? otherRecipients(document.data, self) : [...current];
}

/**
 * Write the credentials into this user's sealed document, creating it on first use, and
 * return the document id to reuse for the next save.
 *
 * The id is left to MindooDB (`idPrefix`), which is what makes sealing legal here.
 */
export async function saveCredentials(
  database: MindooDBAppDatabase,
  credentials: BuilderCredentials,
  documentId?: string | null,
): Promise<string> {
  const set: Record<string, unknown> = {
    type: CREDENTIALS_DOCUMENT_TYPE,
    updatedAt: new Date().toISOString(),
    setupCompletedAt: credentials.setupCompletedAt.trim(),
    repoAccess: credentials.repoAccess,
    [SECRETS_FIELD]: {
      githubToken: credentials.githubToken.trim(),
      githubOwner: credentials.githubOwner.trim(),
      cloudflareToken: credentials.cloudflareToken.trim(),
      cloudflareRefreshToken: credentials.cloudflareRefreshToken.trim(),
      cloudflareExpiresAt: credentials.cloudflareExpiresAt,
      cloudflareAccountId: credentials.cloudflareAccountId.trim(),
      cursorToken: credentials.cursorToken.trim(),
    },
  };

  const existingId = documentId ?? (await findCredentialsDocument(database));
  if (existingId) {
    await database.documents.update(existingId, { set });
    return existingId;
  }

  const created = await database.documents.create({
    idPrefix: CREDENTIALS_ID_PREFIX,
    set,
    // Sealed to the launching user alone. Readers are added later, only on request.
    recipients: [],
    recipientOptions: { includeSelf: true },
  });
  return created.id;
}

/** Overwrite every token, for a "disconnect all" action. */
export async function clearCredentials(
  database: MindooDBAppDatabase,
  documentId?: string | null,
): Promise<string> {
  return await saveCredentials(database, { ...EMPTY_CREDENTIALS }, documentId);
}
