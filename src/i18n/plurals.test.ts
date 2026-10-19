import { afterAll, describe, expect, it } from "vitest";
import { i18n, SUPPORTED_UI_LANGUAGES, setUiLanguage } from "./index";
import deMessages from "./locales/de.json";
import enMessages from "./locales/en.json";
import esMessages from "./locales/es.json";
import frMessages from "./locales/fr.json";
import itMessages from "./locales/it.json";
import nbMessages from "./locales/nb.json";
import nlMessages from "./locales/nl.json";
import plMessages from "./locales/pl.json";

/**
 * Count-dependent messages must be vue-i18n plural messages (`one | other`,
 * Polish `one | few | many`), and the active language's plural rule must pick
 * the right branch for every count — a bare "{count} nodes" reads "1 nodes",
 * and Polish needs a different ending for 2–4, 22–24, … than for 5–21.
 */

const LOCALE_MESSAGES: Record<string, unknown> = {
  de: deMessages,
  en: enMessages,
  es: esMessages,
  fr: frMessages,
  it: itMessages,
  nb: nbMessages,
  nl: nlMessages,
  pl: plMessages,
};

const COUNTS = [0, 1, 2, 3, 5, 12, 21, 22, 25];

/**
 * English messages that take `{count}` but are deliberately not plural,
 * because the number never sits next to a noun that would need to agree with
 * it ("{count} selected", "Open ({count})").
 */
const COUNT_WITHOUT_PLURAL = new Set<string>([
  "flow.note.sourceCopiedSkipped",
  "sourcePanel.found.skipped",
]);

/** Every `[key, message]` in a nested translation object (arrays skipped). */
function flatten(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function valueAt(messages: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);
}

function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(/\{\s*(\w+)\s*\}/g)].map((match) => match[1]!))];
}

/** The branch CLDR (via Intl.PluralRules) says a count must use. */
function expectedBranch(language: string, count: number, branches: number): number {
  const category = new Intl.PluralRules(language).select(count);
  if (branches === 3) return category === "one" ? 0 : category === "few" ? 1 : 2;
  return category === "one" ? 0 : 1;
}

const PLURAL_KEYS = flatten(enMessages)
  .filter(([, message]) => message.includes(" | "))
  .map(([key]) => key);

afterAll(() => setUiLanguage("en"));

describe("plural messages", () => {
  it("exist", () => {
    expect(PLURAL_KEYS.length).toBeGreaterThan(0);
  });

  it("cover every English message that puts {count} next to a noun", () => {
    const singular = flatten(enMessages)
      .filter(([, message]) => /\{\s*count\s*\}/.test(message) && !message.includes(" | "))
      .map(([key]) => key)
      .filter((key) => !COUNT_WITHOUT_PLURAL.has(key));
    expect(singular).toEqual([]);
  });

  for (const language of SUPPORTED_UI_LANGUAGES) {
    it(`pick the CLDR form for every count in ${language}`, () => {
      setUiLanguage(language);
      const problems: string[] = [];
      for (const key of PLURAL_KEYS) {
        const source = valueAt(LOCALE_MESSAGES[language], key);
        if (typeof source !== "string") {
          problems.push(`${key}: missing`);
          continue;
        }
        const branches = source.split(" | ");
        if (language === "pl" ? branches.length !== 3 : branches.length !== 2) {
          problems.push(`${key}: ${branches.length} forms`);
          continue;
        }
        for (const count of COUNTS) {
          const params = Object.fromEntries(placeholders(source).map((name) => [name, count]));
          const rendered = String(i18n.global.t(key, params, count));
          const want = branches[expectedBranch(language, count, branches.length)]!.replace(
            /\{\s*(\w+)\s*\}/g,
            (_, name: string) => String(params[name]),
          );
          if (/[{}|]/.test(rendered)) problems.push(`${key}(${count}): leaks syntax: ${rendered}`);
          else if (rendered !== want) problems.push(`${key}(${count}): "${rendered}" instead of "${want}"`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it("use the Polish few form for 2, 3, 22 and the many form for 0, 5, 12, 21, 25", () => {
    setUiLanguage("pl");
    // A message whose three Polish forms all differ, so the branch is visible.
    const key = PLURAL_KEYS.find((candidate) => new Set((valueAt(plMessages, candidate) as string).split(" | ")).size === 3)!;
    const [one, few, many] = (valueAt(plMessages, key) as string).split(" | ");
    const render = (count: number) =>
      String(i18n.global.t(key, Object.fromEntries(placeholders(one!).map((name) => [name, count])), count));
    const fill = (branch: string, count: number) => branch.replace(/\{\s*\w+\s*\}/g, String(count));
    expect(render(1)).toBe(fill(one!, 1));
    for (const count of [2, 3, 22]) expect(render(count)).toBe(fill(few!, count));
    for (const count of [0, 5, 12, 21, 25]) expect(render(count)).toBe(fill(many!, count));
  });
});
