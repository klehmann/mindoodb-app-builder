import { describe, expect, it } from "vitest";
import { detectBrowserUiLanguage, mapLocaleToUiLanguage, SUPPORTED_UI_LANGUAGES } from "./index";
import deMessages from "./locales/de.json";
import enMessages from "./locales/en.json";
import esMessages from "./locales/es.json";
import frMessages from "./locales/fr.json";
import itMessages from "./locales/it.json";
import nbMessages from "./locales/nb.json";
import nlMessages from "./locales/nl.json";
import havenApp from "../../public/haven-app.json";
import plMessages from "./locales/pl.json";

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

/** Recursively collects dotted key paths from a nested translation object. */
function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** The value at a dotted key path. */
function valueAt(messages: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);
}

/**
 * The `{named}` and `{0}` interpolations of a message, deduplicated and sorted.
 * Plural branches (`a | b`) are merged, since a branch may leave out `{count}`.
 */
function placeholdersOf(message: string): string[] {
  return [...new Set(message.match(/\{\s*[\w.]+\s*\}/g) ?? [])].map((p) => p.replace(/\s/g, "")).sort();
}

/** Linked messages (`@:key`, `@.lower:key`) a message refers to. */
function linksOf(message: string): string[] {
  return [...new Set(message.match(/@(?:\.\w+)?:[\w.]+/g) ?? [])].sort();
}

/** Number of plural branches of a vue-i18n message. */
function pluralBranches(message: string): number {
  return message.split(" | ").length;
}

describe("mapLocaleToUiLanguage", () => {
  it("maps German-speaking country locales to de", () => {
    expect(mapLocaleToUiLanguage("de-DE")).toBe("de");
    expect(mapLocaleToUiLanguage("de-AT")).toBe("de");
    expect(mapLocaleToUiLanguage("de-CH")).toBe("de");
  });

  it("maps French and Spanish locales directly", () => {
    expect(mapLocaleToUiLanguage("fr-FR")).toBe("fr");
    expect(mapLocaleToUiLanguage("es-ES")).toBe("es");
  });

  it("maps the remaining supported single-country locales directly", () => {
    expect(mapLocaleToUiLanguage("nl-NL")).toBe("nl");
    expect(mapLocaleToUiLanguage("it-IT")).toBe("it");
    expect(mapLocaleToUiLanguage("pl-PL")).toBe("pl");
    expect(mapLocaleToUiLanguage("en-GB")).toBe("en");
  });

  it("maps Norwegian Bokmål under both the nb and legacy no language tags", () => {
    expect(mapLocaleToUiLanguage("nb-NO")).toBe("nb");
    expect(mapLocaleToUiLanguage("no-NO")).toBe("nb");
  });

  it("falls back to English for unsupported or missing locales", () => {
    expect(mapLocaleToUiLanguage("pt-BR")).toBe("en");
    expect(mapLocaleToUiLanguage(undefined)).toBe("en");
    expect(mapLocaleToUiLanguage("")).toBe("en");
  });
});

describe("detectBrowserUiLanguage", () => {
  it("returns the first supported browser language in preference order", () => {
    expect(detectBrowserUiLanguage(["de-DE", "en-US"])).toBe("de");
    expect(detectBrowserUiLanguage(["fr-CA", "fr-FR"])).toBe("fr");
    expect(detectBrowserUiLanguage(["en-GB"])).toBe("en");
  });

  it("skips unsupported languages instead of collapsing them to English early", () => {
    expect(detectBrowserUiLanguage(["pt-BR", "fr-FR"])).toBe("fr");
    expect(detectBrowserUiLanguage(["sv-SE", "it-IT", "de-DE"])).toBe("it");
    expect(detectBrowserUiLanguage(["es-ES", "fr-FR"])).toBe("es");
  });

  it("maps Norwegian tags (nb/nn/no) to nb", () => {
    expect(detectBrowserUiLanguage(["nb-NO"])).toBe("nb");
    expect(detectBrowserUiLanguage(["no"])).toBe("nb");
    expect(detectBrowserUiLanguage(["nn-NO"])).toBe("nb");
  });

  it("falls back to English when nothing is supported or the list is empty", () => {
    expect(detectBrowserUiLanguage(["sv-SE", "pt-BR"])).toBe("en");
    expect(detectBrowserUiLanguage([])).toBe("en");
  });
});

