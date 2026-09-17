import { describe, expect, it, vi } from "vitest";

import type { MindooDBAppDatabase } from "mindoodb-app-sdk";

import {
  APP_RECORD_DOCUMENT_TYPE,
  EMPTY_APP_RECORD,
  appDefinitionUrl,
  appRecordFromDocumentData,
  appRecordFromIdentity,
  applyFlowOutcome,
  appStage,
  deleteAppRecord,
  findAppRecordByAppId,
  listAppRecords,
  loadAppRecord,
  nextAppAction,
  repositoryFromRecord,
  saveAppRecord,
  workerDashboardUrl,
  workerFromRecord,
  type BuilderAppRecord,
} from "./appRecords";

const repository = {
  id: 42,
  name: "team-notes",
  fullName: "octocat/team-notes",
  owner: "octocat",
  ownerId: 7,
  htmlUrl: "https://github.com/octocat/team-notes",
  defaultBranch: "main",
};

const worker = {
  url: "https://team-notes.acme.workers.dev",
  scriptTag: "tag-1",
  reused: false,
};

/**
 * A database that stores what it is given and answers the `type` query from what it
 * stored, so a record can be followed from `save` back out of `list`.
 *
 * `query` filters on stored top-level fields only, mirroring the summary buffer: a
 * brief nested under `brief` is invisible to it exactly as it is invisible there.
 */
function fakeDatabase(
  overrides: {
    seed?: Record<string, Record<string, unknown>>;
    get?: (id: string) => Promise<{ id: string; data: Record<string, unknown> } | undefined>;
    query?: () => Promise<never>;
  } = {},
): {
  database: MindooDBAppDatabase;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  documents: Map<string, Record<string, unknown>>;
} {
  const documents = new Map<string, Record<string, unknown>>(
    Object.entries(overrides.seed ?? {}),
  );
  const order: string[] = [...documents.keys()];
  let generated = 0;

  function touch(id: string): void {
    const previous = order.indexOf(id);
    if (previous >= 0) {
      order.splice(previous, 1);
    }
    order.push(id);
  }

  const create = vi.fn(
    async (input: { id?: string; idPrefix?: string; set?: Record<string, unknown> }) => {
      const id = input.id ?? `${input.idPrefix ?? "doc"}_${(generated += 1)}`;
      documents.set(id, { ...(input.set ?? {}) });
      touch(id);
      return { id, data: documents.get(id)! };
    },
  );
  const update = vi.fn(async (id: string, patch: { set?: Record<string, unknown> }) => {
    const data = { ...(documents.get(id) ?? {}), ...(patch.set ?? {}) };
    documents.set(id, data);
    touch(id);
    return { id, data };
  });
  const get = vi.fn(
    overrides.get ??
      (async (id: string) => (documents.has(id) ? { id, data: documents.get(id)! } : undefined)),
  );
  const remove = vi.fn(async (id: string) => {
    documents.delete(id);
    const previous = order.indexOf(id);
    if (previous >= 0) {
      order.splice(previous, 1);
    }
    return { id };
  });
  const query = vi.fn(
    overrides.query ??
      (async () => {
        const rows = [...order]
          .reverse()
          .filter((id) => documents.get(id)?.type === APP_RECORD_DOCUMENT_TYPE)
          .map((id) => ({ docId: id, fields: { type: APP_RECORD_DOCUMENT_TYPE } }));
        return { rows, total: rows.length, coverage: "full" };
      }),
  );

  return {
    database: {
      documents: { create, update, get, query, delete: remove },
    } as unknown as MindooDBAppDatabase,
    create,
    update,
    remove,
    documents,
  };
}

function record(overrides: Partial<BuilderAppRecord> = {}): BuilderAppRecord {
  return {
    ...EMPTY_APP_RECORD,
    appId: "team-notes",
    label: "Team Notes",
    description: "Shared notes for the team",
    task: "Build a notes app with tags",
    createdAt: "2026-09-01T10:00:00.000Z",
    repoOwner: "octocat",
    repoName: "team-notes",
    repoUrl: "https://github.com/octocat/team-notes",
    repoBranch: "main",
    repoId: 42,
    repoOwnerId: 7,
    ...overrides,
  };
}

