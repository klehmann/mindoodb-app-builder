/**
 * Save an app's `haven-app.json` to disk.
 *
 * Why this exists: Haven installs an app from its origin, so the normal path is "add to
 * Haven" with a URL. The file is for the cases a URL cannot cover — handing the app to a
 * colleague whose Haven cannot reach it, importing it by hand in Haven's app editor, or
 * simply keeping a copy of what was generated.
 *
 * Fetched and re-served as a blob rather than linked with `download`: the attribute is
 * ignored cross-origin, so a plain link would just show JSON in a new tab. When the
 * fetch is refused — the app's origin need not allow this page to read it — the tab is
 * the honest fallback, and the user can save from there.
 */

export type SaveDefinitionOutcome = "saved" | "opened";

export interface SaveDefinitionDependencies {
  fetchImpl?: typeof fetch;
  /** Injected for tests; in the browser these are the real DOM and window. */
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  triggerDownload?: (url: string, filename: string) => void;
  openInTab?: (url: string) => void;
}

function defaultTriggerDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Write the definition to the user's disk, or open it if that is all we can do.
 *
 * The URL is checked here as well as when it was read from the document. It is one line,
 * and this function is the one that hands a string to `window.open` — a sink deserves
 * its own check rather than trusting that every caller validated it.
 */
export async function saveAppDefinition(
  definitionUrl: string,
  filename: string,
  dependencies: SaveDefinitionDependencies = {},
): Promise<SaveDefinitionOutcome> {
  const {
    fetchImpl = fetch,
    createObjectUrl = (blob: Blob) => URL.createObjectURL(blob),
    revokeObjectUrl = (url: string) => URL.revokeObjectURL(url),
    triggerDownload = defaultTriggerDownload,
    openInTab = (url: string) => window.open(url, "_blank", "noopener,noreferrer"),
  } = dependencies;

  let safeUrl: URL;
  try {
    safeUrl = new URL(definitionUrl);
  } catch {
    throw new Error("This app has no web address yet.");
  }
  if (safeUrl.protocol !== "https:" && safeUrl.protocol !== "http:") {
    throw new Error("This app has no web address yet.");
  }

  try {
    const response = await fetchImpl(safeUrl.href);
    if (!response.ok) {
      throw new Error(`The app answered ${response.status}.`);
    }
    const text = await response.text();
    const objectUrl = createObjectUrl(
      new Blob([text], { type: "application/json;charset=utf-8" }),
    );
    try {
      triggerDownload(objectUrl, filename);
    } finally {
      revokeObjectUrl(objectUrl);
    }
    return "saved";
  } catch {
    openInTab(safeUrl.href);
    return "opened";
  }
}
