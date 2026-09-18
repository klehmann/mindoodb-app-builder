import { describe, expect, it } from "vitest";

import { flowNoteText } from "@/app/flowNoteText";
import { FLOW_NOTE_CODES, FlowNoteError, type FlowNoteCode } from "@/core/flowNotes";
import { t } from "@/i18n";
import enMessages from "@/i18n/locales/en.json";

/**
 * A code with no key renders as `flow.note.whatever` to a user, in every language at once.
 * That is a translation bug with no symptom in `core` and no compile error, so the list of
 * codes is walked here instead: adding a `FlowNoteCode` without wording fails CI.
 */
const notes = (enMessages as { flow: { note: Record<string, string> } }).flow.note;

/** Passthrough wording is deliberately absent — see the `external` case in the resolver. */
const UNWORDED: FlowNoteCode[] = ["external"];

/** A stand-in value for every `{name}` a message interpolates. */
function markers(message: string): Record<string, string> {
  return Object.fromEntries(
    [...message.matchAll(/\{(\w+)\}/g)].map((match) => [match[1]!, `<${match[1]}>`]),
  );
}

describe("flow note wording", () => {
  it("has an en.json key for every note code core can emit", () => {
    const missing = FLOW_NOTE_CODES.filter(
      (code) => !UNWORDED.includes(code) && typeof notes[code] !== "string",
    );

    expect(missing).toEqual([]);
  });

  it("words every note code without leaving a raw key or a placeholder behind", () => {
    // vue-i18n falls back to the key itself when a message is missing, which is exactly
    // what a user must never see. Some messages are nothing but a value — `repoCreated`
    // is the repository's own name — so each is rendered with its own placeholders filled.
    for (const code of FLOW_NOTE_CODES) {
      if (UNWORDED.includes(code)) {
        continue;
      }
      const text = flowNoteText(t, { code, params: markers(notes[code]!) });
      expect(text.trim()).not.toBe("");
      expect(text).not.toContain(`flow.note.${code}`);
      expect(text).not.toContain("{");
    }
  });

  it("has no wording for a code core no longer emits", () => {
    const codes = new Set<string>(FLOW_NOTE_CODES);
    const orphans = Object.keys(notes).filter((key) => !codes.has(key));

    expect(orphans).toEqual([]);
  });
});

describe("FlowNoteError", () => {
  it("carries the note across a boundary that only takes an Error", () => {
    const note = { code: "templateMissingFile", params: { path: "package.json" } } as const;

    const error = new FlowNoteError(note);

    expect(error).toBeInstanceOf(Error);
    expect(error.note).toEqual(note);
    // The message is for logs and stack traces; the user sees the note.
    expect(error.message).toContain("templateMissingFile");
  });
});

describe("flowNoteText", () => {
  it("says nothing when there is nothing to say", () => {
    expect(flowNoteText(t, null)).toBe("");
  });

  it("quotes an outside message rather than translating it", () => {
    // Deliberately full of vue-i18n's own syntax: an API error is not a message pattern,
    // and running it through `t` would have it parsed as one.
    const message = "Repository {not} found | @:nowhere";

    expect(flowNoteText(t, { code: "external", params: { message } })).toBe(message);
  });

  it("words the reason inside an attempt counter, rather than pasting English into it", () => {
    const text = flowNoteText(t, {
      code: "originAttempt",
      params: { attempt: 3, note: "originNoAnswer" },
    });

    expect(text).toBe("Attempt 3: The origin did not answer yet.");
  });

  it("carries the inner note's own parameters through the attempt counter", () => {
    const text = flowNoteText(t, {
      code: "originAttempt",
      params: { attempt: 2, note: "originHttpStatus", status: 404 },
    });

    expect(text).toBe("Attempt 2: haven-app.json answered HTTP 404.");
  });

  it("names the button to press in the repository-access help, in the reader's language", () => {
    const help = flowNoteText(t, {
      code: "repoAccessFix",
      params: {
        fullName: "octocat/team-notes",
        said: "Repository not found",
        next: "repoAccessNextBuildAgain",
      },
    });

    expect(help).toContain("octocat/team-notes");
    // The nested sentence, with the real button's label in it.
    expect(help).toContain(`press “${t("detail.builds.buildNow")}” again`);
    expect(help).toContain("Cloudflare said: Repository not found");
    // One key for the whole paragraph, so no fragment is left for a translator to guess at.
    expect(help).not.toContain("{next}");
  });

  /**
   * The bug this locks down: a note that spells out a button name in English tells a German
   * reader to press words that are not on the screen, and goes stale the day the button is
   * renamed. Every note that says "press X" has to read X from the button's own key.
   */
  it("quotes each button by its own label rather than spelling one out", () => {
    const expected: Array<[FlowNoteCode, string]> = [
      ["repoAccessNextStartFirstBuild", "detail.continue.labels.build"],
      ["repoAccessNextBuildAgain", "detail.builds.buildNow"],
      ["originBuildLogHint", "detail.builds.buildNow"],
      ["pressRegisterInHaven", "detail.continue.labels.install"],
      ["templateCopyPending", "detail.continue.labels.commit"],
    ];

    for (const [code, labelKey] of expected) {
      const text = flowNoteText(t, { code, params: { fullName: "octocat/team-notes" } });
      expect(text).toContain(`“${t(labelKey)}”`);
      // The wording must not carry a second, hardcoded copy of a button name.
      expect(notes[code]).toContain("{action}");
    }
  });

  it("leaves the quote out when Cloudflare said nothing", () => {
    const help = flowNoteText(t, {
      code: "repoAccessFix",
      params: { fullName: "octocat/team-notes", said: "", next: "repoAccessNextStartFirstBuild" },
    });

    expect(help).not.toContain("Cloudflare said");
    expect(help.trim()).toBe(help);
  });
});