describe("appStage", () => {
  it("reports the furthest stage the record can prove", () => {
    expect(appStage(EMPTY_APP_RECORD)).toBe("planned");
    expect(appStage(record())).toBe("repository");
    expect(appStage(record({ workerUrl: "https://team-notes.acme.workers.dev" }))).toBe(
      "published",
    );
    expect(
      appStage(record({ workerUrl: "https://team-notes.acme.workers.dev", originReady: true })),
    ).toBe("live");
    expect(
      appStage(
        record({
          workerUrl: "https://team-notes.acme.workers.dev",
          originReady: true,
          havenInstanceId: "inst-1",
        }),
      ),
    ).toBe("installed");
  });
});

describe("appDefinitionUrl", () => {
  it("points at the file Haven installs from", () => {
    expect(appDefinitionUrl(record({ workerUrl: "https://team-notes.acme.workers.dev" }))).toBe(
      "https://team-notes.acme.workers.dev/haven-app.json",
    );
  });

  it("does not double the slash on a stored trailing one", () => {
    expect(appDefinitionUrl(record({ workerUrl: "https://team-notes.acme.workers.dev/" }))).toBe(
      "https://team-notes.acme.workers.dev/haven-app.json",
    );
  });

  it("is empty until the app has a URL, so the UI can hide the action", () => {
    expect(appDefinitionUrl(record())).toBe("");
  });
});

describe("workerDashboardUrl", () => {
  it("needs the account id, which only Cloudflare's UI path can be built from", () => {
    expect(workerDashboardUrl(record({ appId: "team-notes" }))).toBe("");
    expect(
      workerDashboardUrl(record({ appId: "team-notes", cloudflareAccountId: "acct-1" })),
    ).toBe("https://dash.cloudflare.com/acct-1/workers/services/view/team-notes/production");
  });
});

describe("appRecordFromDocumentData", () => {
  it("returns an empty record for a missing document", () => {
    expect(appRecordFromDocumentData(undefined)).toEqual(EMPTY_APP_RECORD);
  });

  it("keeps only the known fields and ignores the rest of the document", () => {
    const stored = {
      type: APP_RECORD_DOCUMENT_TYPE,
      appId: "team-notes",
      label: "Team Notes",
      brief: { task: "Build a notes app" },
      leftoverFromSomeOtherApp: { nested: true },
    };

    expect(appRecordFromDocumentData(stored)).toMatchObject({
      appId: "team-notes",
      label: "Team Notes",
      task: "Build a notes app",
    });
  });

  it("ignores values of the wrong type instead of passing them on", () => {
    // A team-shared database is app-writable, so a URL that is not a string is
    // possible — and must not reach an anchor href as "[object Object]".
    expect(
      appRecordFromDocumentData({
        workerUrl: { evil: true },
        repoId: "42",
        originReady: "yes",
      }),
    ).toMatchObject({ workerUrl: "", repoId: 0, originReady: false });
  });

  it("refuses a URL the UI must not link to", () => {
    // The list renders these as links, and in a shared database the document is written
    // by whoever can write to it. A `javascript:` URL is a valid string, so the type
    // check alone would pass it straight into an href.
    expect(
      appRecordFromDocumentData({
        workerUrl: "javascript:alert(1)",
        repoUrl: "data:text/html,<script>alert(1)</script>",
        cursorAgentUrl: "  java\tscript:alert(1)",
      }),
    ).toMatchObject({ workerUrl: "", repoUrl: "", cursorAgentUrl: "" });
  });

  it("keeps a normal https URL exactly as it was stored", () => {
    expect(
      appRecordFromDocumentData({ workerUrl: "https://team-notes.acme.workers.dev" }).workerUrl,
    ).toBe("https://team-notes.acme.workers.dev");
  });

  it("defaults an app with no stored visibility to private", () => {
    // Same asymmetry as the form's default: publishing an unfinished app's plan by
    // accident costs more than a checkbox.
    expect(appRecordFromDocumentData({ appId: "team-notes" }).private).toBe(true);
  });
});

