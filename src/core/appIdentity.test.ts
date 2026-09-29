import { describe, expect, it } from "vitest";

import {
  APP_DATABASE_ID_PREFIX,
  APP_DATABASE_PERMISSIONS,
  DEFAULT_APP_DATABASE_PERMISSIONS,
  MAX_DATABASE_ID_LENGTH,
  buildIdentityFiles,
  databaseIdFromSlug,
  isValidDatabaseId,
  isValidPublisherUrl,
  isValidSlug,
  patchAppDefinition,
  patchPackageJson,
  patchWranglerConfig,
  physicalDatabaseId,
  randomDatabaseSuffix,
  renderTaskMarkdown,
  resolveAppDatabase,
  stripJsonComments,
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

describe("databaseIdFromSlug", () => {
  it("prefixes the slug with app_", () => {
    expect(databaseIdFromSlug("team-notes")).toBe("app_team-notes");
    expect(isValidDatabaseId(databaseIdFromSlug("team-notes"))).toBe(true);
  });

  it("stays within the MindooDB new-database id limit when the slug is max length", () => {
    const slug = "a".repeat(63);
    const id = databaseIdFromSlug(slug);
    expect(id.startsWith(APP_DATABASE_ID_PREFIX)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(MAX_DATABASE_ID_LENGTH);
    expect(isValidDatabaseId(id)).toBe(true);
  });

  it("is empty when nothing usable survives", () => {
    expect(databaseIdFromSlug("...")).toBe("");
  });
});

describe("isValidDatabaseId", () => {
  it.each(["app_team-notes", "notes", "a", "test.db-1"])("accepts %s", (id) => {
    expect(isValidDatabaseId(id)).toBe(true);
  });

  it.each(["", "Main", "has space", "_leading", "trail.", "a".repeat(65)])(
    "rejects %s",
    (id) => {
      expect(isValidDatabaseId(id)).toBe(false);
    },
  );
});

describe("APP_DATABASE_PERMISSIONS", () => {
  it("lists every Haven mapping permission, with sign / timestamps / sealedchannel off by default", () => {
    expect(APP_DATABASE_PERMISSIONS).toEqual([
      "write",
      "delete",
      "history",
      "attachments",
      "views",
      "sign",
      "timestamps",
      "directory",
      "sealedchannel",
    ]);
    expect(DEFAULT_APP_DATABASE_PERMISSIONS).toEqual([
      "write",
      "delete",
      "history",
      "attachments",
      "views",
      "directory",
    ]);
  });
});

describe("resolveAppDatabase", () => {
  it("defaults the id from the slug and the label from the app name", () => {
    expect(resolveAppDatabase(identity)).toEqual({
      logicalId: "main",
      id: "app_team-notes",
      label: "Team Notes",
      permissions: [...DEFAULT_APP_DATABASE_PERMISSIONS],
    });
  });

  it("keeps an explicit id, label, and a narrowed permission set", () => {
    expect(
      resolveAppDatabase({
        ...identity,
        databaseId: "app_notes",
        databaseLabel: "Notes",
        databasePermissions: ["write", "delete"],
      }),
    ).toEqual({
      logicalId: "main",
      id: "app_notes",
      label: "Notes",
      permissions: ["write", "delete"],
    });
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

  it("replaces the template's listing summary and keeps its icon", () => {
    const withListing = JSON.stringify({
      ...JSON.parse(source),
      listing: { summary: { en: "A new MindooDB Haven application." }, icon: "appicon.svg" },
    });
    expect(JSON.parse(patchAppDefinition(withListing, identity)).listing).toEqual({
      summary: "Shared notes for the team.",
      icon: "appicon.svg",
    });
    expect(JSON.parse(patchAppDefinition(withListing, { ...identity, description: "" })).listing).toEqual({
      icon: "appicon.svg",
    });
  });

  it("writes the store description and publisher, replacing whatever the source listed", () => {
    const withListing = JSON.stringify({
      ...JSON.parse(source),
      listing: {
        description: "The original's text.",
        descriptionMarkdown: "The original's **text**.",
        publisher: { name: "Someone Else", url: "https://else.example" },
        icon: "appicon.svg",
      },
    });
    const patched = JSON.parse(
      patchAppDefinition(withListing, {
        ...identity,
        storeDescription: "  Notes **together**.\n\n- [Site](https://notes.example)  ",
        publisherName: " Mindoo GmbH ",
        publisherUrl: "https://mindoo.de",
      }),
    );
    expect(patched.listing).toEqual({
      summary: "Shared notes for the team.",
      descriptionMarkdown: "Notes **together**.\n\n- [Site](https://notes.example)",
      publisher: { name: "Mindoo GmbH", url: "https://mindoo.de" },
      icon: "appicon.svg",
    });

    const bare = JSON.parse(patchAppDefinition(withListing, { ...identity, description: "" }));
    expect(bare.listing).toEqual({ icon: "appicon.svg" });
  });

  it("creates a listing when the template had none, and keeps only an https publisher URL", () => {
    const patched = JSON.parse(
      patchAppDefinition(source, {
        ...identity,
        publisherName: "Mindoo",
        publisherUrl: "javascript:alert(1)",
      }),
    );
    expect(patched.listing).toEqual({
      summary: "Shared notes for the team.",
      publisher: { name: "Mindoo" },
    });
    expect(JSON.parse(patchAppDefinition(source, { ...identity, description: "" })).listing).toBeUndefined();
  });

  it("gives the app its own hosted database instead of the template's main store", () => {
    const parsed = JSON.parse(patchAppDefinition(source, identity));
    expect(parsed.hosting).toBe("hosted");
    // The code opens `main`; the physical id is what makes the store the app's own.
    expect(parsed.defaultLaunchDatabaseId).toBe("main");
    expect(parsed.databases).toEqual([
      {
        logicalDatabaseId: "main",
        label: "Team Notes",
        databaseId: "app_team-notes",
        permissions: [...DEFAULT_APP_DATABASE_PERMISSIONS],
      },
    ]);
  });

  it("drops the template placeholder description when the user gave none", () => {
    const parsed = JSON.parse(patchAppDefinition(source, { ...identity, description: "" }));
    expect(parsed.description).toBeUndefined();
  });
});

describe("isValidPublisherUrl", () => {
  it("accepts empty and https URLs only", () => {
    expect(isValidPublisherUrl("")).toBe(true);
    expect(isValidPublisherUrl(" https://mindoo.de ")).toBe(true);
    expect(isValidPublisherUrl("http://mindoo.de")).toBe(false);
    expect(isValidPublisherUrl("mindoo.de")).toBe(false);
    expect(isValidPublisherUrl("java\tscript:alert(1)")).toBe(false);
    expect(isValidPublisherUrl("https://mindoo.de/\nx")).toBe(false);
  });
});

describe("renderTaskMarkdown", () => {
  it("leads with the app label and carries the user's text", () => {
    const markdown = renderTaskMarkdown(identity);
    expect(markdown.startsWith("# Team Notes")).toBe(true);
    expect(markdown).toContain("Let people write notes and search them.");
    expect(markdown).toContain("Read `AGENTS.md` first");
    expect(markdown).toContain("logical id `main`");
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

describe("physical database ids", () => {
  it("adds the app's random part to the slug", () => {
    expect(physicalDatabaseId("team-notes", "k7f3q2")).toBe("app_team-notes_k7f3q2");
    expect(physicalDatabaseId("team-notes", "k7f3q2", "archive")).toBe(
      "app_team-notes_archive_k7f3q2",
    );
  });

  it("shortens the slug, never the random part, to stay a legal id", () => {
    const id = physicalDatabaseId("a".repeat(63), "k7f3q2", "archive");
    expect(id.length).toBeLessThanOrEqual(MAX_DATABASE_ID_LENGTH);
    expect(id.endsWith("_archive_k7f3q2")).toBe(true);
    expect(isValidDatabaseId(id)).toBe(true);
  });

  it("draws a lowercase suffix", () => {
    expect(randomDatabaseSuffix()).toMatch(/^[a-z0-9]{6}$/);
    expect(randomDatabaseSuffix()).not.toBe(randomDatabaseSuffix());
  });

  it("uses the suffix for a new app that has one, and app_<slug> for one from before", () => {
    expect(resolveAppDatabase({ ...identity, databaseSuffix: "k7f3q2" }).id).toBe(
      "app_team-notes_k7f3q2",
    );
    expect(resolveAppDatabase(identity).id).toBe("app_team-notes");
  });
});

describe("source.repository", () => {
  const template = JSON.stringify({
    format: "mindoodb.haven.app",
    formatVersion: 1,
    appId: "mindoodb-app-starter",
    label: "Starter",
  });

  it("names a public repository and leaves a private one out", () => {
    const url = "https://github.com/acme/team-notes";
    expect(JSON.parse(patchAppDefinition(template, { ...identity, sourceRepositoryUrl: url })).source)
      .toEqual({ repository: url });
    expect(JSON.parse(patchAppDefinition(template, identity)).source).toBeUndefined();
  });
});

describe("copies", () => {
  const copiedFrom = {
    fullName: "acme/team-poll",
    htmlUrl: "https://github.com/acme/team-poll",
    commitSha: "abcdef1234567",
    databases: [
      { logicalDatabaseId: "main", label: "Polls" },
      { logicalDatabaseId: "archive", label: "Archive" },
    ],
  };
  const copy: AppIdentity = {
    label: "Our Poll",
    slug: "our-poll",
    description: "Polls for us.",
    task: "Add a due date.",
    databaseSuffix: "k7f3q2",
    copiedFrom,
  };
  const original = JSON.stringify({
    format: "mindoodb.haven.app",
    formatVersion: 1,
    appId: "team-poll",
    label: "Team Poll",
    hosting: "external",
    defaultLaunchDatabaseId: "main",
    networkAllowlist: ["https://api.example.com"],
    source: { repository: "https://github.com/acme/team-poll" },
    databases: [
      { logicalDatabaseId: "main", label: "Polls", permissions: ["write"] },
      { logicalDatabaseId: "archive", label: "Archive", databaseId: "shared-archive", create: false },
    ],
  });

  it("keeps what the code relies on and gives every database a new physical id", () => {
    const parsed = JSON.parse(patchAppDefinition(original, copy));
    expect(parsed.appId).toBe("our-poll");
    expect(parsed.label).toBe("Our Poll");
    expect(parsed.hosting).toBe("external");
    expect(parsed.defaultLaunchDatabaseId).toBe("main");
    expect(parsed.networkAllowlist).toEqual(["https://api.example.com"]);
    expect(parsed.databases).toEqual([
      {
        logicalDatabaseId: "main",
        label: "Polls",
        permissions: ["write"],
        databaseId: "app_our-poll_main_k7f3q2",
      },
      {
        logicalDatabaseId: "archive",
        label: "Archive",
        databaseId: "app_our-poll_archive_k7f3q2",
        create: false,
      },
    ]);
  });

  it("drops the original's source.repository instead of pointing copies of the copy at it", () => {
    expect(JSON.parse(patchAppDefinition(original, copy)).source).toBeUndefined();
    expect(
      JSON.parse(
        patchAppDefinition(original, { ...copy, sourceRepositoryUrl: "https://github.com/me/our-poll" }),
      ).source,
    ).toEqual({ repository: "https://github.com/me/our-poll" });
  });

  it("uses the short id when the source has one database", () => {
    const single = { ...copy, copiedFrom: { ...copiedFrom, databases: [copiedFrom.databases[0]!] } };
    const parsed = JSON.parse(patchAppDefinition(original, single));
    expect(parsed.databases[0].databaseId).toBe("app_our-poll_k7f3q2");
  });

  it("removes the original's routes and account from wrangler.jsonc, and only for a copy", () => {
    const wrangler = `{
  // Deployed to the original's own domain.
  "name": "team-poll",
  "account_id": "abc",
  "routes": [{ "pattern": "poll.acme.com", "custom_domain": true }],
  "assets": { "directory": "./dist" },
}
`;
    const patched = JSON.parse(patchWranglerConfig(wrangler, copy));
    expect(patched).toEqual({ name: "our-poll", assets: { directory: "./dist" } });
    // A new app's file is only renamed, comments and all.
    expect(patchWranglerConfig(wrangler, { ...identity, slug: "team-notes" })).toContain(
      "// Deployed to the original's own domain.",
    );
  });

  it("renames a copy's plain wrangler.jsonc in place, comments kept", () => {
    const plain = '{\n  // keep me\n  "name": "team-poll"\n}\n';
    expect(patchWranglerConfig(plain, copy)).toBe('{\n  // keep me\n  "name": "our-poll"\n}\n');
  });

  it("briefs the agent to build on the copied code", () => {
    const markdown = renderTaskMarkdown(copy);
    expect(markdown).toContain("copy of [acme/team-poll](https://github.com/acme/team-poll)");
    expect(markdown).toContain("`abcdef1`");
    expect(markdown).toContain("## What should change");
    expect(markdown).toContain("Add a due date.");
    expect(markdown).toContain("`main`, `archive`");
  });
});

describe("stripJsonComments", () => {
  it("drops comments and trailing commas but not what looks like them inside strings", () => {
    const text = '{\n  // line\n  "url": "https://x/*y*/", /* block */ "a": [1, 2,],\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ url: "https://x/*y*/", a: [1, 2] });
  });
});
