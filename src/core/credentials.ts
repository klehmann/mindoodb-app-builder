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
 * The recipient list is `[]` with `includeSelf: true` — the host adds the launching user
 * and nobody else can be added by accident. This is deliberate and load-bearing: a
 * second recipient would mean a second person who can read live API tokens.
 *
 * The builder host never sees this document. The app decrypts in the browser and hands
 * a single token to the host for a single job (see `src/host/`).
 */
import type { MindooDBAppDatabase } from "mindoodb-app-sdk";

/** Fixed document id, so the app can load the credentials without building a view. */
export const CREDENTIALS_DOCUMENT_ID = "builder_credentials";

/** Marks the document for humans reading the database in Haven. */
export const CREDENTIALS_DOCUMENT_TYPE = "mindoodb.appbuilder.credentials";

export interface BuilderCredentials {
  /**
   * GitHub personal access token. Needs `repo` scope (classic) or Contents +
   * Administration write (fine-grained) to create a repository from a template.
   */
  githubToken: string;
  /** GitHub login the repositories are created under. Blank means the token's own user. */
  githubOwner: string;
  /**
   * Cloudflare API token. Must be **user-scoped**: the Workers Builds API rejects
   * account-scoped tokens. Needs `Workers Builds Configuration: Edit` and
   * `Workers Scripts: Read` (plus `Workers Scripts: Edit` to create the Worker).
   */
  cloudflareToken: string;
  cloudflareAccountId: string;
  /** Cursor API key (`crsr_…`) used to launch cloud agents. */
  cursorToken: string;
}

export const EMPTY_CREDENTIALS: BuilderCredentials = {
  githubToken: "",
  githubOwner: "",
  cloudflareToken: "",
  cloudflareAccountId: "",
  cursorToken: "",
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

function readString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Map a stored document body onto the credential shape, ignoring anything else in it. */
export function credentialsFromDocumentData(
  data: Record<string, unknown> | undefined,
): BuilderCredentials {
  if (!data) {
    return { ...EMPTY_CREDENTIALS };
  }
  return {
    githubToken: readString(data, "githubToken"),
    githubOwner: readString(data, "githubOwner"),
    cloudflareToken: readString(data, "cloudflareToken"),
    cloudflareAccountId: readString(data, "cloudflareAccountId"),
    cursorToken: readString(data, "cursorToken"),
  };
}

/**
 * Read the sealed credential document, or return empty credentials when it does not
 * exist yet.
 *
 * A document that exists but cannot be decrypted (someone else's copy in a shared
 * database) is reported as empty rather than as an error: the user can simply store
 * their own, and the document id is per-user in practice because each user's replica
 * holds their own sealed copy.
 */
export async function loadCredentials(
  database: MindooDBAppDatabase,
): Promise<BuilderCredentials> {
  try {
    const document = await database.documents.get(CREDENTIALS_DOCUMENT_ID);
    return credentialsFromDocumentData(document?.data);
  } catch {
    return { ...EMPTY_CREDENTIALS };
  }
}

/**
 * Write the credentials back into the sealed document, creating it on first use.
 *
 * `create({ id })` is idempotent create-if-missing and does NOT apply `set` to an
 * existing document, so the update call after it is what actually persists a change.
 */
export async function saveCredentials(
  database: MindooDBAppDatabase,
  credentials: BuilderCredentials,
): Promise<void> {
  const set: Record<string, unknown> = {
    type: CREDENTIALS_DOCUMENT_TYPE,
    githubToken: credentials.githubToken.trim(),
    githubOwner: credentials.githubOwner.trim(),
    cloudflareToken: credentials.cloudflareToken.trim(),
    cloudflareAccountId: credentials.cloudflareAccountId.trim(),
    cursorToken: credentials.cursorToken.trim(),
    updatedAt: new Date().toISOString(),
  };

  await database.documents.create({
    id: CREDENTIALS_DOCUMENT_ID,
    set,
    // Sealed to the launching user alone. Never add recipients here.
    recipients: [],
    recipientOptions: { includeSelf: true },
  });

  await database.documents.update(CREDENTIALS_DOCUMENT_ID, { set });
}

/** Overwrite every token, for a "disconnect all" action. */
export async function clearCredentials(database: MindooDBAppDatabase): Promise<void> {
  await saveCredentials(database, { ...EMPTY_CREDENTIALS });
}