describe("appRecordFromIdentity", () => {
  it("is usable before anything was created, so a dead token loses no typing", () => {
    const created = appRecordFromIdentity(
      { label: "Team Notes", slug: "team-notes", description: "Shared notes", task: "Do it" },
      { private: true },
    );

    expect(created).toMatchObject({
      appId: "team-notes",
      label: "Team Notes",
      description: "Shared notes",
      task: "Do it",
      private: true,
    });
    expect(appStage(created)).toBe("planned");
    expect(created.createdAt).not.toBe("");
  });
});

describe("applyFlowOutcome", () => {
  it("folds a phase's result into the record", () => {
    const next = applyFlowOutcome(EMPTY_APP_RECORD, {
      repository,
      worker,
      agent: { id: "bc-1", url: "https://cursor.com/agents/bc-1", runId: "run-1" },
      installedAppInstanceId: "inst-1",
      cloudflareAccountId: "acct-1",
      wiredForBuild: true,
      originReady: true,
    });

    expect(next).toMatchObject({
      repoOwner: "octocat",
      repoName: "team-notes",
      repoUrl: "https://github.com/octocat/team-notes",
      repoBranch: "main",
      repoId: 42,
      repoOwnerId: 7,
      workerUrl: "https://team-notes.acme.workers.dev",
      workerScriptTag: "tag-1",
      cursorAgentId: "bc-1",
      cursorAgentUrl: "https://cursor.com/agents/bc-1",
      havenInstanceId: "inst-1",
      cloudflareAccountId: "acct-1",
      wiredForBuild: true,
      originReady: true,
    });
  });

  it("never unlearns what an earlier phase found", () => {
    // A Cloudflare phase run on its own reports no repository. Blanking the stored one
    // would strip the record of the very thing a resume needs.
    const withRepo = applyFlowOutcome(EMPTY_APP_RECORD, { repository, wiredForBuild: true });

    const afterCloudflareOnly = applyFlowOutcome(withRepo, {
      repository: null,
      worker,
      wiredForBuild: false,
      originReady: false,
    });

    expect(afterCloudflareOnly).toMatchObject({
      repoUrl: "https://github.com/octocat/team-notes",
      workerUrl: "https://team-notes.acme.workers.dev",
      // Latched: the trigger does not stop existing because one phase did not look.
      wiredForBuild: true,
    });
  });

  it("keeps the app id and the brief the user typed", () => {
    const base = appRecordFromIdentity(
      { label: "Team Notes", slug: "team-notes", description: "Shared notes", task: "Do it" },
      { private: false },
    );

    expect(applyFlowOutcome(base, { repository })).toMatchObject({
      appId: "team-notes",
      task: "Do it",
      private: false,
    });
  });
});

describe("repositoryFromRecord", () => {
  it("round-trips through applyFlowOutcome, so a resume needs no GitHub call", () => {
    const stored = applyFlowOutcome(EMPTY_APP_RECORD, { repository });

    expect(repositoryFromRecord(stored)).toEqual(repository);
  });

  it("is null while there is no repository yet", () => {
    expect(repositoryFromRecord(EMPTY_APP_RECORD)).toBeNull();
  });

  it("falls back to main for a record with no branch written down", () => {
    const stored = applyFlowOutcome(EMPTY_APP_RECORD, { repository });

    expect(repositoryFromRecord({ ...stored, repoBranch: "" })?.defaultBranch).toBe("main");
  });
});

