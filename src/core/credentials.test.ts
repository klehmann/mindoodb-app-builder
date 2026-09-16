import { describe, expect, it, vi } from "vitest";

import type { MindooDBAppDatabase } from "mindoodb-app-sdk";

import {
  clearCredentials,
  credentialsFromDocumentData,
  loadCredentials,
  readCredentialsStatus,
  saveCredentials,
  CREDENTIALS_DOCUMENT_TYPE,
  EMPTY_CREDENTIALS,
} from "./credentials";

/**
 * A database that actually stores what it is given and answers the `type` query from
 * what it stored, so the tests can follow the credentials from `save` back out of
 * `load` — the fixed-id shortcut that a stubbed database made look fine is exactly what
 * the host rejected.
 *
 * `query` mirrors the host in the one way that matters here: it filters on the stored
 * top-level fields, so a token nested under `secrets` is invisible to it just as it is
 * invisible to the real summary buffer.
 */
function fakeDatabase(
  overrides: {
    seed?: Record<string, Record<string, unknown>>;
    get?: (id: string) => Promise<{ id: string; data: Record<string, unknown> } | undefined>;
  } = {},
): {
  database: MindooDBAppDatabase;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
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
      if (!documents.has(id)) {
        documents.set(id, { ...(input.set ?? {}) });
      }
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
  // Newest first, matching the `_lastModified` sort the real query asks for.
  const query = vi.fn(async () => {
    const rows = [...order]
      .reverse()
      .filter((id) => documents.get(id)?.type === CREDENTIALS_DOCUMENT_TYPE)
      .map((id) => ({ docId: id, fields: { type: CREDENTIALS_DOCUMENT_TYPE } }));
    return { rows, total: rows.length, coverage: "full" };
  });

  return {
    database: { documents: { create, update, get, query } } as unknown as MindooDBAppDatabase,
    create,
    update,
    query,
  };
}

const filled = {
  githubToken: "ghp_token",
  githubOwner: "octocat",
  cloudflareToken: "cf_token",
  cloudflareRefreshToken: "cf_refresh",
  cloudflareExpiresAt: 0,
  cloudflareAccountId: "acct-1",
  cursorToken: "crsr_key",
};

describe("readCredentialsStatus", () => {
  it("treats Cloudflare as connected only once the account ID is there too", async () => {
    // A Cloudflare token without an account ID cannot address a single endpoint, so
    // reporting it as connected would let the user start a build that fails at step 3.
    expect(
      readCredentialsStatus({ ...EMPTY_CREDENTIALS, cloudflareToken: "cf_token" }),
    ).toMatchObject({ cloudflare: false });

    expect(readCredentialsStatus(filled)).toEqual({
      github: true,
      cloudflare: true,
      cursor: true,
    });
  });

  it("ignores whitespace, so a stray paste does not read as connected", () => {
    expect(readCredentialsStatus({ ...EMPTY_CREDENTIALS, githubToken: "   " })).toMatchObject({
      github: false,
    });
  });
});

describe("credentialsFromDocumentData", () => {
  it("keeps only the known fields and ignores the rest of the document", () => {
    expect(
      credentialsFromDocumentData({
        ...filled,
        type: CREDENTIALS_DOCUMENT_TYPE,
        updatedAt: "2026-09-16T00:00:00.000Z",
        somethingElse: { nested: true },
      }),
    ).toEqual(filled);
  });

  it("returns empty credentials for a missing document", () => {
    expect(credentialsFromDocumentData(undefined)).toEqual(EMPTY_CREDENTIALS);
  });

  it("ignores values that are not strings", () => {
    // The document is app-writable data, so a non-string here is possible and must not
    // reach a fetch call as `[object Object]` in an Authorization header.
    expect(
      credentialsFromDocumentData({ githubToken: { evil: true }, cursorToken: 42 }),
    ).toEqual(EMPTY_CREDENTIALS);
  });
});

