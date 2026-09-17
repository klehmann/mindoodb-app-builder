/**
 * One document per app the user built, so the builder can open with a list rather than
 * a wizard.
 *
 * This is what turns the builder from a one-shot form into something you come back to.
 * A record carries everything needed to *act* on a finished app without asking any
 * service: its public URL, the repository it builds from, the Worker script tag the
 * Builds API keys off, the Cursor agent that is working on it, and how far the last run
 * got. From that, the list can offer "open", "add to Haven again", "build now", and
 * "save the definition file" — and an interrupted run can be picked up after the user
 * renewed a dead token, which is the reason the flow writes a record after every phase
 * rather than once at the end.
 *
 * **Not sealed, unlike the credentials.** These documents hold no secrets — a repository
 * URL and a Worker name are things the user hands out on purpose — and storing them with
 * the database's own key has two payoffs: they are queryable the normal way, and a
 * builder database shared with a team shows that team's apps, so a colleague can install
 * one without being the person who built it. The tokens stay person-bound in
 * `credentials.ts`; nothing in here may ever hold one.
 */
import { createViewLanguage, type MindooDBAppDatabase } from "mindoodb-app-sdk";

import type { AppIdentity } from "./appIdentity";
import type { AgentHandle, WorkerDeployment } from "./createAppFlow";
import type { GitHubRepository } from "./github";

/** Marks the document for humans reading the database, and is how the app finds it. */
export const APP_RECORD_DOCUMENT_TYPE = "mindoodb.appbuilder.app";

const APP_RECORD_ID_PREFIX = "app";

/**
 * A ceiling on the list query. Nobody builds this many apps, which is the point: it
 * bounds a query whose result is rendered in one page, so a database that accumulated
 * junk cannot turn opening the builder into a stall.
 */
const LIST_LIMIT = 200;

/**
 * Field holding the long agent brief.
 *
 * MindooDB's summary buffer auto-includes every *scalar* top-level field, and that is
 * exactly what the list wants for names and URLs — one query, no per-document read. A
 * multi-paragraph prompt is the one field that would be copied into that index for no
 * reason, so it lives one level down.
 */
const BRIEF_FIELD = "brief";

const v = createViewLanguage<Record<string, unknown>>();

/**
 * How far an app got, derived rather than stored.
 *
 * Deriving it means the status cannot contradict the fields it describes — a record that
 * says "published" without a URL is not representable. The order is the order of the
 * run: each stage implies the ones before it.
 */
export type BuilderAppStage = "planned" | "repository" | "published" | "live" | "installed";

export interface BuilderAppRecord {
  /**
   * The slug, which is the repository name, the Worker name, and the app id in
   * `haven-app.json` all at once. One name for one app is what makes a record findable
   * from any of the three services.
   */
  appId: string;
  label: string;
  description: string;
  /** The long brief handed to the Cursor agent. Empty when the user wrote none. */
  task: string;
  /** ISO timestamps. `createdAt` orders the list; `updatedAt` is for humans. */
  createdAt: string;
  updatedAt: string;
  private: boolean;

  repoOwner: string;
  repoName: string;
  repoUrl: string;
  repoBranch: string;
  /** GitHub's numeric ids, which Cloudflare's build connection needs by value. */
  repoId: number;
  repoOwnerId: number;

  /** Public `*.workers.dev` URL. Present from the moment the Worker exists. */
  workerUrl: string;
  /** Cloudflare's immutable script id — the only handle the Builds API accepts. */
  workerScriptTag: string;
  cloudflareAccountId: string;

  /** A push-to-deploy trigger exists, so a build can be started for this app. */
  wiredForBuild: boolean;
  /** The app answered on its own URL at least once, so it is really live. */
  originReady: boolean;

  cursorAgentId: string;
  cursorAgentUrl: string;
  /** The agent's run, which is what Cursor's API needs to report progress later. */
  cursorRunId: string;

  /** Set once Haven installed it, which is also how "add again" knows it is a repeat. */
  havenInstanceId: string;
}

export const EMPTY_APP_RECORD: BuilderAppRecord = {
  appId: "",
  label: "",
  description: "",
  task: "",
  createdAt: "",
  updatedAt: "",
  private: true,
  repoOwner: "",
  repoName: "",
  repoUrl: "",
  repoBranch: "",
  repoId: 0,
  repoOwnerId: 0,
  workerUrl: "",
  workerScriptTag: "",
  cloudflareAccountId: "",
  wiredForBuild: false,
  originReady: false,
  cursorAgentId: "",
  cursorAgentUrl: "",
  cursorRunId: "",
  havenInstanceId: "",
};

