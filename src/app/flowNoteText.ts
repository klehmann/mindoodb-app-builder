/**
 * The one place a {@link FlowNote} becomes a sentence.
 *
 * `core` reports codes so it can stay language-free (see `core/flowNotes.ts`); this turns
 * them into the reader's language at render time. Kept to a single function so there is
 * one answer to "where does this wording come from", and so Haven switching language at
 * runtime re-renders every note instead of freezing whatever was current when the app was
 * built — which is what happens the moment a caller stores `t(...)`'s result.
 *
 * `t` is passed in rather than imported, so the caller's `useI18n()` binding is used and
 * the text is reactive in the component that shows it.
 */
import { isFlowNoteCode, type FlowNote, type FlowNoteCode } from "@/core/flowNotes";

export type TranslateNote = (key: string, params?: Record<string, unknown>) => string;

/** Which button to press next, offered by `repoAccessFix` as a code rather than a phrase. */
const REPO_ACCESS_NEXT = ["repoAccessNextStartFirstBuild", "repoAccessNextBuildAgain"] as const;

/**
 * Notes that tell the user to press something, and the button whose label they mean.
 *
 * The label is read from the button's own key and interpolated as `{action}`, never
 * written into the note's wording — a sentence that spells out "press Build now" is
 * telling a German reader to look for words that are not on the screen, and it silently
 * goes stale the day the button is renamed. Which button belongs to which note is UI
 * knowledge, so it lives here rather than in `core`.
 */
const BUTTON_LABELS: Partial<Record<FlowNoteCode, string>> = {
  // The repository exists and is wired but never went live: `nextAppAction` answers
  // "build", so the app's own page offers this as its one Continue button.
  repoAccessNextStartFirstBuild: "detail.continue.labels.build",
  originBuildLogHint: "detail.builds.buildNow",
  repoAccessNextBuildAgain: "detail.builds.buildNow",
  // Live but not installed: `nextAppAction` answers "install".
  pressRegisterInHaven: "detail.continue.labels.install",
  // The project exists and still carries the template's identity: "commit".
  templateCopyPending: "detail.continue.labels.commit",
};

export function flowNoteText(t: TranslateNote, note: FlowNote | null | undefined): string {
  if (!note) {
    return "";
  }

  const params = note.params ?? {};

  switch (note.code) {
    /*
     * Wording from outside — a GitHub or Cloudflare API error, a validation message from
     * the app SDK. Returned raw rather than through `t`, because vue-i18n would parse a
     * `{`, `|` or `@:` in a message we do not control as its own syntax.
     */
    case "external":
      return String(params.message ?? "");

    /*
     * Two notes in one line: which attempt this is, and how the origin was failing on it.
     * The inner note travels as a code in `params.note` (with its own parameters merged
     * alongside), so the reason is translated too rather than being an English string
     * interpolated into a translated frame.
     */
    case "originAttempt": {
      const inner = params.note;
      // Anything but another counter, so a nested code cannot resolve back into this case.
      const detail =
        isFlowNoteCode(inner) && inner !== "originAttempt"
          ? flowNoteText(t, { code: inner, params })
          : "";
      return wording(t, "originAttempt", { attempt: params.attempt ?? 0, detail });
    }

    /*
     * The long help text for a repository Cloudflare cannot read. One key, so the four
     * sentences stay one translatable unit; the closing instruction is a code of its own
     * because it differs between the first build and the rescue build, and Cloudflare's
     * refusal is quoted after it when there is one.
     */
    case "repoAccessFix": {
      const next = REPO_ACCESS_NEXT.find((code) => code === params.next);
      const help = wording(t, "repoAccessFix", {
        fullName: params.fullName ?? "",
        // Resolved through this function rather than `t`, so the nested sentence gets its
        // button label filled in like any other note.
        next: next ? flowNoteText(t, { code: next }) : "",
      });
      const said = String(params.said ?? "").trim();
      return said ? `${help} ${wording(t, "cloudflareSaid", { said })}` : help;
    }

    default:
      return wording(t, note.code, params);
  }
}

/** One note's own key, with the button label filled in for the notes that name one. */
function wording(
  t: TranslateNote,
  code: FlowNoteCode,
  params: Record<string, unknown>,
): string {
  const label = BUTTON_LABELS[code];
  return t(`flow.note.${code}`, label ? { ...params, action: t(label) } : params);
}
