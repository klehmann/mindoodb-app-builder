import { describe, expect, it, vi } from "vitest";

import {
  appDefinitionUrlFor,
  bytesAsText,
  copySourceFiles,
  parseGitHubRepository,
  parseSourceInput,
  resolveAppSource,
  sourceRepositoryFromDefinition,
  type AppSource,
  type ResolveSourceDependencies,
} from "@/core/appSource";
import { FlowNoteError, type FlowNote } from "@/core/flowNotes";
import type { GitHubRepository, GitHubTreeEntry } from "@/core/github";

const repository: GitHubRepository = {
  id: 1,
  name: "team-poll",
  fullName: "acme/team-poll",
  owner: "acme",
  ownerId: 2,
  htmlUrl: "https://github.com/acme/team-poll",
  defaultBranch: "main",
};

const definition = {
  format: "mindoodb.haven.app",
  formatVersion: 1,
  appId: "team-poll",
  label: "Team Poll",
  listing: { summary: { en: "Polls for teams.", de: "Umfragen für Teams." } },
  databases: [
    { logicalDatabaseId: "main", label: "Polls", permissions: ["write"] },
    { logicalDatabaseId: "archive", permissions: ["write"] },
  ],
};

function blob(path: string, size = 10): GitHubTreeEntry {
  return { path, mode: "100644", type: "blob", sha: `sha-${path}`, size };
}

const requiredFiles = [
  blob("package.json"),
  blob("wrangler.jsonc"),
  blob("public/haven-app.json"),
  blob("src/main.ts"),
];

