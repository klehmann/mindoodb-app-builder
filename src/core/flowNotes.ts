/**
 * What happened, named rather than worded.
 *
 * `core` runs in three hosts — the browser UI, the Cloudflare Worker (`src/worker`) and
 * the local Node host (`src/host`) — and results cross an HTTP boundary between the last
 * two (see `checkRepoReadable`). Two of those three have no UI language and no
 * `vue-i18n`, so a finished English sentence produced here can only ever be displayed
 * verbatim: a German user would read German step names with English text underneath.
 *
 * So core reports a {@link FlowNote}: a code for the message plus the values that go into
 * it. Whoever displays it picks the wording, in the reader's language, at the moment it is
 * rendered — which also means Haven switching language at runtime re-renders every note
 * instead of freezing the one that was current when the app was built.
 *
 * Notes stay JSON-serialisable (`params` is flat strings and numbers), so a note survives
 * the host round trip unchanged.
 *
 * Exception messages are deliberately *not* in here. A thrown "Cloudflare did not return
 * a build token" means a foreign API broke its contract: diagnostic, near-unreachable,
 * and usually carrying the vendor's own English text. Those stay English.
 */

/**
 * Every distinct message a normal run can produce.
 *
 * An array rather than a bare union so the list exists at runtime: `flowNoteText.test.ts`
 * walks it to prove every code has an `en.json` key, which is what stops a new code from
 * reaching a user as a raw translation key.
 */
export const FLOW_NOTE_CODES = [
  /**
   * Text that genuinely originates outside us — a GitHub or Cloudflare API message, a
   * validation error from the app SDK. It arrives already worded, in English, and we do
   * not try to translate it. `params.message` is shown as-is.
   */
  "external",
  /** Quotes an external refusal. Nested inside {@link repoAccessFix}. */
  "cloudflareSaid",

  // GitHub: the name, the repository, the identity commit.
  "nameAvailable",
  "nameTaken",
  "nameCheckFailed",
  "nameAlreadyYours",
  "repoFromEarlierAttempt",
  "repoCreated",
  "repoCreateFailed",
  "templateCopyPending",
  "templateMissingFile",
  "identityCommitted",
  "identityCommitFailed",

  // Cloudflare: can it read the repository, and what to do when it cannot.
  "noCloudflareAccount",
  "repoAccessReadable",
  "repoAccessUnconfirmed",
  "repoAccessCheckFailed",
  "repoAccessFix",
  "repoAccessNextStartFirstBuild",
  "repoAccessNextBuildAgain",

  // Cloudflare: the Worker, push-to-deploy, the first build.
  "workerReserved",
  "workerReused",
  "workerCreateFailed",
  "pushToDeployConnected",
  "buildTriggerReused",
  "pushToDeployFailed",
  "noBuildWithoutAccess",
  "havenNeedsLiveUrl",
  "noStartBuildCapability",
  "buildStarted",
  "buildStartFailed",

  // The origin probe: is the app really being served yet?
  "waitingForBuild",
  "originAttempt",
  "originNoUrl",
  "originNoAnswer",
  "originHttpStatus",
  "originNotJson",
  "originInvalidDefinition",
  "originMismatch",
  "originNotChecked",
  "originNotLiveInTime",
  "originBuildLogHint",
  "originServing",
  "originCheckFailed",

  // Haven.
  "havenNotGranted",
  "havenAddManually",
  "havenInstalled",
  "havenDeclined",
  "havenAddLater",
  "havenReadFailed",
  "havenProposeFailed",
  "pressRegisterInHaven",

  // Cursor.
  "noCursorKey",
  "agentStarted",
  "agentStartFailed",
] as const;

export type FlowNoteCode = (typeof FLOW_NOTE_CODES)[number];

export interface FlowNote {
  code: FlowNoteCode;
  params?: Record<string, string | number>;
}

/** Which button the user should press next, as a code rather than a sentence. */
export type RepoAccessNextCode = "repoAccessNextStartFirstBuild" | "repoAccessNextBuildAgain";

export function isFlowNoteCode(value: unknown): value is FlowNoteCode {
  return (FLOW_NOTE_CODES as readonly string[]).includes(value as string);
}

/** The verbatim text of an external note, or `""` for anything we worded ourselves. */
export function externalMessage(note: FlowNote | null | undefined): string {
  return note?.code === "external" ? String(note.params?.message ?? "") : "";
}

/** An outside message, quoted rather than translated. */
export function externalNote(message: string): FlowNote {
  return { code: "external", params: { message } };
}

/**
 * A failure the flow has its own words for, thrown across a boundary that only carries
 * `Error`s.
 *
 * The dependencies the hosts hand to `createApp` throw rather than return, and their
 * `message` is the only thing that used to survive — so a caller that knew exactly what
 * went wrong ("GitHub has not finished copying the template") had to word it at throw
 * time, in whatever language was active then. Attaching the note instead lets
 * `readErrorMessage` recover it, and the wording happens where every other note's does.
 *
 * `message` is diagnostic only: it reaches logs and stack traces, never a user.
 */
export class FlowNoteError extends Error {
  readonly note: FlowNote;

  constructor(note: FlowNote) {
    super(`flow note: ${note.code}`);
    this.name = "FlowNoteError";
    this.note = note;
  }
}
