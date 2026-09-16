import { describe, expect, it, vi } from "vitest";

import type { MindooDBAppDatabase } from "mindoodb-app-sdk";

import {
  clearCredentials,
  credentialsFromDocumentData,
  loadCredentials,
  readCredentialsStatus,
  saveCredentials,
  CREDENTIALS_DOCUMENT_ID,
  CREDENTIALS_DOCUMENT_TYPE,
  EMPTY_CREDENTIALS,
} from "./credentials";

function fakeDatabase(overrides: {
  get?: (id: string) => Promise<{ data: Record<string, unknown> } | undefined>;
} = {}): {
  database: MindooDBAppDatabase;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => undefined);
  const update = vi.fn(async () => undefined);
  const get = vi.fn(overrides.get ?? (async () => undefined));

  return {
    database: { documents: { create, update, get } } as unknown as MindooDBAppDatabase,
    create,
    update,
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
  it("reads the fixed document id", async () => {
    const { database } = fakeDatabase({
      get: async (id) => (id === CREDENTIALS_DOCUMENT_ID ? { data: filled } : undefined),
    });

    await expect(loadCredentials(database)).resolves.toEqual(filled);
  });

  it("reports empty rather than failing when the document cannot be read", async () => {
    // In a shared builder database another user's sealed copy is undecryptable here.
    // That is not an error the user can fix — they just store their own.
    const { database } = fakeDatabase({
      get: async () => {
        throw new Error("decryption failed");
      },
    });

    await expect(loadCredentials(database)).resolves.toEqual(EMPTY_CREDENTIALS);
  });
});

describe("saveCredentials", () => {
  it("seals the document to the current user and nobody else", async () => {
    // The whole security story rests on this call shape: an empty recipient list with
    // includeSelf means the host adds exactly the launching user. Any additional
    // recipient would be another person able to read live API tokens.
    const { database, create } = fakeDatabase();

    await saveCredentials(database, filled);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      id: CREDENTIALS_DOCUMENT_ID,
      recipients: [],
      recipientOptions: { includeSelf: true },
    });
  });

  it("updates after creating, because create does not touch an existing document", async () => {
    const { database, update } = fakeDatabase();

    await saveCredentials(database, filled);

    expect(update).toHaveBeenCalledTimes(1);
    const [id, change] = update.mock.calls[0]! as [string, { set: Record<string, unknown> }];
    expect(id).toBe(CREDENTIALS_DOCUMENT_ID);
    expect(change.set).toMatchObject({ ...filled, type: CREDENTIALS_DOCUMENT_TYPE });
  });

  it("trims what it stores", async () => {
    const { database, update } = fakeDatabase();

    await saveCredentials(database, { ...filled, githubToken: "  ghp_token  " });

    const change = update.mock.calls[0]![1] as { set: Record<string, unknown> };
    expect(change.set.githubToken).toBe("ghp_token");
  });
});

describe("clearCredentials", () => {
  it("overwrites every token instead of deleting the document", async () => {
    // Overwriting keeps the sealed document — and its recipient list — in place, so the
    // next save cannot accidentally create it with different recipients.
    const { database, update } = fakeDatabase();

    await clearCredentials(database);

    const change = update.mock.calls[0]![1] as { set: Record<string, unknown> };
    expect(change.set).toMatchObject({
      githubToken: "",
      githubOwner: "",
      cloudflareToken: "",
      cloudflareAccountId: "",
      cursorToken: "",
    });
  });
});