describe("workerFromRecord", () => {
  it("reports the Worker as existing, because on a resume it does", () => {
    const stored = applyFlowOutcome(EMPTY_APP_RECORD, { worker });

    expect(workerFromRecord(stored)).toEqual({
      url: "https://team-notes.acme.workers.dev",
      scriptTag: "tag-1",
      reused: true,
    });
  });

  it("needs the script tag, which is the only handle the Builds API takes", () => {
    const stored = applyFlowOutcome(EMPTY_APP_RECORD, { worker });

    expect(workerFromRecord({ ...stored, workerScriptTag: "" })).toBeNull();
  });
});

describe("nextAppAction", () => {
  it("resumes at the first thing the record cannot prove is done", () => {
    expect(nextAppAction(EMPTY_APP_RECORD)).toBe("create");

    const withRepo = applyFlowOutcome(EMPTY_APP_RECORD, { repository });
    expect(nextAppAction(withRepo)).toBe("publish");

    const withWorker = applyFlowOutcome(withRepo, { worker });
    expect(nextAppAction(withWorker)).toBe("build");

    const live = applyFlowOutcome(withWorker, { originReady: true });
    expect(nextAppAction(live)).toBe("install");

    const installed = applyFlowOutcome(live, { installedAppInstanceId: "inst-1" });
    expect(nextAppAction(installed)).toBe("iterate");
  });

  it("does not offer to create a repository that already exists", () => {
    // The failure mode this rules out: a run that died during the identity commit
    // resuming at "create" and colliding with its own repository.
    const halfCreated = applyFlowOutcome(
      appRecordFromIdentity(
        { label: "Team Notes", slug: "team-notes", description: "", task: "" },
        { private: true },
      ),
      { repository },
    );

    expect(nextAppAction(halfCreated)).toBe("publish");
  });
});

