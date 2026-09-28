/**
 * "Share app" from the list: the same message Haven's app information dialog sends, so
 * a recipient gets one kind of invitation whichever place it came from.
 *
 * The link is `<Haven>/?app=<app origin>`. Opening it runs Haven's setup with the app
 * offered at the end, or offers an existing Haven to add it. The builder cannot know
 * which Haven the recipient uses, and the one it runs in may be a local one nobody else
 * can reach, so the link always points at the public Haven — the same default Haven
 * itself falls back to when it runs on localhost.
 *
 * When the code is public, the message says where it is, so the recipient can read it
 * or start their own version with "Copy an app".
 */
import type { BuilderAppRecord } from "@/core/appRecords";

export const PUBLIC_HAVEN_URL = "https://haven.mindoodb.com/";

export type TranslateShare = (key: string, params?: Record<string, unknown>) => string;

/** Only a live app can be installed by someone else; before that the link leads nowhere. */
export function canShareApp(record: BuilderAppRecord): boolean {
  if (!record.workerUrl || !record.originReady) {
    return false;
  }
  try {
    return new URL(record.workerUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/** The app's origin, as Haven's `?app=` expects it: no trailing slash, no path. */
export function appOrigin(record: BuilderAppRecord): string {
  return new URL(record.workerUrl).origin;
}

export function appShareLink(record: BuilderAppRecord, havenUrl = PUBLIC_HAVEN_URL): string {
  const link = new URL(havenUrl);
  link.searchParams.set("app", appOrigin(record));
  return link.toString();
}

export interface AppShareContent {
  title: string;
  message: string;
  link: string;
}

/**
 * The invitation text. `repositoryPublic` adds where the code is; it is decided by the
 * caller, which can ask GitHub, because the record only knows what was chosen when the
 * app was created and a repository can be made public or private later.
 */
export function buildAppShare(
  t: TranslateShare,
  record: BuilderAppRecord,
  repositoryPublic: boolean,
): AppShareContent {
  const appName = record.label || record.appId;
  const link = appShareLink(record);
  const parts = [t("list.share.message", { appName, link, appUrl: appOrigin(record) })];
  if (repositoryPublic && record.repoUrl) {
    parts.push(t("list.share.code", { repoUrl: record.repoUrl }));
  }
  return {
    title: t("list.share.title", { appName }),
    message: parts.join("\n\n"),
    link,
  };
}

export type ShareSheetOutcome = "shared" | "cancelled" | "unsupported";

/**
 * Hand the text to the device's share sheet, where there is one.
 *
 * "cancelled" is the user closing the sheet, which is an answer, not a failure — the
 * caller must not follow it with a copy dialog. Anything else that goes wrong is treated
 * as "unsupported" so the caller offers copying instead.
 */
export async function shareViaSheet(content: { title: string; message: string }): Promise<ShareSheetOutcome> {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return "unsupported";
  }
  const data = { title: content.title, text: content.message };
  if (typeof navigator.canShare === "function" && !navigator.canShare(data)) {
    return "unsupported";
  }
  try {
    await navigator.share(data);
    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "unsupported";
  }
}