/** A record plus the document it came from, so a later save updates that one. */
export interface StoredAppRecord {
  documentId: string;
  record: BuilderAppRecord;
}

export function appStage(record: BuilderAppRecord): BuilderAppStage {
  if (record.havenInstanceId) {
    return "installed";
  }
  if (record.originReady) {
    return "live";
  }
  if (record.workerUrl) {
    return "published";
  }
  if (record.repoUrl) {
    return "repository";
  }
  return "planned";
}

/**
 * The URL Haven reads to install the app.
 *
 * Haven only ever installs from an origin — it fetches `haven-app.json` itself and
 * validates it — so this is both what "add to Haven" sends and what the file export
 * downloads.
 */
export function appDefinitionUrl(record: BuilderAppRecord): string {
  if (!record.workerUrl) {
    return "";
  }
  return `${record.workerUrl.replace(/\/+$/, "")}/haven-app.json`;
}

/**
 * Where the user maintains the app in Cloudflare's own UI: logs, builds, settings,
 * custom domains. Everything the builder deliberately does not reimplement.
 */
export function workerDashboardUrl(record: BuilderAppRecord): string {
  if (!record.cloudflareAccountId || !record.appId) {
    return "";
  }
  return (
    `https://dash.cloudflare.com/${encodeURIComponent(record.cloudflareAccountId)}` +
    `/workers/services/view/${encodeURIComponent(record.appId)}/production`
  );
}

/**
 * The record for an app the user has only described so far.
 *
 * Written before the first API call, which is what makes an interrupted run resumable:
 * a token that dies during "create the repository" still leaves the name and the brief
 * behind, so the list can offer to carry on instead of asking the user to retype it.
 */
export function appRecordFromIdentity(
  identity: AppIdentity,
  options: { private: boolean },
): BuilderAppRecord {
  const now = new Date().toISOString();
  return {
    ...EMPTY_APP_RECORD,
    appId: identity.slug,
    label: identity.label,
    description: identity.description,
    task: identity.task,
    createdAt: now,
    updatedAt: now,
    private: options.private,
  };
}

/** What a finished phase learned about the app. Every field is optional on purpose. */
export interface FlowOutcome {
  repository?: GitHubRepository | null;
  worker?: WorkerDeployment | null;
  agent?: AgentHandle | null;
  installedAppInstanceId?: string | null;
  cloudflareAccountId?: string;
  wiredForBuild?: boolean;
  originReady?: boolean;
}

/**
 * Fold what a phase produced into the record, and never unlearn anything.
 *
 * Only present values overwrite. That is the rule the whole resume story rests on: a
 * Cloudflare phase that ran on its own reports no repository, and a later phase must
 * not blank the one the GitHub phase found. The two booleans latch for the same
 * reason — an app that came live once is live, whatever a re-run of a single phase says.
 */