function makeDeps(overrides: Partial<ResolveSourceDependencies> = {}): ResolveSourceDependencies {
  return {
    fetchAppDefinition: vi.fn(async () => ({
      ...definition,
      source: { repository: "https://github.com/acme/team-poll" },
    })),
    getRepositoryDetails: vi.fn(async () => ({
      repository,
      private: false,
      description: "From GitHub.",
    })),
    readTree: vi.fn(async () => ({
      commitSha: "abcdef1234567",
      entries: requiredFiles,
      truncated: false,
    })),
    readFile: vi.fn(async (_owner: string, _repo: string, path: string) =>
      path === "public/haven-app.json" ? JSON.stringify(definition) : null,
    ),
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<FlowNote> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FlowNoteError) {
      return error.note;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("parseGitHubRepository", () => {
  it.each([
    ["https://github.com/acme/team-poll", "acme", "team-poll"],
    ["https://github.com/acme/team-poll/", "acme", "team-poll"],
    ["https://github.com/acme/team-poll.git", "acme", "team-poll"],
    ["https://github.com/acme/team-poll/tree/main/src", "acme", "team-poll"],
    ["github.com/acme/team-poll", "acme", "team-poll"],
    ["git@github.com:acme/team-poll.git", "acme", "team-poll"],
    ["acme/team-poll", "acme", "team-poll"],
    ["  acme/team.poll  ", "acme", "team.poll"],
  ])("reads %s", (input, owner, repo) => {
    expect(parseGitHubRepository(input)).toEqual({ owner, repo });
  });

  it.each([
    "",
    "https://gitlab.com/acme/team-poll",
    "https://github.com/acme",
    "https://team-poll.acme.workers.dev",
    "example.com/app",
  ])("does not read %s as a repository", (input) => {
    expect(parseGitHubRepository(input)).toBeNull();
  });
});

describe("parseSourceInput", () => {
  it("tells a repository from an app address", () => {
    expect(parseSourceInput("acme/team-poll")).toEqual({
      kind: "github",
      owner: "acme",
      repo: "team-poll",
    });
    expect(parseSourceInput("https://team-poll.acme.workers.dev")).toEqual({
      kind: "app",
      url: "https://team-poll.acme.workers.dev/",
    });
    expect(parseSourceInput("team-poll.acme.workers.dev")).toEqual({
      kind: "app",
      url: "https://team-poll.acme.workers.dev/",
    });
  });

  it("refuses what is neither", () => {
    expect(parseSourceInput("")).toBeNull();
    expect(parseSourceInput("team poll")).toBeNull();
  });
});

describe("sourceRepositoryFromDefinition", () => {
  it("reads source.repository", () => {
    expect(
      sourceRepositoryFromDefinition({ source: { repository: "https://github.com/acme/team-poll" } }),
    ).toEqual({ owner: "acme", repo: "team-poll" });
  });

  it("ignores a definition without one, or with one that is not on GitHub", () => {
    expect(sourceRepositoryFromDefinition({})).toBeNull();
    expect(sourceRepositoryFromDefinition({ source: {} })).toBeNull();
    expect(sourceRepositoryFromDefinition({ source: { repository: "https://gitlab.com/a/b" } })).toBeNull();
    expect(sourceRepositoryFromDefinition(null)).toBeNull();
  });
});

describe("appDefinitionUrlFor", () => {
  it("finds haven-app.json next to the app, whether or not the URL already names it", () => {
    expect(appDefinitionUrlFor("https://team-poll.acme.workers.dev")).toBe(
      "https://team-poll.acme.workers.dev/haven-app.json",
    );
    expect(appDefinitionUrlFor("https://team-poll.acme.workers.dev/haven-app.json")).toBe(
      "https://team-poll.acme.workers.dev/haven-app.json",
    );
  });
});

describe("resolveAppSource", () => {
  it("reads a repository and prefills from its haven-app.json", async () => {
    const deps = makeDeps();
    const source = await resolveAppSource("https://github.com/acme/team-poll", deps);

    expect(deps.fetchAppDefinition).not.toHaveBeenCalled();
    expect(source).toMatchObject({
      fullName: "acme/team-poll",
      branch: "main",
      commitSha: "abcdef1234567",
      label: "Team Poll",
      description: "Polls for teams.",
      databases: [
        { logicalDatabaseId: "main", label: "Polls" },
        { logicalDatabaseId: "archive", label: "archive" },
      ],
      skippedPaths: [],
    });
    expect(source.files).toHaveLength(4);
  });

  it("follows an app address to the repository its definition names", async () => {
    const deps = makeDeps();
    const source = await resolveAppSource("https://team-poll.acme.workers.dev", deps);

    expect(deps.fetchAppDefinition).toHaveBeenCalledWith(
      "https://team-poll.acme.workers.dev/haven-app.json",
    );
    expect(deps.getRepositoryDetails).toHaveBeenCalledWith("acme", "team-poll");
    expect(source.fullName).toBe("acme/team-poll");
  });

  it("pins a resumed lookup to the commit the first attempt copied", async () => {
    const deps = makeDeps();
    await resolveAppSource("acme/team-poll", deps, { commitSha: "abcdef1234567" });
    expect(deps.readTree).toHaveBeenCalledWith("acme", "team-poll", "abcdef1234567");
  });

  it("says why an app address leads nowhere", async () => {
    await expect(
      refusal(
        resolveAppSource(
          "https://x.workers.dev",
          makeDeps({ fetchAppDefinition: vi.fn(async () => definition) }),
        ),
      ),
    ).resolves.toEqual({ code: "sourceAppNoRepository", params: { url: "https://x.workers.dev/haven-app.json" } });

    await expect(
      refusal(
        resolveAppSource(
          "https://x.workers.dev",
          makeDeps({
            fetchAppDefinition: vi.fn(async () => {
              throw new Error("offline");
            }),
          }),
        ),
      ),
    ).resolves.toMatchObject({ code: "sourceAppUnreachable" });
  });

  it("copies only public code", async () => {
    const deps = makeDeps({
      getRepositoryDetails: vi.fn(async () => ({ repository, private: true, description: "" })),
    });
    await expect(refusal(resolveAppSource("acme/team-poll", deps))).resolves.toEqual({
      code: "sourceRepoPrivate",
      params: { fullName: "acme/team-poll" },
    });
    expect(deps.readTree).not.toHaveBeenCalled();
  });

  it("refuses what it cannot copy faithfully", async () => {
    const withEntries = (entries: GitHubTreeEntry[], truncated = false) =>
      makeDeps({ readTree: vi.fn(async () => ({ commitSha: "c", entries, truncated })) });

    await expect(refusal(resolveAppSource("acme/team-poll", makeDeps({ getRepositoryDetails: vi.fn(async () => null) }))))
      .resolves.toMatchObject({ code: "sourceRepoNotFound" });
    await expect(refusal(resolveAppSource("acme/team-poll", withEntries(requiredFiles, true))))
      .resolves.toMatchObject({ code: "sourceTooLarge" });
    await expect(
      refusal(
        resolveAppSource(
          "acme/team-poll",
          withEntries([...requiredFiles, { path: "lib", mode: "160000", type: "commit", sha: "s" }]),
        ),
      ),
    ).resolves.toMatchObject({ code: "sourceHasSubmodules" });
    await expect(refusal(resolveAppSource("acme/team-poll", withEntries(requiredFiles.slice(1)))))
      .resolves.toEqual({ code: "sourceMissingFile", params: { fullName: "acme/team-poll", path: "package.json" } });
    await expect(
      refusal(resolveAppSource("acme/team-poll", withEntries([...requiredFiles, blob("big.bin", 60 * 1024 * 1024)]))),
    ).resolves.toMatchObject({ code: "sourceTooLarge" });
  });

  it("refuses a repository whose files live in Git LFS", async () => {
    const deps = makeDeps({
      readTree: vi.fn(async () => ({
        commitSha: "c",
        entries: [...requiredFiles, blob(".gitattributes")],
        truncated: false,
      })),
      readFile: vi.fn(async (_o: string, _r: string, path: string) =>
        path === ".gitattributes" ? "*.png filter=lfs diff=lfs merge=lfs -text\n" : JSON.stringify(definition),
      ),
    });
    await expect(refusal(resolveAppSource("acme/team-poll", deps))).resolves.toMatchObject({
      code: "sourceUsesLfs",
    });
  });

  it("refuses a haven-app.json that is not an app definition", async () => {
    const deps = makeDeps({ readFile: vi.fn(async () => '{"hello": "world"}') });
    await expect(refusal(resolveAppSource("acme/team-poll", deps))).resolves.toMatchObject({
      code: "sourceDefinitionInvalid",
    });
  });

  it("leaves GitHub workflows behind and says how many", async () => {
    const deps = makeDeps({
      readTree: vi.fn(async () => ({
        commitSha: "c",
        entries: [...requiredFiles, blob(".github/workflows/ci.yml"), blob(".github/CODEOWNERS")],
        truncated: false,
      })),
    });
    const source = await resolveAppSource("acme/team-poll", deps);
    expect(source.skippedPaths).toEqual([".github/workflows/ci.yml"]);
    expect(source.files.map((file) => file.path)).toContain(".github/CODEOWNERS");
    expect(source.files.map((file) => file.path)).not.toContain(".github/workflows/ci.yml");
  });

  it("falls back to GitHub's description when the definition has none", async () => {
    const bare = { ...definition, listing: undefined };
    const deps = makeDeps({ readFile: vi.fn(async () => JSON.stringify(bare)) });
    const source = await resolveAppSource("acme/team-poll", deps);
    expect(source.description).toBe("From GitHub.");
  });

  it("refuses input that is not a source at all", async () => {
    await expect(refusal(resolveAppSource("team poll", makeDeps()))).resolves.toEqual({
      code: "sourceInputInvalid",
    });
  });
});

describe("bytesAsText", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("keeps text as text, byte-order mark included", () => {
    expect(bytesAsText(encode("héllo\r\n"))).toBe("héllo\r\n");
    expect(bytesAsText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("﻿a");
  });

  it("calls anything else binary", () => {
    expect(bytesAsText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBeNull();
    expect(bytesAsText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});

describe("copySourceFiles", () => {
  const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  it("inlines text, uploads binaries, and writes one commit", async () => {
    const text = new TextEncoder().encode('{"name": "team-poll"}\n');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const source = {
      fullName: "acme/team-poll",
      commitSha: "abcdef1234567",
      files: [
        { path: "package.json", mode: "100644", type: "blob", sha: "t1" },
        { path: "public/icon.png", mode: "100644", type: "blob", sha: "b1" },
        { path: "bin/run", mode: "100755", type: "blob", sha: "t2" },
      ],
    } as AppSource;
    const blobs: Record<string, string> = {
      t1: toBase64(text),
      b1: toBase64(png),
      t2: toBase64(new TextEncoder().encode("#!/bin/sh\n")),
    };
    const createBlob = vi.fn(async () => "new-blob");
    const replaceBranch = vi.fn(async () => "new-commit");

    const copied = await copySourceFiles(source, {
      readBlob: async (sha) => blobs[sha]!,
      createBlob,
      replaceBranch,
      concurrency: 2,
    });

    expect(copied).toEqual({ fileCount: 3, commitSha: "new-commit" });
    expect(createBlob).toHaveBeenCalledTimes(1);
    expect(createBlob).toHaveBeenCalledWith(blobs.b1);
    expect(replaceBranch).toHaveBeenCalledWith(
      [
        { path: "package.json", mode: "100644", content: '{"name": "team-poll"}\n' },
        { path: "public/icon.png", mode: "100644", sha: "new-blob" },
        { path: "bin/run", mode: "100755", content: "#!/bin/sh\n" },
      ],
      "Copy of acme/team-poll at abcdef1",
    );
  });
});