describe("locale message files", () => {
  it("ship a message file for every supported UI language", () => {
    for (const language of SUPPORTED_UI_LANGUAGES) {
      expect(LOCALE_MESSAGES[language]).toBeDefined();
    }
  });

  it("keep the exact same set of translation keys across all languages", () => {
    const [baseLanguage, ...otherLanguages] = SUPPORTED_UI_LANGUAGES;
    const baseKeys = new Set(flattenKeys(LOCALE_MESSAGES[baseLanguage]));
    expect(baseKeys.size).toBeGreaterThan(0);

    for (const language of otherLanguages) {
      const keys = new Set(flattenKeys(LOCALE_MESSAGES[language]));
      const missing = [...baseKeys].filter((key) => !keys.has(key));
      const extra = [...keys].filter((key) => !baseKeys.has(key));
      expect({ language, missing, extra }).toEqual({ language, missing: [], extra: [] });
    }
  });

  it("use the same placeholders, linked messages and plural forms as English", () => {
    const baseMessages = LOCALE_MESSAGES.en;
    for (const language of SUPPORTED_UI_LANGUAGES) {
      if (language === "en") continue;
      const messages = LOCALE_MESSAGES[language];
      const mismatches: string[] = [];
      for (const key of flattenKeys(baseMessages)) {
        const base = valueAt(baseMessages, key);
        const value = valueAt(messages, key);
        const pairs: [unknown, unknown, string][] = Array.isArray(base)
          ? base.map((entry, i) => [entry, Array.isArray(value) ? value[i] : undefined, `${key}[${i}]`])
          : [[base, value, key]];
        if (Array.isArray(base) && (!Array.isArray(value) || value.length !== base.length)) {
          mismatches.push(`${key}: ${Array.isArray(value) ? value.length : "no"} entries instead of ${base.length}`);
          continue;
        }
        for (const [baseEntry, entry, path] of pairs) {
          if (typeof baseEntry !== "string") continue;
          if (typeof entry !== "string") {
            mismatches.push(`${path}: ${entry === null ? "null" : typeof entry} instead of a string`);
            continue;
          }
          const want = placeholdersOf(baseEntry).join(" ");
          const got = placeholdersOf(entry).join(" ");
          if (want !== got) mismatches.push(`${path}: placeholders "${got}" instead of "${want}"`);
          if (linksOf(baseEntry).join(" ") !== linksOf(entry).join(" ")) {
            mismatches.push(`${path}: linked messages differ from English`);
          }
          // Polish may add a third form (one | few | many) where English has two.
          const branches = pluralBranches(baseEntry);
          const allowed = branches === 2 && language === "pl" ? [2, 3] : [branches];
          if (!allowed.includes(pluralBranches(entry))) {
            mismatches.push(`${path}: ${pluralBranches(entry)} plural forms instead of ${allowed.join(" or ")}`);
          }
        }
      }
      expect({ language, mismatches }).toEqual({ language, mismatches: [] });
    }
  });

  it("never ships an empty translation value", () => {
    for (const language of SUPPORTED_UI_LANGUAGES) {
      const messages = LOCALE_MESSAGES[language] as Record<string, unknown>;
      const emptyKeys = flattenKeys(messages).filter((key) => {
        const parts = key.split(".");
        let node: unknown = messages;
        for (const part of parts) {
          node = (node as Record<string, unknown>)?.[part];
        }
        if (Array.isArray(node)) {
          return node.some((entry) => typeof entry !== "string" || entry.trim() === "");
        }
        return typeof node !== "string" || node.trim() === "";
      });
      expect({ language, emptyKeys }).toEqual({ language, emptyKeys: [] });
    }
  });
});

/**
 * French typography: a non-breaking space (U+00A0 or U+202F), never a plain one, before
 * : ; ? ! and » and after «. Code spans and URLs are skipped.
 */
function frenchSpacingViolations(value: unknown, path = ""): string[] {
  if (typeof value === "string") {
    const text = value.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "").replace(/https?:\/\/\S+/g, "");
    return / [:;?!»]|« /.test(text) ? [`${path}: ${value}`] : [];
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      frenchSpacingViolations(child, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/** The texts below every "fr" key, e.g. the localized store listing in haven-app.json. */
function frenchBranches(value: unknown, path = ""): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, child]) =>
      key === "fr" ? { [`${path}.fr`]: child } : frenchBranches(child, path ? `${path}.${key}` : key),
    ),
  );
}

describe("French typography", () => {
  it("uses a non-breaking space before : ; ? ! » and after «", () => {
    expect(frenchSpacingViolations(frMessages)).toEqual([]);
    expect(frenchSpacingViolations(frenchBranches(havenApp), "haven-app.json")).toEqual([]);
  });
});