describe("saveAppRecord", () => {
  it("stores no secrets — the list is shared, the tokens are not", async () => {
    const { database, create } = fakeDatabase();

    await saveAppRecord(database, record());

    const { set } = create.mock.calls[0]![0] as { set: Record<string, unknown> };
    const serialized = JSON.stringify(set).toLowerCase();
    for (const forbidden of ["token", "secret", "apikey", "api_key"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("creates the document unsealed, so a shared database shows the team's apps", async () => {
    const { database, create } = fakeDatabase();

    await saveAppRecord(database, record());

    const input = create.mock.calls[0]![0] as { recipients?: string[]; idPrefix?: string };
    expect(input.recipients).toBeUndefined();
    expect(input.idPrefix).toBe("app");
  });

  it("keeps the long brief out of the summarized top level", async () => {
    // Top-level scalars are auto-indexed. Names and URLs belong there — the list reads
    // them — but a multi-paragraph prompt would be copied in for nothing.
    const { database, create } = fakeDatabase();

    await saveAppRecord(database, record());

    const { set } = create.mock.calls[0]![0] as { set: Record<string, unknown> };
    expect(set.task).toBeUndefined();
    expect(set.brief).toEqual({ task: "Build a notes app with tags" });
  });

  it("comes back out of listAppRecords on the next launch", async () => {
    const { database } = fakeDatabase();

    const documentId = await saveAppRecord(database, record());

    const stored = await listAppRecords(database);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.documentId).toBe(documentId);
    expect(stored[0]!.record).toMatchObject({
      appId: "team-notes",
      label: "Team Notes",
      task: "Build a notes app with tags",
      repoUrl: "https://github.com/octocat/team-notes",
      repoId: 42,
    });
  });

  it("updates the app's own document instead of adding a second one", async () => {
    // This is what makes the flow able to save after every phase: the Cloudflare phase
    // writes its fields into the document the GitHub phase created.
    const { database, create } = fakeDatabase();

    const documentId = await saveAppRecord(database, record());
    create.mockClear();
    await saveAppRecord(
      database,
      record({ workerUrl: "https://team-notes.acme.workers.dev", workerScriptTag: "tag-1" }),
      documentId,
    );

    expect(create).not.toHaveBeenCalled();
    const stored = await listAppRecords(database);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.record).toMatchObject({
      workerUrl: "https://team-notes.acme.workers.dev",
      workerScriptTag: "tag-1",
    });
  });

  it("finds the app's document by id even without the document id in hand", async () => {
    // A reload loses the in-memory id. Creating a second document would split one app's
    // history in two and show it twice in the list.
    const { database, create } = fakeDatabase();

    const documentId = await saveAppRecord(database, record());
    create.mockClear();

    await expect(saveAppRecord(database, record({ label: "Team Notes v2" }))).resolves.toBe(
      documentId,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the original creation time and moves only updatedAt", async () => {
    const { database, documents } = fakeDatabase();

    const documentId = await saveAppRecord(database, record());
    const first = { ...documents.get(documentId)! };
    await saveAppRecord(database, record({ originReady: true }), documentId);
    const second = documents.get(documentId)!;

    expect(second.createdAt).toBe(first.createdAt);
    expect(String(second.updatedAt) >= String(first.updatedAt)).toBe(true);
  });

  it("stamps createdAt itself for a record that has none yet", async () => {
    const { database } = fakeDatabase();

    await saveAppRecord(database, record({ createdAt: "" }));

    const [stored] = await listAppRecords(database);
    expect(stored!.record.createdAt).not.toBe("");
  });
});

describe("listAppRecords", () => {
  it("shows the newest app first and ignores other documents", async () => {
    const { database } = fakeDatabase({
      seed: { cred_1: { type: "mindoodb.appbuilder.credentials" } },
    });

    await saveAppRecord(database, record({ appId: "older", createdAt: "2026-01-01T00:00:00Z" }));
    await saveAppRecord(database, record({ appId: "newer", createdAt: "2026-06-01T00:00:00Z" }));

    expect((await listAppRecords(database)).map((entry) => entry.record.appId)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("opens with an empty list rather than failing when the query cannot run", async () => {
    // No `read` capability, or a summary still backfilling. Either way the builder has
    // to open — the user can still create an app.
    const { database } = fakeDatabase({
      query: async () => {
        throw new Error("read capability missing");
      },
    });

    await expect(listAppRecords(database)).resolves.toEqual([]);
  });

  it("skips a document it cannot read instead of dropping the whole list", async () => {
    const { database } = fakeDatabase({
      seed: {
        app_1: { type: APP_RECORD_DOCUMENT_TYPE, appId: "readable" },
        app_2: { type: APP_RECORD_DOCUMENT_TYPE, appId: "broken" },
      },
      get: async (id: string) => {
        if (id === "app_2") {
          throw new Error("unreadable");
        }
        return { id, data: { type: APP_RECORD_DOCUMENT_TYPE, appId: "readable" } };
      },
    });

    const stored = await listAppRecords(database);
    expect(stored.map((entry) => entry.record.appId)).toEqual(["readable"]);
  });
});

describe("findAppRecordByAppId", () => {
  it("matches on the app id and ignores a blank one", async () => {
    const { database } = fakeDatabase();
    const documentId = await saveAppRecord(database, record());

    await expect(findAppRecordByAppId(database, "team-notes")).resolves.toMatchObject({
      documentId,
    });
    await expect(findAppRecordByAppId(database, "  ")).resolves.toBeNull();
    await expect(findAppRecordByAppId(database, "nothing")).resolves.toBeNull();
  });
});

describe("loadAppRecord", () => {
  it("reads one record back for a resumed run", async () => {
    const { database } = fakeDatabase();
    const documentId = await saveAppRecord(database, record());

    await expect(loadAppRecord(database, documentId)).resolves.toMatchObject({
      appId: "team-notes",
      task: "Build a notes app with tags",
    });
  });

  it("answers null for a document that is gone", async () => {
    const { database } = fakeDatabase();

    await expect(loadAppRecord(database, "app_missing")).resolves.toBeNull();
  });
});

describe("deleteAppRecord", () => {
  it("removes the note about the app", async () => {
    const { database } = fakeDatabase();
    const documentId = await saveAppRecord(database, record());

    await deleteAppRecord(database, documentId);

    await expect(listAppRecords(database)).resolves.toEqual([]);
  });
});
