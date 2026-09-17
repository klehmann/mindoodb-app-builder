import { describe, expect, it, vi } from "vitest";

import { saveAppDefinition } from "./saveDefinition";

function deps(overrides: Parameters<typeof saveAppDefinition>[2] = {}) {
  const triggerDownload = vi.fn();
  const openInTab = vi.fn();
  const revokeObjectUrl = vi.fn();
  return {
    triggerDownload,
    openInTab,
    revokeObjectUrl,
    dependencies: {
      createObjectUrl: () => "blob:definition",
      revokeObjectUrl,
      triggerDownload,
      openInTab,
      ...overrides,
    },
  };
}

describe("saveAppDefinition", () => {
  it("saves the fetched definition under the given filename", async () => {
    const { triggerDownload, revokeObjectUrl, dependencies } = deps({
      fetchImpl: (async () => new Response('{"appId":"team-notes"}')) as unknown as typeof fetch,
    });

    await expect(
      saveAppDefinition("https://team-notes.acme.workers.dev/haven-app.json", "team-notes.json", dependencies),
    ).resolves.toBe("saved");

    expect(triggerDownload).toHaveBeenCalledWith("blob:definition", "team-notes.json");
    // The object URL is a document-lifetime leak until it is revoked.
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:definition");
  });

  it("opens the file instead when the app's origin refuses to be read", async () => {
    // An app need not allow this page to fetch it. Opening the tab still gets the user
    // to the file, which beats an error they cannot act on.
    const { triggerDownload, openInTab, dependencies } = deps({
      fetchImpl: (async () => {
        throw new TypeError("blocked by CORS");
      }) as unknown as typeof fetch,
    });

    await expect(
      saveAppDefinition("https://team-notes.acme.workers.dev/haven-app.json", "team-notes.json", dependencies),
    ).resolves.toBe("opened");

    expect(triggerDownload).not.toHaveBeenCalled();
    expect(openInTab).toHaveBeenCalledWith("https://team-notes.acme.workers.dev/haven-app.json");
  });

  it("falls back to the tab for an error status too", async () => {
    const { openInTab, dependencies } = deps({
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });

    await expect(
      saveAppDefinition("https://team-notes.acme.workers.dev/haven-app.json", "x.json", dependencies),
    ).resolves.toBe("opened");
    expect(openInTab).toHaveBeenCalled();
  });

  it("refuses a URL that is not http(s), rather than opening it", async () => {
    // This function is the one that calls `window.open`, so it checks its own input
    // instead of trusting that the record it came from was validated.
    const { openInTab, dependencies } = deps();

    await expect(saveAppDefinition("javascript:alert(1)", "x.json", dependencies)).rejects.toThrow(
      /no web address/,
    );
    await expect(saveAppDefinition("", "x.json", dependencies)).rejects.toThrow(/no web address/);
    expect(openInTab).not.toHaveBeenCalled();
  });
});
