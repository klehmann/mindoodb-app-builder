import { describe, expect, it } from "vitest";

import {
  buildIdentityFiles,
  isValidSlug,
  patchAppDefinition,
  patchPackageJson,
  patchWranglerConfig,
  renderTaskMarkdown,
  slugifyAppName,
  workersDevUrl,
  type AppIdentity,
} from "@/core/appIdentity";

const identity: AppIdentity = {
  label: "Team Notes",
  slug: "team-notes",
  description: "Shared notes for the team.",
  task: "Let people write notes and search them.",
};

describe("slugifyAppName", () => {
  it("lowercases and dashes a display name", () => {
    expect(slugifyAppName("Team Notes")).toBe("team-notes");
  });

  it("strips accents instead of dropping the letter", () => {
    expect(slugifyAppName("Café Liste")).toBe("cafe-liste");
  });

  it("collapses runs of punctuation into one dash and trims the edges", () => {
    expect(slugifyAppName("  ++My __ App!!  ")).toBe("my-app");
  });

  it("falls back to a usable name when nothing survives", () => {
    expect(slugifyAppName("🙂🙂")).toBe("mindoodb-app");
  });

  it("stays within the Cloudflare Worker name limit and never ends in a dash", () => {
    const slug = slugifyAppName(`${"a".repeat(70)} tail`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
  });
});

describe("isValidSlug", () => {
  it.each(["a", "team-notes", "app2"])("accepts %s", (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each(["-lead", "trail-", "Upper", "has space", "under_score", "a".repeat(64)])(
    "rejects %s",
    (slug) => {
      expect(isValidSlug(slug)).toBe(false);
    },
  );
});

describe("workersDevUrl", () => {
  it("predicts the live URL before the Worker exists", () => {
    expect(workersDevUrl("team-notes", "acme")).toBe("https://team-notes.acme.workers.dev");
  });
});

describe("patchPackageJson", () => {
  const source = JSON.stringify(
    { name: "mindoodb-app-starter", version: "0.1.0", description: "Starter", private: true },
    null,
    2,
  );

  it("renames the package and keeps the other fields", () => {
    const parsed = JSON.parse(patchPackageJson(source, identity));
    expect(parsed.name).toBe("team-notes");
    expect(parsed.description).toBe("Shared notes for the team.");
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.private).toBe(true);
  });

  it("leaves the template description alone when the user gave none", () => {
    const parsed = JSON.parse(patchPackageJson(source, { ...identity, description: "" }));
    expect(parsed.description).toBe("Starter");
  });
});

describe("patchWranglerConfig", () => {
  const source = `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "mindoodb-app-starter",
  "assets": {
    "directory": "./dist",
    // Not "single-page-application": see public/404.html.
    "not_found_handling": "404-page"
  }
}
`;

  it("renames the Worker", () => {
    expect(patchWranglerConfig(source, identity)).toContain('"name": "team-notes"');
  });

  it("keeps the comments that explain the config", () => {
    const patched = patchWranglerConfig(source, identity);
    expect(patched).toContain('// Not "single-page-application": see public/404.html.');
    expect(patched).toContain('"not_found_handling": "404-page"');
  });

  it("renames only the Worker name, not a later name-like field", () => {
    const patched = patchWranglerConfig(source, identity);
    expect(patched).toContain('"$schema": "./node_modules/wrangler/config-schema.json"');
    expect(patched.match(/team-notes/g)).toHaveLength(1);
  });

  it("refuses a config without a name rather than silently doing nothing", () => {
    expect(() => patchWranglerConfig('{ "assets": {} }', identity)).toThrow(/name/);
  });
});

describe("patchAppDefinition", () => {
  const source = JSON.stringify(
    {
      format: "mindoodb.haven.app",
      formatVersion: 1,
      appId: "mindoodb-app-starter",
      label: "MindooDB App Starter",
      description: "A new MindooDB Haven application.",
      defaultLaunchDatabaseId: "main",
      databases: [{ logicalDatabaseId: "main", label: "Main", permissions: ["write"] }],
    },
    null,
    2,
  );

  it("stamps the app identity", () => {
    const parsed = JSON.parse(patchAppDefinition(source, identity));
    expect(parsed.appId).toBe("team-notes");
    expect(parsed.label).toBe("Team Notes");
    expect(parsed.description).toBe("Shared notes for the team.");
  });

  it("never touches the declared databases or permissions", () => {
    const parsed = JSON.parse(patchAppDefinition(source, identity));
    expect(parsed.databases).toEqual([
      { logicalDatabaseId: "main", label: "Main", permissions: ["write"] },
    ]);
    expect(parsed.defaultLaunchDatabaseId).toBe("main");
  });

  it("drops the template placeholder description when the user gave none", () => {
    const parsed = JSON.parse(patchAppDefinition(source, { ...identity, description: "" }));
    expect(parsed.description).toBeUndefined();
  });
});

describe("renderTaskMarkdown", () => {
  it("leads with the app label and carries the user's text", () => {
    const markdown = renderTaskMarkdown(identity);
    expect(markdown.startsWith("# Team Notes")).toBe(true);
    expect(markdown).toContain("Let people write notes and search them.");
    expect(markdown).toContain("Read `AGENTS.md` first");
  });

  it("says so explicitly when there is no description yet", () => {
    expect(renderTaskMarkdown({ ...identity, task: "   " })).toContain("_Not described yet._");
  });
});

describe("buildIdentityFiles", () => {
  it("returns exactly the four files that carry the app identity", () => {
    const files = buildIdentityFiles(
      {
        packageJson: '{\n  "name": "mindoodb-app-starter"\n}\n',
        wranglerConfig: '{\n  "name": "mindoodb-app-starter"\n}\n',
        appDefinition:
          '{\n  "format": "mindoodb.haven.app",\n  "formatVersion": 1,\n  "appId": "x",\n  "label": "X"\n}\n',
      },
      identity,
    );

    expect(files.map((file) => file.path)).toEqual([
      "package.json",
      "wrangler.jsonc",
      "public/haven-app.json",
      "TASK.md",
    ]);
    expect(files.every((file) => file.content.length > 0)).toBe(true);
  });
});