describe("loadCredentials", () => {
  it("finds the document by type", async () => {
    const { database } = fakeDatabase({
      seed: { cred_1: { type: CREDENTIALS_DOCUMENT_TYPE, secrets: filled } },
    });

    await expect(loadCredentials(database)).resolves.toEqual({
      credentials: filled,
      documentId: "cred_1",
    });
  });

  it("still reads a document written with top-level tokens", async () => {
    // Tokens moved under `secrets` to keep them out of the summary buffer; a document
    // from before that must not read back as "not connected".
    const { database } = fakeDatabase({
      seed: { cred_1: { type: CREDENTIALS_DOCUMENT_TYPE, ...filled } },
    });

    await expect(loadCredentials(database)).resolves.toMatchObject({ credentials: filled });
  });

  it("reads nothing when no document matches", async () => {
    const { database } = fakeDatabase({ seed: { other: { type: "something.else" } } });

    await expect(loadCredentials(database)).resolves.toEqual({
      credentials: EMPTY_CREDENTIALS,
      documentId: null,
    });
  });

  it("reports empty rather than failing when the document cannot be read", async () => {
    // In a shared builder database another user's sealed copy is undecryptable here.
    // That is not an error the user can fix — they just store their own.
    const { database } = fakeDatabase({
      get: async () => {
        throw new Error("decryption failed");
      },
    });

    await expect(loadCredentials(database)).resolves.toEqual({
      credentials: EMPTY_CREDENTIALS,
      documentId: null,
    });
  });
});

describe("saveCredentials", () => {
  it("never seals a document under a caller-provided id", async () => {
    // MindooDB rejects `recipients` together with a caller id, because such an id is
    // convergent and sealing needs a per-document key. Asking for one is not a
    // degraded save, it throws — so the sealed create must always let the host pick.
    const { database, create } = fakeDatabase();

    await saveCredentials(database, filled);

    for (const [input] of create.mock.calls as [{ id?: string; recipients?: string[] }][]) {
      expect(input.recipients === undefined || input.id === undefined).toBe(true);
    }
  });

  it("seals the document to the current user and nobody else", async () => {
    // The whole security story rests on this call shape: an empty recipient list with
    // includeSelf means the host adds exactly the launching user. Any additional
    // recipient would be another person able to read live API tokens.
    const { database, create } = fakeDatabase();

    await saveCredentials(database, filled);

    expect(create.mock.calls[0]![0]).toMatchObject({
      idPrefix: "cred",
      recipients: [],
      recipientOptions: { includeSelf: true },
    });
  });

  it("keeps the tokens out of the summarized top level", async () => {
    // Top-level scalars are auto-included in MindooDB's summary buffer, so a token
    // stored there would be copied into a local index and into every query row. Only
    // `type` and `updatedAt` belong up there.
    const { database, create } = fakeDatabase();

    await saveCredentials(database, filled);

    const { set } = create.mock.calls[0]![0] as { set: Record<string, unknown> };
    expect(Object.keys(set).sort()).toEqual(["secrets", "type", "updatedAt"]);
    expect(set.secrets).toMatchObject({ githubToken: "ghp_token" });
  });

  it("comes back out of loadCredentials on the next launch", async () => {
    const { database } = fakeDatabase();

    const documentId = await saveCredentials(database, filled);

    await expect(loadCredentials(database)).resolves.toEqual({ credentials: filled, documentId });
  });

  it("updates the existing document instead of sealing a second one", async () => {
    const { database, create } = fakeDatabase();

    const documentId = await saveCredentials(database, filled);
    create.mockClear();
    await saveCredentials(database, { ...filled, githubOwner: "hubot" }, documentId);

    expect(create).not.toHaveBeenCalled();
    await expect(loadCredentials(database)).resolves.toMatchObject({
      credentials: { githubOwner: "hubot" },
      documentId,
    });
  });

  it("finds the existing document even without the id in hand", async () => {
    // A reload loses the in-memory id; re-sealing would leave the old tokens behind in
    // an orphaned document.
    const { database, create } = fakeDatabase();

    const documentId = await saveCredentials(database, filled);
    create.mockClear();

    await expect(saveCredentials(database, filled)).resolves.toBe(documentId);
    expect(create).not.toHaveBeenCalled();
  });

  it("trims what it stores", async () => {
    const { database } = fakeDatabase();

    await saveCredentials(database, { ...filled, githubToken: "  ghp_token  " });

    await expect(loadCredentials(database)).resolves.toMatchObject({
      credentials: { githubToken: "ghp_token" },
    });
  });
});

describe("clearCredentials", () => {
  it("overwrites every token instead of deleting the document", async () => {
    // Overwriting keeps the sealed document — and its recipient list — in place, so the
    // next save cannot accidentally create it with different recipients.
    const { database } = fakeDatabase();

    const documentId = await saveCredentials(database, filled);
    await clearCredentials(database, documentId);

    await expect(loadCredentials(database)).resolves.toEqual({
      credentials: EMPTY_CREDENTIALS,
      documentId,
    });
  });
});