export function applyFlowOutcome(
  base: BuilderAppRecord,
  outcome: FlowOutcome,
): BuilderAppRecord {
  const next = { ...base };

  if (outcome.repository) {
    next.repoOwner = outcome.repository.owner;
    next.repoName = outcome.repository.name;
    next.repoUrl = outcome.repository.htmlUrl;
    next.repoBranch = outcome.repository.defaultBranch;
    next.repoId = outcome.repository.id;
    next.repoOwnerId = outcome.repository.ownerId;
  }
  if (outcome.worker) {
    next.workerUrl = outcome.worker.url;
    next.workerScriptTag = outcome.worker.scriptTag;
  }
  if (outcome.agent) {
    next.cursorAgentId = outcome.agent.id;
    next.cursorAgentUrl = outcome.agent.url;
    next.cursorRunId = outcome.agent.runId;
  }
  if (outcome.installedAppInstanceId) {
    next.havenInstanceId = outcome.installedAppInstanceId;
  }
  if (outcome.cloudflareAccountId) {
    next.cloudflareAccountId = outcome.cloudflareAccountId;
  }
  if (outcome.wiredForBuild) {
    next.wiredForBuild = true;
  }
  if (outcome.originReady) {
    next.originReady = true;
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * The repository a stored app builds from, in the shape the flow works with.
 *
 * The inverse of what {@link applyFlowOutcome} stored, and the reason a resumed run
 * needs no GitHub round trip to get going: everything Cloudflare's build connection
 * asks for — both numeric ids, the branch — was written down the first time.
 */
export function repositoryFromRecord(record: BuilderAppRecord): GitHubRepository | null {
  if (!record.repoUrl || !record.repoName || !record.repoOwner) {
    return null;
  }
  return {
    id: record.repoId,
    name: record.repoName,
    fullName: `${record.repoOwner}/${record.repoName}`,
    owner: record.repoOwner,
    ownerId: record.repoOwnerId,
    htmlUrl: record.repoUrl,
    defaultBranch: record.repoBranch || "main",
  };
}

/**
 * The Worker a stored app is served by.
 *
 * `reused: true` is the honest value on a resume — the Worker was created by an earlier
 * run, so nothing here may report it as newly made.
 */
export function workerFromRecord(record: BuilderAppRecord): WorkerDeployment | null {
  if (!record.workerUrl || !record.workerScriptTag) {
    return null;
  }
  return { url: record.workerUrl, scriptTag: record.workerScriptTag, reused: true };
}

/**
 * What pressing "continue" on this app should do.
 *
 * One button, and this decides what it means — which is what keeps the list simple. The
 * order mirrors the run, and each answer is chosen by what the record can *prove* rather
 * than by how the last attempt ended: a failed run whose repository exists resumes at
 * "publish", not at "create", because creating it again would only collide with itself.
 *
 * - `create` — nothing exists yet; run the whole sequence.
 * - `publish` — the repository is there but has no Worker; wire Cloudflare.
 * - `build` — published but never seen live; start a build and wait for it.
 * - `install` — live, but Haven does not have it yet.
 * - `iterate` — finished. The remaining work is the user's, in Cursor or in the app.
 */
export type AppNextAction = "create" | "publish" | "build" | "install" | "iterate";

export function nextAppAction(record: BuilderAppRecord): AppNextAction {
  if (!record.repoUrl) {
    return "create";
  }
  if (!record.workerUrl) {
    return "publish";
  }
  if (!record.originReady) {
    return "build";
  }
  if (!record.havenInstanceId) {
    return "install";
  }
  return "iterate";
}

function readString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readBoolean(data: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = data[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A stored URL, or empty when it is not one the UI may link to.
 *
 * This is the trust boundary for these documents, and it earns its keep because the
 * database can be shared: a record is written by whoever can write to it, the app list
 * renders its URLs as links, and a `javascript:` string is a perfectly valid string. So
 * only `http`/`https` survives, checked by the URL parser rather than by a prefix test —
 * embedded tabs and newlines are what defeat prefix tests.
 */
function readUrl(data: Record<string, unknown>, key: string): string {
  const value = readString(data, key);
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value);
    // The stored string comes back, not `parsed.href`: parsing normalizes (it appends a
    // root slash), and a value that changed on the way out of storage is a surprise
    // nobody needs. This only decides yes or no.
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : "";
  } catch {
    return "";
  }
}

/**
 * Map a stored document body onto the record shape, ignoring anything else in it.
 *
 * Every field is read defensively for the same reason the credentials are: this is
 * app-writable data in a database a team may share, so a wrong type must come back as
 * "empty" rather than reach a URL or a fetch call unchecked.
 */
export function appRecordFromDocumentData(
  body: Record<string, unknown> | undefined,
): BuilderAppRecord {
  if (!body) {
    return { ...EMPTY_APP_RECORD };
  }
  const brief = body[BRIEF_FIELD];
  const briefData =
    brief !== null && typeof brief === "object" ? (brief as Record<string, unknown>) : {};

  return {
    appId: readString(body, "appId"),
    label: readString(body, "label"),
    description: readString(body, "description"),
    // Not trimmed through `readString` alone: the brief is prose, and trailing structure
    // inside it is the user's. Only the outer padding goes.
    task: typeof briefData.task === "string" ? briefData.task.trim() : "",
    createdAt: readString(body, "createdAt"),
    updatedAt: readString(body, "updatedAt"),
    private: readBoolean(body, "private", true),
    repoOwner: readString(body, "repoOwner"),
    repoName: readString(body, "repoName"),
    repoUrl: readUrl(body, "repoUrl"),
    repoBranch: readString(body, "repoBranch"),
    repoId: readNumber(body, "repoId"),
    repoOwnerId: readNumber(body, "repoOwnerId"),
    workerUrl: readUrl(body, "workerUrl"),
    workerScriptTag: readString(body, "workerScriptTag"),
    cloudflareAccountId: readString(body, "cloudflareAccountId"),
    wiredForBuild: readBoolean(body, "wiredForBuild"),
    originReady: readBoolean(body, "originReady"),
    cursorAgentId: readString(body, "cursorAgentId"),
    cursorAgentUrl: readUrl(body, "cursorAgentUrl"),
    cursorRunId: readString(body, "cursorRunId"),
    havenInstanceId: readString(body, "havenInstanceId"),
  };
}

function toDocumentData(record: BuilderAppRecord, now: string): Record<string, unknown> {
  return {
    type: APP_RECORD_DOCUMENT_TYPE,
    appId: record.appId.trim(),
    label: record.label.trim(),
    description: record.description.trim(),
    createdAt: record.createdAt || now,
    updatedAt: now,
    private: record.private,
    repoOwner: record.repoOwner.trim(),
    repoName: record.repoName.trim(),
    repoUrl: record.repoUrl.trim(),
    repoBranch: record.repoBranch.trim(),
    repoId: record.repoId,
    repoOwnerId: record.repoOwnerId,
    workerUrl: record.workerUrl.trim(),
    workerScriptTag: record.workerScriptTag.trim(),
    cloudflareAccountId: record.cloudflareAccountId.trim(),
    wiredForBuild: record.wiredForBuild,
    originReady: record.originReady,
    cursorAgentId: record.cursorAgentId.trim(),
    cursorAgentUrl: record.cursorAgentUrl.trim(),
    cursorRunId: record.cursorRunId.trim(),
    havenInstanceId: record.havenInstanceId.trim(),
    [BRIEF_FIELD]: { task: record.task.trim() },
  };
}

/**
 * Every app record in this database, newest first.
 *
 * Ordered by `createdAt` rather than by last modification: the list is the user's own
 * history, and an app jumping to the top because a background build status was written
 * would make it unreadable.
 *
 * A failure comes back as an empty list. A database still backfilling its summary, or
 * one without `read`, means the same thing to the user as having built nothing yet —
 * and the builder must still open.
 */
export async function listAppRecords(database: MindooDBAppDatabase): Promise<StoredAppRecord[]> {
  let docIds: string[] = [];
  try {
    const result = await database.documents.query({
      filter: v.eq(v.field("type"), APP_RECORD_DOCUMENT_TYPE),
      sortBy: [{ field: "_lastModified", direction: "descending" }],
      fields: ["type"],
      limit: LIST_LIMIT,
    });
    docIds = result.rows.map((row) => row.docId);
  } catch {
    return [];
  }

  /*
   * Read each document rather than trusting the query rows. The fields are summarizable
   * scalars, so the rows *could* carry them — but only where the summary buffer is
   * already caught up, and a list that silently shows half a record is worse than one
   * extra read per app at these counts.
   */
  const stored = await Promise.all(
    docIds.map(async (documentId) => {
      try {
        const document = await database.documents.get(documentId);
        return document ? { documentId, record: appRecordFromDocumentData(document.data) } : null;
      } catch {
        return null;
      }
    }),
  );

  return stored
    .filter((entry): entry is StoredAppRecord => entry !== null)
    .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
}

/** Read one record back, for a resumed run that remembers its document id. */
export async function loadAppRecord(
  database: MindooDBAppDatabase,
  documentId: string,
): Promise<BuilderAppRecord | null> {
  try {
    const document = await database.documents.get(documentId);
    return document ? appRecordFromDocumentData(document.data) : null;
  } catch {
    return null;
  }
}

/**
 * The record for an app id, so a second run for the same name continues the first one's
 * document instead of forking the history.
 */
export async function findAppRecordByAppId(
  database: MindooDBAppDatabase,
  appId: string,
): Promise<StoredAppRecord | null> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return null;
  }
  const all = await listAppRecords(database);
  return all.find((entry) => entry.record.appId === trimmed) ?? null;
}

/**
 * Write the record, creating the document on first use, and return the id to reuse.
 *
 * `update` merges the given fields, which is what lets the flow save after every phase:
 * the Cloudflare phase writes the Worker fields without having to restate what the
 * GitHub phase already stored.
 */
export async function saveAppRecord(
  database: MindooDBAppDatabase,
  record: BuilderAppRecord,
  documentId?: string | null,
): Promise<string> {
  const now = new Date().toISOString();
  const set = toDocumentData(record, now);

  const existingId =
    documentId ?? (await findAppRecordByAppId(database, record.appId))?.documentId ?? null;
  if (existingId) {
    await database.documents.update(existingId, { set });
    return existingId;
  }

  const created = await database.documents.create({
    idPrefix: APP_RECORD_ID_PREFIX,
    set,
  });
  return created.id;
}

/**
 * Drop the record.
 *
 * This removes the builder's *note* about an app, not the app: the repository, the
 * Worker, and any Haven installation are untouched and keep running. Whoever calls this
 * has to say so, because "delete" next to an app name reads like the opposite.
 */
export async function deleteAppRecord(
  database: MindooDBAppDatabase,
  documentId: string,
): Promise<void> {
  await database.documents.delete(documentId);
}
