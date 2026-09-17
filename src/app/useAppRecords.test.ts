import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import { useAppRecords } from "@/app/useAppRecords";
import type { useBuilderSession } from "@/app/useBuilderSession";
import { APP_RECORD_DOCUMENT_TYPE, listAppRecords } from "@/core/appRecords";
import type { MindooDBAppDatabase } from "mindoodb-app-sdk";

/**
 * The builder's memory, from the outside: does a run leave something behind that the list
 * can offer to continue?
 *
 * The database fake stores what it is given, so a phase written here is a row read back
 * by `listAppRecords` — the same path the real launch takes.
 */
function fakeDatabase(): { database: MindooDBAppDatabase; removed: string[] } {
  const documents = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const removed: string[] = [];
  let generated = 0;

  return {
    removed,
    database: {
      documents: {
        create: vi.fn(async (input: { idPrefix?: string; set?: Record<string, unknown> }) => {
          const id = `${input.idPrefix ?? "doc"}_${(generated += 1)}`;
          documents.set(id, { ...(input.set ?? {}) });
          order.push(id);
          return { id, data: documents.get(id)! };
        }),
        update: vi.fn(async (id: string, patch: { set?: Record<string, unknown> }) => {
          const data = { ...(documents.get(id) ?? {}), ...(patch.set ?? {}) };
          documents.set(id, data);
          return { id, data };
        }),
        get: vi.fn(async (id: string) =>
          documents.has(id) ? { id, data: documents.get(id)! } : undefined,
        ),
        delete: vi.fn(async (id: string) => {
          documents.delete(id);
          removed.push(id);
          return { id };
        }),
        query: vi.fn(async () => {
          const rows = order
            .filter((id) => documents.get(id)?.type === APP_RECORD_DOCUMENT_TYPE)
            .map((id) => ({ docId: id, fields: { type: APP_RECORD_DOCUMENT_TYPE } }));
          return { rows, total: rows.length, coverage: "full" };
        }),
      },
    } as unknown as MindooDBAppDatabase,
  };
}

function fakeSession(
  database: MindooDBAppDatabase | null,
  capabilities: string[] = ["read", "create", "update", "delete"],
) {
  return {
    database: ref(database),
    databaseInfo: ref(database ? { id: "appbuilder", capabilities } : null),
  } as unknown as ReturnType<typeof useBuilderSession>;
}

const identity = {
  label: "Team Notes",
  slug: "team-notes",
  description: "Shared notes",
  task: "Let people write notes",
};

const repository = {
  id: 42,
  name: "team-notes",
  fullName: "octocat/team-notes",
  owner: "octocat",
  ownerId: 7,
  htmlUrl: "https://github.com/octocat/team-notes",
  defaultBranch: "main",
};

describe("useAppRecords", () => {
  it("shows a new app in the list before anything has been built", async () => {
    const { database } = fakeDatabase();
    const records = useAppRecords(fakeSession(database));

    await records.begin(identity, { private: true });

    expect(records.records.value).toHaveLength(1);
    expect(records.records.value[0]!.record).toMatchObject({
      appId: "team-notes",
      label: "Team Notes",
      task: "Let people write notes",
    });
  });

  it("accumulates phases into one document instead of one per phase", async () => {
    const { database } = fakeDatabase();
    const records = useAppRecords(fakeSession(database));

    await records.begin(identity, { private: true });
    await records.recordPhase({ repository });
    await records.recordPhase({
      worker: { url: "https://team-notes.acme.workers.dev", scriptTag: "tag-1", reused: false },
      wiredForBuild: true,
      originReady: true,
    });

    const stored = await listAppRecords(database);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.record).toMatchObject({
      repoUrl: "https://github.com/octocat/team-notes",
      workerUrl: "https://team-notes.acme.workers.dev",
      wiredForBuild: true,
      originReady: true,
      // Still the name and brief the user typed at the start.
      label: "Team Notes",
      task: "Let people write notes",
    });
  });

  it("ignores a phase with no app open, rather than throwing inside a run", async () => {
    const { database } = fakeDatabase();
    const records = useAppRecords(fakeSession(database));

    await expect(records.recordPhase({ repository })).resolves.toBeUndefined();
    expect(records.records.value).toHaveLength(0);
  });

  it("builds apps without remembering them when the database is read-only", async () => {
    // No `create` capability. The run must still work; the user just gets no history.
    const { database } = fakeDatabase();
    const records = useAppRecords(fakeSession(database, ["read"]));

    await records.begin(identity, { private: true });
    await records.recordPhase({ repository });

    expect(records.canStore.value).toBe(false);
    expect(records.records.value).toHaveLength(0);
  });

  it("survives having no database at all", async () => {
    const records = useAppRecords(fakeSession(null));

    await records.refresh();
    await records.begin(identity, { private: true });

    expect(records.records.value).toEqual([]);
  });

  it("continues an app from the list", async () => {
    const { database } = fakeDatabase();
    const records = useAppRecords(fakeSession(database));
    await records.begin(identity, { private: true });
    const stored = records.records.value[0]!;
    records.clearActive();

    records.resume(stored);
    await records.recordPhase({ repository });

    expect(records.activeDocumentId.value).toBe(stored.documentId);
    expect((await listAppRecords(database))).toHaveLength(1);
  });

  it("forgets an app and closes it if it was open", async () => {
    const { database, removed } = fakeDatabase();
    const records = useAppRecords(fakeSession(database));
    await records.begin(identity, { private: true });
    const documentId = records.activeDocumentId.value!;

    await records.forget(documentId);

    expect(removed).toEqual([documentId]);
    expect(records.active.value).toBeNull();
    expect(records.records.value).toEqual([]);
  });

  it("does not offer forgetting without the delete capability", async () => {
    const { database, removed } = fakeDatabase();
    const records = useAppRecords(fakeSession(database, ["read", "create", "update"]));
    await records.begin(identity, { private: true });

    await records.forget(records.activeDocumentId.value!);

    expect(records.canForget.value).toBe(false);
    expect(removed).toEqual([]);
  });
});
